import test from 'node:test';
import assert from 'node:assert/strict';
import { compareFvgs, eligibleFvgs, fvgQuoteError } from '../../src/analysis/fvgQualification.js';
import { evaluateEntryModels } from '../../src/analysis/tradeSignalArchitecture.js';
import { analyzeEvidence } from '../../src/analysis/evidence.js';
import { claimInverseFvg } from '../../src/analysis/ifvgClaims.js';

const zone = (id = 1, overrides = {}) => ({ id, kind: 'FVG', dir: 1, bottom: 99, top: 101, mid: 100,
  createdIndex: 9, confirmedIndex: 10, sizeAtr: 1, fvgQuality: { qualified: true, tier: 'basic' }, history: [], ...overrides });
const corrections = [{ zoneId: 1, confirmedIndex: 12, depth: 0.3, deep: false }];
const loc = [{ dir: 1, bottom: 98, top: 102 }];

test('qualification requires both formation filters and a timely confirmed touch; wick fill is not invalidation', () => {
  const a = zone();
  assert.equal(eligibleFvgs([a], corrections, [], 11).length, 0);
  assert.equal(eligibleFvgs([a], corrections, [], 12).length, 1);
  assert.equal(eligibleFvgs([zone(1, { fvgQuality: { qualified: false } })], corrections, [], 12).length, 0);
  const filled = zone(1, { history: [{ status: 'filled', index: 12 }] });
  assert.equal(eligibleFvgs([filled], corrections, [], 12).length, 1);
  const inverted = zone(1, { history: [{ status: 'inverted', index: 13 }] });
  assert.equal(eligibleFvgs([inverted], corrections, [], 13).length, 0);
});

test('inverse gap is eligible only on its first subsequent completed retest', () => {
  const parent = zone(1, { history: [{ status: 'inverted', index: 13 }] });
  const inverse = { id: 2, parentId: 1, kind: 'IFVG', dir: -1, firstMitigationIndex: 15, history: [] };
  assert.equal(eligibleFvgs([parent, inverse], corrections, [], 14).length, 0);
  assert.equal(eligibleFvgs([parent, inverse], corrections, [], 15)[0].dir, -1);
  assert.equal(eligibleFvgs([parent, inverse], corrections, [], 16).length, 0);
  inverse.history = [{ status: 'invalidated', index: 15 }];
  assert.equal(eligibleFvgs([parent, inverse], corrections, [], 15).length, 0);
});

test('FVG model associates the ordered events with one eligible gap, then ranks by ATR size', () => {
  const a = eligibleFvgs([zone()], corrections, [], 13)[0];
  const b = { ...a, zoneId: 2, sizeAtr: 2 };
  const events = [
    { type: 'displacement', dir: 1, confirmedIndex: 9, index: 9 },
    ...[1, 2].flatMap((zoneId) => [
      { type: 'fvg-created', dir: 1, confirmedIndex: 10, index: 9, zoneId },
      { type: 'fvg-retest', dir: 1, confirmedIndex: 12, index: 12, zoneId },
    ]),
    { type: 'reaction', dir: 1, confirmedIndex: 13, index: 13 },
  ];
  const args = { events, fvgs: [a, b], locations: loc, biasDirection: 1, entryDirection: 1, asOfIndex: 13 };
  assert.equal(evaluateEntryModels(args).primary.fvg.zoneId, 2);
  assert.equal(evaluateEntryModels({ ...args, events: events.filter((e) => e.zoneId !== 2) }).primary.fvg.zoneId, 1);
  assert.equal(evaluateEntryModels({ ...args, fvgs: [] }).primary, null);
  assert.equal(evaluateEntryModels({ ...args, events: events.map((e) => e.type === 'displacement' ? { ...e, index: 8 } : e) }).primary, null);
  assert.equal(evaluateEntryModels({ ...args, fvgs: [{ ...a, quality: { qualified: false } }] }).primary, null);
});

test('inverse model retains bias and location gates and only uses its first retest', () => {
  const parent = zone(1, { dir: -1, history: [{ status: 'inverted', index: 13 }] });
  const inverse = { id: 2, parentId: 1, kind: 'IFVG', dir: 1, firstMitigationIndex: 15, history: [] };
  const fvgs = eligibleFvgs([parent, inverse], corrections, [], 15);
  const events = [{ type: 'ifvg-inverted', dir: 1, index: 13, confirmedIndex: 13, zoneId: 2 },
    { type: 'ifvg-retest', dir: 1, index: 15, confirmedIndex: 15, zoneId: 2 }];
  const args = { events, fvgs, locations: loc, biasDirection: 1, asOfIndex: 15 };
  assert.equal(evaluateEntryModels(args).primary.model_id, 'I');
  assert.equal(evaluateEntryModels({ ...args, biasDirection: -1 }).primary, null);
  assert.equal(evaluateEntryModels({ ...args, locations: [] }).primary, null);
  assert.equal(evaluateEntryModels({ ...args, events: events.slice(1) }).primary, null);
  assert.equal(evaluateEntryModels({ ...args, asOfIndex: 16 }).primary, null);
});

test('order quote fails closed for missing, stale, out-of-zone and expired inverse quotes', () => {
  const fvg = { bottom: 99, top: 101, kind: 'FVG', scanUntil: 120 };
  assert.equal(fvgQuoteError(fvg, { price: 99, epoch: 100 }, 100), null);
  assert.match(fvgQuoteError(fvg, null, 100), /quote/i);
  assert.match(fvgQuoteError(fvg, { price: 100, epoch: 84 }, 100), /quote/i);
  assert.match(fvgQuoteError(fvg, { price: 102, epoch: 100 }, 100), /left/i);
  assert.match(fvgQuoteError(fvg, { price: 100, epoch: 120 }, 120), /stale/i);
  assert.match(fvgQuoteError({ ...fvg, kind: 'IFVG', retestUntil: 100 }, { price: 100, epoch: 100 }, 100), /ended/i);
});

test('equal-size gaps use favorable swing position and deterministic tie-breaks', () => {
  const base = eligibleFvgs([zone()], corrections, [], 12)[0];
  const favored = { ...base, zoneId: 2, position: { preferred: true } };
  const larger = { ...base, zoneId: 3, sizeAtr: 1.01 };
  assert.deepEqual([base, favored, larger].sort(compareFvgs).map((gap) => gap.zoneId), [3, 2, 1]);
  assert.deepEqual([{ ...base, zoneId: 3 }, { ...base, zoneId: 2 }].sort(compareFvgs).map((gap) => gap.zoneId), [2, 3]);
});

test('real candle evidence qualifies continuation and first inverse retest in both directions', () => {
  const candles = Array.from({ length: 60 }, (_, i) => ({ epoch: 1700000000 + i * 60, open: 100, close: 100, high: 100.3, low: 99.7 }));
  const add = (open, high, low, close) => candles.push({ epoch: 1700000000 + candles.length * 60, open, high, low, close });
  add(100, 100.8, 99.8, 100.8);
  add(100.8, 102.3, 100.8, 102.2);
  add(101.7, 102.7, 101.7, 102.5);
  add(102.4, 102.5, 101.6, 102.45);
  for (const dir of [1, -1]) {
    const reflect = (c) => dir === 1 ? c : { ...c, open: 200 - c.open, close: 200 - c.close, high: 200 - c.low, low: 200 - c.high };
    const bars = candles.map(reflect);
    const evaluate = (input, direction) => {
      const evidence = analyzeEvidence(input, { granularity: 60 });
      return evaluateEntryModels({ events: evidence.facts.modelEvents, fvgs: evidence.facts.qualifiedFvgs,
        biasDirection: direction, entryDirection: direction, locations: [{ dir: direction, bottom: 0, top: 200 }],
        asOfIndex: input.length - 1 });
    };
    assert.ok(evaluate(bars, dir).candidates.some((c) => c.model_id === 'C'));
    const inversion = reflect({ epoch: 1700000000 + 64 * 60, open: 102, high: 102, low: 100.4, close: 100.5 });
    const retest = reflect({ epoch: 1700000000 + 65 * 60, open: 100.5, high: 101, low: 100.4, close: 100.6 });
    const inverseBars = [...bars, inversion, retest];
    assert.ok(evaluate(inverseBars, -dir).candidates.some((c) => c.model_id === 'I'));
    assert.ok(!evaluate([...inverseBars, { ...retest, epoch: retest.epoch + 60 }], -dir).candidates.some((c) => c.model_id === 'I'));
    assert.ok(!evaluate([...bars, inversion], -dir).candidates.some((c) => c.model_id === 'I'));
  }
});

test('blocked or synchronously failed inverse claim never starts a later transaction', async () => {
  const args = { symbol: 'test', granularity: 60, formationEpoch: 1, retestUntil: Math.floor(Date.now() / 1000) + 60 };
  await assert.rejects(claimInverseFvg(args, { open() { throw new Error('open failed'); } }), /open failed/);
  const request = {};
  const pending = claimInverseFvg(args, { open() { return request; } });
  request.onblocked();
  await assert.rejects(pending, /blocked/);
  let closed = false, transacted = false;
  request.result = { close() { closed = true; }, transaction() { transacted = true; } };
  request.onsuccess();
  assert.equal(closed, true);
  assert.equal(transacted, false);
  const secondRequest = {};
  const second = claimInverseFvg(args, { open() { return secondRequest; } });
  secondRequest.result = { close() {}, transaction() { throw new Error('transaction failed'); } };
  secondRequest.onsuccess();
  await assert.rejects(second, /transaction failed/);
});
