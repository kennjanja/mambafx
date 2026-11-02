import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateEvidenceFamilies, detectTradingRanges, evaluateEntryModels, evaluateLayers, transitionLifecycle, WATCHING_EXPIRY_SEC, MODEL_REGISTRY } from '../../src/analysis/tradeSignalArchitecture.js';

const seq = (types, dir = 1, context = null) => types.map((type, i) => ({ type, dir, index: i, confirmedIndex: i, level: 100, label: type, ...(context ? { context } : {}) }));
const locations = [{ dir: 1, top: 110, bottom: 90 }];
function fixtureEvents(id, types, dir = 1, context = null) {
  const events = seq(types, dir, context);
  if (id === 'A') events[0].classification = 'significant-liquidity';
  if (id === 'F') events[0] = { ...events[0], confirmedIndex: 2, state: 'confirmed', classification: 'minor-inducement-liquidity', level: 99,
    sequenceEvents: [{ type: 'minor-pivot-confirmed', dir, index: 0, confirmedIndex: 0 }, { type: 'minor-inducement-sweep', dir, index: 1, confirmedIndex: 1, classification: 'minor-inducement-liquidity' }, { type: 'inducement-displacement', dir, index: 2, confirmedIndex: 2 }] };
  return events;
}
const modelCases = [
  ['A', ['significant-sweep', 'displacement', 'structure-shift'], { biasDirection: 1, entryDirection: 1 }],
  ['B', ['displacement', 'bos', 'ob-retest', 'reaction'], { biasDirection: 1, entryDirection: 1 }],
  ['C', ['displacement', 'fvg-created', 'fvg-retest', 'reaction'], { biasDirection: 1, entryDirection: 1 }],
  ['D', ['ob-confirmed-for-breaker', 'ob-break', 'opposite-structure', 'breaker-retest', 'reaction'], { biasDirection: -1, entryDirection: -1 }],
  ['F', ['inducement-confirmed'], { biasDirection: 1, entryDirection: 1 }],
  ['G', ['bos', 'displacement', 'broken-level-retest', 'reaction'], { biasDirection: 1, entryDirection: 1 }],
  ['J', ['range-established', 'sos-or-sow', 'lps-or-lpsy'], { biasDirection: 1, entryDirection: 1 }],
];

test('every registered model documents its exact bias, location and entry sequence gates', () => {
  assert.deepEqual(MODEL_REGISTRY.map((model) => model.model_id).sort(), ['A', 'B', 'C', 'D', 'F', 'G', 'J']);
  for (const model of MODEL_REGISTRY) {
    assert.match(model.layer1, /bias|structure/i, `${model.model_id} layer 1`);
    assert.match(model.layer2, /location|zone/i, `${model.model_id} layer 2`);
    assert.match(model.layer3, /confirmed|->/i, `${model.model_id} layer 3`);
  }
});

test('evidence groups aggregate once per family using strongest bull and bear', () => {
  const result = aggregateEvidenceFamilies([
    { group: 'structure', dir: 1, weight: 1.5, label: 'swing' }, { group: 'break', dir: 1, weight: 3, label: 'BOS' },
    { group: 'trend', dir: -1, weight: 1.5, label: 'countertrend' }, { group: 'liquidity', dir: 1, weight: 1, label: 'sweep' },
  ]);
  const structure = result.families.find((f) => f.family === 'structure');
  assert.equal(structure.bull, 3); assert.equal(structure.bear, 0); assert.equal(structure.value, 3);
  const momentum = result.families.find((f) => f.family === 'momentum');
  assert.equal(momentum.value, -1.5);
  assert.ok(result.balance > 0);
});

test('each model accepts its complete ordered sequence and rejects a missing event', () => {
  for (const [id, types, directions] of modelCases) {
    const events = fixtureEvents(id, types, id === 'D' ? -1 : 1);
    const location = id === 'F' ? [{ dir: 1, top: 100, bottom: 98 }] : [{ dir: id === 'D' ? -1 : 1, top: 110, bottom: 90 }];
    const context = id === 'J' ? 'range' : 'trend';
    const output = evaluateEntryModels({ events, locations: location, marketContext: context, ...directions });
    assert.equal(output.primary?.model_id, id, `${id} must fire`);
    const incomplete = evaluateEntryModels({ events: events.slice(1), locations: location, marketContext: context, ...directions });
    assert.equal(incomplete.candidates.some((c) => c.model_id === id), false, `${id} must reject incomplete sequence`);
  }
});

test('A reversal and F continuation remain distinct, as do B and G', () => {
  const A = evaluateEntryModels({ events: fixtureEvents('A', ['significant-sweep', 'displacement', 'structure-shift']), locations, biasDirection: 1 }).primary;
  const F = evaluateEntryModels({ events: fixtureEvents('F', ['inducement-confirmed']), locations: [{ dir: 1, top: 100, bottom: 98 }], biasDirection: 1, entryDirection: 1 }).primary;
  assert.equal(A.model_id, 'A'); assert.equal(A.classification, 'reversal');
  assert.equal(F.model_id, 'F'); assert.equal(F.classification, 'continuation');
  const B = evaluateEntryModels({ events: seq(['displacement', 'bos', 'ob-retest', 'reaction']), locations, biasDirection: 1, entryDirection: 1 }).primary;
  const G = evaluateEntryModels({ events: seq(['bos', 'displacement', 'broken-level-retest', 'reaction']), locations, biasDirection: 1, entryDirection: 1 }).primary;
  assert.equal(B.model_id, 'B'); assert.equal(G.model_id, 'G');
});

test('model direction rules, deterministic tie-breaking, and secondary models', () => {
  assert.equal(evaluateEntryModels({ events: fixtureEvents('A', ['significant-sweep', 'displacement', 'structure-shift']), locations, biasDirection: -1 }).primary, null);
  const events = [...seq(['displacement', 'bos', 'ob-retest', 'reaction']), ...seq(['bos', 'displacement', 'broken-level-retest', 'reaction'])];
  const result = evaluateEntryModels({ events, locations, biasDirection: 1, entryDirection: 1, nearestInvalidationDistance: 1 });
  assert.equal(result.primary.model_id, 'B');
  assert.deepEqual(result.candidates.map((c) => c.model_id), ['B', 'G']);
  const tie = evaluateEntryModels({ events: [...seq(['bos', 'displacement', 'broken-level-retest', 'reaction']), ...seq(['displacement', 'bos', 'ob-retest', 'reaction'])], locations, biasDirection: 1, entryDirection: 1 });
  assert.deepEqual(tie.candidates.map((c) => c.model_id), ['B', 'G']);
});

test('layers are independent and location alone can never create a signal', () => {
  const bias = { sufficient: true, verdict: 'bullish-lean', items: [{ group: 'structure' }] };
  const noLocation = evaluateLayers({ bias, entry: {}, locationEvidence: [], models: [{}] });
  assert.equal(noLocation.signal, false); assert.equal(noLocation.missingLayer, 'Location Gate');
  const noModel = evaluateLayers({ bias, entry: {}, locationEvidence: [{ dir: 1 }], models: [] });
  assert.equal(noModel.signal, false); assert.equal(noModel.missingLayer, 'Entry Confirmation');
  const ready = evaluateLayers({ bias, entry: {}, locationEvidence: [{ dir: 1 }], models: [{}] });
  assert.equal(ready.signal, true);
  const opposedModel = evaluateLayers({ bias, entry: {}, locationEvidence: [{ dir: 1 }], models: [{ direction: -1 }] });
  assert.equal(opposedModel.signal, false);
  assert.equal(opposedModel.missingLayer, 'Entry Confirmation');
});

test('lifecycle records transitions and per-profile watching expiries', () => {
  const r = { state: 'No Setup' };
  transitionLifecycle(r, 'Bias Identified', 10, 'bullish structure');
  transitionLifecycle(r, 'Watching', 11, 'awaiting location');
  transitionLifecycle(r, 'Approaching Location', 12, 'near support');
  transitionLifecycle(r, 'Trigger Detected', 13, 'model event sequence');
  transitionLifecycle(r, 'Signal Active', 14, 'all layers agree');
  transitionLifecycle(r, 'Closed', 15, 'period ended');
  assert.deepEqual(r.lifecycleHistory.map((e) => e.at), [10, 11, 12, 13, 14, 15]);
  assert.equal(r.state, 'Closed');
  assert.deepEqual(WATCHING_EXPIRY_SEC, { scalp: 900, intraday: 7200, swing: 21600 });
  assert.throws(() => transitionLifecycle(r, 'Watching', 15), /invalid lifecycle/);
});

test('range and model evidence at a prefix does not include future bars', () => {
  const candles = Array.from({ length: 40 }, (_, i) => ({ epoch: i * 60, open: 100, high: 101, low: 99, close: 100 }));
  const atr = Array(40).fill(1);
  const prefix = detectTradingRanges(candles.slice(0, 30), { lookback: 10, atr });
  const fullAtT = detectTradingRanges(candles.slice(0, 30), { lookback: 10, atr: atr.slice(0, 30) });
  assert.deepEqual(prefix, fullAtT);
});


test('model selection is as-of and ignores future confirmation events', () => {
  const history = seq(['displacement', 'bos', 'broken-level-retest', 'reaction']);
  const future = { type: 'ob-retest', dir: 1, index: 12, confirmedIndex: 12 };
  const asOf = evaluateEntryModels({ events: [...history, future], locations, biasDirection: 1, entryDirection: 1, asOfIndex: 3 });
  const truncated = evaluateEntryModels({ events: history, locations, biasDirection: 1, entryDirection: 1, asOfIndex: 3 });
  assert.deepEqual(asOf, truncated);
});


test('range boundaries freeze and detect SOS followed by LPS at their confirmation bars', () => {
  const candles = Array.from({ length: 5 }, (_, i) => ({ epoch: i * 60, open: 100, high: 101, low: 99, close: 100 }));
  candles.push({ epoch: 300, open: 100, high: 103, low: 99.8, close: 103 });
  candles.push({ epoch: 360, open: 102, high: 103, low: 100.9, close: 102.2 });
  const result = detectTradingRanges(candles, { lookback: 5, atr: Array(7).fill(1) });
  assert.ok(result.events.some((event) => event.type === 'SOS' && event.confirmedIndex === 5));
  assert.ok(result.events.some((event) => event.type === 'LPS' && event.confirmedIndex === 6));
  const fixed = result.events.find((event) => event.type === 'range-established').range;
  assert.equal(fixed.high, 101); assert.equal(fixed.low, 99);
  assert.equal(result.ranges[0].status, 'active', 'future breakout must not mutate the frozen range snapshot');
});


test('Wyckoff J sequence accepts nondirectional range context then bullish SOS/LPS', () => {
  const events = [
    { type: 'range-established', dir: 0, index: 0, confirmedIndex: 0, level: 105 },
    { type: 'sos-or-sow', dir: 1, index: 1, confirmedIndex: 1, level: 105 },
    { type: 'lps-or-lpsy', dir: 1, index: 2, confirmedIndex: 2, level: 100 },
  ];
  const result = evaluateEntryModels({ events, locations, marketContext: 'range', biasDirection: 1, entryDirection: 1 });
  assert.equal(result.primary.model_id, 'J');
});


test('A context variants only use a sweep tagged for that causal context', () => {
  const base = fixtureEvents('A', ['significant-sweep', 'displacement', 'structure-shift']);
  base[0].context = 'range';
  const result = evaluateEntryModels({ events: base, locations, biasDirection: 1 });
  assert.equal(result.primary.model_id, 'A');
  assert.equal(result.primary.context, 'range');
  const wrongContext = evaluateEntryModels({ events: base.map((event) => ({ ...event, context: event.type === 'significant-sweep' ? 'dealing-range' : undefined })), locations, biasDirection: 1 });
  assert.equal(wrongContext.primary.context, 'dealing-range');
  const unsupportedContext = evaluateEntryModels({ events: base.map((event) => ({ ...event, context: event.type === 'significant-sweep' ? 'trend' : undefined })), locations, biasDirection: 1 });
  assert.equal(unsupportedContext.primary, null);
});

test('all model sequences are invariant to appended future events at an earlier as-of index', () => {
  for (const [id, types, directions] of modelCases) {
    const events = fixtureEvents(id, types, id === 'D' ? -1 : 1);
    if (id === 'A') events[0].context = 'swing';
    const location = id === 'F' ? [{ dir: 1, top: 100, bottom: 98 }] : [{ dir: id === 'D' ? -1 : 1, top: 110, bottom: 90 }];
    const context = id === 'J' ? 'range' : 'trend';
    const prefix = evaluateEntryModels({ events, locations: location, marketContext: context, ...directions, asOfIndex: events.length - 1 });
    const extended = evaluateEntryModels({ events: [...events, { type: 'ob-retest', dir: 1, index: 99, confirmedIndex: 99 }], locations: location, marketContext: context, ...directions, asOfIndex: events.length - 1 });
    assert.deepEqual(extended, prefix, `${id} must ignore future events`);
  }
});


test('each model rejects every missing sequence event and reversed event order', () => {
  for (const [id, types, directions] of modelCases) {
    const dir = id === 'D' ? -1 : 1, context = id === 'J' ? 'range' : 'trend';
    const events = fixtureEvents(id, types, dir), location = id === 'F' ? [{ dir, top: 100, bottom: 98 }] : [{ dir, top: 110, bottom: 90 }];
    for (let missing = 0; missing < types.length; missing++) {
      const damaged = structuredClone(events);
      if (id === 'F') damaged[0].sequenceEvents.splice(missing, 1); else damaged.splice(missing, 1);
      assert.equal(evaluateEntryModels({ events: damaged, locations: location, marketContext: context, ...directions }).candidates.some((candidate) => candidate.model_id === id), false, `${id}: missing ${types[missing]}`);
    }
    if (id === 'F') {
      const reversed = structuredClone(events); reversed[0].sequenceEvents.reverse().forEach((event, index) => { event.confirmedIndex = index; event.index = index; });
      assert.equal(evaluateEntryModels({ events: reversed, locations: location, marketContext: context, ...directions }).primary, null, `${id}: reversed order`);
    } else {
      const reverseTime = [...events].reverse().map((event, index) => ({ ...event, confirmedIndex: index, index }));
      assert.equal(evaluateEntryModels({ events: reverseTime, locations: location, marketContext: context, ...directions }).candidates.some((candidate) => candidate.model_id === id), false, `${id}: reversed order`);
    }
  }
});

test('each model independently rejects wrong direction, wrong context, missing location, pre-entry invalidation and expiry', () => {
  for (const [id, types, directions] of modelCases) {
    const dir = id === 'D' ? -1 : 1, context = id === 'J' ? 'range' : 'trend';
    const events = fixtureEvents(id, types, dir), location = id === 'F' ? [{ dir, top: 100, bottom: 98 }] : [{ dir, top: 110, bottom: 90 }];
    const valid = { events, locations: location, marketContext: context, ...directions };
    const wrongDir = { ...valid, events: fixtureEvents(id, types, -dir) };
    if (directions.biasDirection != null && directions.entryDirection != null) { wrongDir.biasDirection = directions.biasDirection; wrongDir.entryDirection = directions.entryDirection; }
    assert.equal(evaluateEntryModels(wrongDir).candidates.some((candidate) => candidate.model_id === id), false, `${id}: wrong direction`);
    assert.equal(evaluateEntryModels({ ...valid, biasDirection: -dir }).candidates.some((candidate) => candidate.model_id === id), false, `${id}: bias layer rejects direction`);
    if (id !== 'A') assert.equal(evaluateEntryModels({ ...valid, marketContext: context === 'trend' ? 'range' : 'trend' }).candidates.some((candidate) => candidate.model_id === id), false, `${id}: wrong context`);
    assert.equal(evaluateEntryModels({ ...valid, locations: [] }).candidates.some((candidate) => candidate.model_id === id), false, `${id}: no location`);
    assert.equal(evaluateEntryModels({ ...valid, locations: [{ dir, top: 202, bottom: 200 }] }).candidates.some((candidate) => candidate.model_id === id), false, `${id}: location does not contain model level`);
    assert.equal(evaluateEntryModels({ ...valid, locations: [{ dir: -dir, top: 110, bottom: 90 }] }).candidates.some((candidate) => candidate.model_id === id), false, `${id}: location direction opposes model`);
    assert.equal(evaluateEntryModels({ ...valid, preEntryInvalidated: true }).primary, null, `${id}: pre-entry invalidation`);
    assert.equal(evaluateEntryModels({ ...valid, expired: true }).primary, null, `${id}: expired`);
    if (id === 'F') assert.equal(evaluateEntryModels({ ...valid, locations: [{ dir, top: 98.9, bottom: 98 }] }).primary, null, 'F: inducement level outside pullback zone');
  }
});

test('Model A accepts significant liquidity only; F requires confirmed minor inducement and cannot borrow A evidence', () => {
  const aEvents = fixtureEvents('A', ['significant-sweep', 'displacement', 'structure-shift']);
  aEvents[0].classification = 'minor-inducement-liquidity';
  assert.equal(evaluateEntryModels({ events: aEvents, locations, biasDirection: 1 }).primary, null);
  const fEvents = fixtureEvents('F', ['inducement-confirmed']);
  assert.equal(evaluateEntryModels({ events: fEvents, locations: [{ dir: 1, top: 100, bottom: 98 }], biasDirection: 1, entryDirection: 1 }).primary.model_id, 'F');
  assert.equal(evaluateEntryModels({ events: aEvents, locations, biasDirection: 1, entryDirection: 1 }).candidates.some((candidate) => candidate.model_id === 'F'), false);
  const protectedSweep = [{ type: 'significant-sweep', classification: 'significant-liquidity', dir: 1, index: 0, confirmedIndex: 0, level: 100 }, ...seq(['displacement', 'structure-shift']).map((event) => ({ ...event, index: event.index + 1, confirmedIndex: event.confirmedIndex + 1 }))];
  assert.equal(evaluateEntryModels({ events: protectedSweep, locations, biasDirection: 1 }).primary.model_id, 'A');
});
