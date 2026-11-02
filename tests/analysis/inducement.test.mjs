import test from 'node:test';
import assert from 'node:assert/strict';
import { classifySweep, detectInducements, INDUCEMENT_MINOR_PIVOT_ORDER, INDUCEMENT_MAX_PIVOT_AGE_BARS, INDUCEMENT_MAX_SWEEP_TO_DISPLACEMENT_BARS } from '../../src/analysis/inducement.js';
import { evaluateEntryModels } from '../../src/analysis/tradeSignalArchitecture.js';

const bar = (i, overrides = {}) => ({ epoch: 1_700_000_000 + i * 60, open: 100, high: 100.5, low: 99.5, close: 100, ...overrides });
function fixture({ direction = 1, sweep = 12, displacement = 13, invalidation = null, maxAge = 20, maxDisplacement = 3, breakAt = null, equalMajor = false, sameIndexMajor = false, chochAt = null, omitDisplacement = false } = {}) {
  const candles = Array.from({ length: Math.max(20, sweep + 2, displacement + 2, (breakAt ?? 0) + 1) }, (_, i) => bar(i));
  if (direction === 1) candles[sweep] = bar(sweep, { open: 99.8, high: 100.2, low: 98.5, close: 99.2 });
  else candles[sweep] = bar(sweep, { open: 100.2, high: 101.5, low: 99.8, close: 100.8 });
  if (breakAt != null) candles[breakAt] = bar(breakAt, direction === 1 ? { open: 99.5, high: 99.8, low: 98.8, close: 98.9 } : { open: 100.5, high: 101.2, low: 100.2, close: 101.1 });
  if (invalidation === 'protected') candles[sweep] = bar(sweep, direction === 1 ? { open: 99.8, high: 100.2, low: 94.5, close: 99.2 } : { open: 100.2, high: 105.5, low: 99.8, close: 100.8 });
  const bos = { type: 'BOS', dir: direction, level: direction === 1 ? 101 : 99, pivotIndex: 5, confirmedIndex: 6, index: 6, status: 'confirmed' };
  const structure = { internal: { events: [bos, ...((invalidation === 'choch' || chochAt != null) ? [{ type: 'CHoCH', dir: -direction, index: chochAt ?? sweep, confirmedIndex: chochAt ?? sweep, status: 'confirmed' }] : [])] },
    swing: { pivots: { confirmed: [{ type: direction === 1 ? 'low' : 'high', index: 4, confirmedIndex: 5, price: direction === 1 ? 95 : 105 }] } },
    displacement: [{ dir: direction, index: 6, startIndex: 6, confirmedIndex: 6 }, ...(omitDisplacement ? [] : [{ dir: direction, index: displacement, startIndex: displacement === sweep ? sweep : sweep + 1, confirmedIndex: displacement }])] };
  if (sameIndexMajor) structure.swing.pivots.confirmed.push({ type: direction === 1 ? 'low' : 'high', index: 9, confirmedIndex: 11, price: direction === 1 ? 99 : 101 });
  if (equalMajor) structure.swing.pivots.confirmed.push({ type: direction === 1 ? 'low' : 'high', index: 8, confirmedIndex: 10, price: direction === 1 ? 99.02 : 100.98 });
  const minorPivots = [{ type: direction === 1 ? 'low' : 'high', index: 9, confirmedIndex: 11, price: direction === 1 ? 99 : 101 }];
  if (invalidation === 'protected') structure.displacement = structure.displacement.filter((event) => event.index !== sweep);
  return { candles, structure, minorPivots, options: { granularity: 60, structure, minorPivots, atr: Array(candles.length).fill(1), maxPivotAgeBars: maxAge, maxSweepToDisplacementBars: maxDisplacement, equalMajorAtrTolerance: 0.1 } };
}
const run = (options = {}) => { const f = fixture(options); return { f, events: detectInducements(f.candles, f.options) }; };
const only = (events) => events[0];

test('shared sweep classifier uses own-candle wick-and-close rule and exclusive classification', () => {
  const bull = classifySweep(bar(2, { low: 98, close: 99.1 }), { level: 99, direction: 1, minorPivotConfirmed: true, protectedLevel: 95 });
  assert.equal(bull.classification, 'minor-inducement-liquidity');
  const broken = classifySweep(bar(2, { low: 98, close: 98.8 }), { level: 99, direction: 1, minorPivotConfirmed: true, protectedLevel: 95 });
  assert.equal(broken.classification, 'none'); assert.match(broken.reason, /break, not a sweep/);
  const protectedSweep = classifySweep(bar(2, { low: 94, close: 99.1 }), { level: 99, direction: 1, minorPivotConfirmed: true, protectedLevel: 95 });
  assert.equal(protectedSweep.classification, 'significant-liquidity');
  const bear = classifySweep(bar(2, { high: 102, close: 100.9 }), { level: 101, direction: -1, minorPivotConfirmed: true, protectedLevel: 105 });
  assert.equal(bear.classification, 'minor-inducement-liquidity');
  assert.notEqual(bull.classification, protectedSweep.classification);
});

test('confirmed BOS, impulse, protected swing, post-BOS minor pivot, sweep and later displacement confirm inducement', () => {
  const { events } = run();
  assert.equal(events.length, 1);
  const event = only(events);
  assert.equal(event.direction, 1); assert.equal(event.state, 'confirmed');
  assert.deepEqual(event.stateHistory.map((item) => item.state), ['formed', 'swept', 'confirmed']);
  assert.equal(event.sweepIndex, 12); assert.equal(event.displacementIndex, 13);
  assert.equal(event.minorPivot.confirmedAt, 1_700_000_000 + 11 * 60 + 60);
  assert.equal(event.sweepConfirmedAt, 1_700_000_000 + 12 * 60 + 60);
  assert.equal(event.displacementConfirmedAt, 1_700_000_000 + 13 * 60 + 60);
  assert.deepEqual(event.limits, { minorPivotOrder: INDUCEMENT_MINOR_PIVOT_ORDER, maxPivotAgeBars: 20, maxSweepToDisplacementBars: 3 });
});

test('bearish mirror produces a confirmed minor inducement', () => {
  assert.equal(only(run({ direction: -1 }).events).state, 'confirmed');
});

test('close-through invalidates an unswept pivot at that candle close', () => {
  const event = only(run({ breakAt: 12 }).events);
  assert.equal(event.state, 'invalid'); assert.equal(event.invalidationReason, 'bullish minor pivot close-through break before sweep');
  assert.equal(event.invalidatedAt, event.sweepConfirmedAt ?? 1_700_000_000 + 12 * 60 + 60);
  assert.equal(event.sweepIndex, null);
});

test('bearish close-through is directionally identified at its own close and cannot later requalify Model F', () => {
  const f = fixture({ direction: -1, breakAt: 12, sweep: 14, displacement: 15 });
  const prefix = detectInducements(f.candles.slice(0, 13), f.options)[0];
  const full = detectInducements(f.candles, f.options)[0];
  assert.equal(prefix.state, 'invalid');
  assert.equal(full.state, 'invalid');
  assert.equal(full.invalidationReason, 'bearish minor pivot close-through break before sweep');
  assert.equal(full.invalidatedAt, f.candles[12].epoch + 60);
  assert.equal(full.sweepIndex, null);
  const invalidF = { type: 'inducement-confirmed', dir: -1, index: 15, confirmedIndex: 15, level: full.level,
    state: full.state, classification: 'minor-inducement-liquidity', sequenceEvents: [] };
  assert.equal(evaluateEntryModels({ events: [invalidF], biasDirection: -1, entryDirection: -1,
    locations: [{ dir: -1, top: 102, bottom: 100 }], marketContext: 'trend' }).candidates.some((candidate) => candidate.model_id === 'F'), false);
});

test('bullish close-through invalidates before a later apparent sweep and cannot requalify', () => {
  const f = fixture({ direction: 1, breakAt: 12, sweep: 14, displacement: 15 });
  const event = detectInducements(f.candles, f.options)[0];
  assert.equal(event.state, 'invalid');
  assert.equal(event.invalidationReason, 'bullish minor pivot close-through break before sweep');
  assert.equal(event.invalidatedAt, f.candles[12].epoch + 60);
  assert.equal(event.sweepIndex, null);
});

test('sweep boundary is strict wick penetration with inclusive reclaim at pivot close', () => {
  assert.equal(classifySweep(bar(1, { low: 98, close: 99 }), { level: 99, direction: 1, minorPivotConfirmed: true }).classification,
    'minor-inducement-liquidity');
  assert.equal(classifySweep(bar(1, { high: 102, close: 101 }), { level: 101, direction: -1, minorPivotConfirmed: true }).classification,
    'minor-inducement-liquidity');
  assert.equal(classifySweep(bar(1, { low: 99, close: 99 }), { level: 99, direction: 1, minorPivotConfirmed: true }).classification, 'none');
  assert.equal(classifySweep(bar(1, { high: 101, close: 101 }), { level: 101, direction: -1, minorPivotConfirmed: true }).classification, 'none');
  assert.equal(classifySweep(bar(1, { low: 98, close: 98.9 }), { level: 99, direction: 1, minorPivotConfirmed: true }).classification, 'none');
  assert.equal(classifySweep(bar(1, { high: 102, close: 101.1 }), { level: 101, direction: -1, minorPivotConfirmed: true }).classification, 'none');
});

test('protected level taken and opposing confirmed CHoCH each invalidate before inducement confirmation', () => {
  const protectedEvent = only(run({ invalidation: 'protected' }).events);
  assert.equal(protectedEvent.state, 'invalid'); assert.match(protectedEvent.invalidationReason, /protected structural level/);
  const chochEvent = only(run({ invalidation: 'choch' }).events);
  assert.equal(chochEvent.state, 'invalid'); assert.equal(chochEvent.invalidationReason, 'confirmed opposing CHoCH');
});

test('maximum pivot age is measured from confirmation with final allowed bar inclusive', () => {
  const finalAllowed = run({ sweep: 31, displacement: 32, maxAge: 20 });
  assert.equal(only(finalAllowed.events).state, 'confirmed');
  const expired = run({ sweep: 32, displacement: 33, maxAge: 20 });
  assert.equal(only(expired.events).state, 'invalid'); assert.equal(only(expired.events).invalidationReason, 'maximum pivot age exceeded');
});

test('sweep-to-displacement limit is inclusive and next bar invalidates', () => {
  const lastAllowed = run({ sweep: 12, displacement: 15, maxDisplacement: 3 });
  assert.equal(only(lastAllowed.events).state, 'confirmed');
  const beyond = run({ sweep: 12, displacement: 16, maxDisplacement: 3 });
  assert.equal(only(beyond.events).state, 'invalid'); assert.equal(only(beyond.events).invalidationReason, 'maximum sweep-to-displacement bars exceeded');
});

test('sweep candle cannot double as displacement and major/equal pivots are not inducement candidates', () => {
  assert.equal(only(run({ sweep: 12, displacement: 12 }).events).state, 'invalid');
  assert.equal(run({ equalMajor: true }).events.length, 0);
  assert.equal(run({ sameIndexMajor: true }).events.length, 0);
});

test('opposing CHoCH during minor-pivot confirmation invalidates the candidate before its formed state', () => {
  assert.equal(run({ chochAt: 10 }).events.length, 0, 'a pivot is not eligible when opposing structure changed before pivot confirmation');
});

test('pivot remains formed, then swept, with exact waiting states and invalidations exposed', () => {
  const f = fixture({ omitDisplacement: true });
  const beforeSweep = detectInducements(f.candles.slice(0, 12), { ...f.options, minorPivots: f.minorPivots });
  assert.equal(beforeSweep[0].state, 'formed');
  const afterSweep = detectInducements(f.candles.slice(0, 13), { ...f.options, minorPivots: f.minorPivots });
  assert.equal(afterSweep[0].state, 'swept');
  assert.equal(afterSweep[0].sweepIndex, 12);
});

test('inducement confirmation history is invariant under appending future candles', () => {
  const f = fixture(), prefix = f.candles.slice(0, 14), full = [...prefix, ...Array.from({ length: 4 }, (_, i) => bar(i + 14, { low: 96, high: 104 }))];
  const a = detectInducements(prefix, f.options)[0], b = detectInducements(full, f.options)[0];
  const historyAtT = b.stateHistory.filter((item) => item.index <= 13);
  assert.deepEqual(a.stateHistory, historyAtT);
  assert.equal(a.confirmedAt, b.confirmedAt);
});
