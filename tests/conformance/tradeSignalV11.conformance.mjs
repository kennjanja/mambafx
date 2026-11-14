import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeEvidence } from '../../src/analysis/evidence.js';
import { analyze } from '../../src/analysis/engine.js';
import { analyzeLiquidity } from '../../src/analysis/liquidity.js';
import { modelASpringEvent } from '../../src/analysis/tradeSignalModelA.js';

const candle = (i, low = 99, high = 101, close = 100) =>
  ({ epoch: 1700000000 + i * 60, open: 100, high, low, close });

test('production Model A spring is unavailable before next-close confirmation', () => {
  const candles = Array.from({ length: 71 }, (_, i) => candle(i));
  candles[70] = candle(70, 98);
  const events = analyzeEvidence(candles, { granularity: 60 }).facts.modelEvents;
  assert.equal(events.some((e) => e.context === 'range' && e.type === 'significant-sweep' && e.index === 70), false,
    'pending integration: candidate-time spring must not be a Model A confirmed sweep');
});

test('production range sweep exposes the v1.1 attribution and event identity contract', () => {
  const candles = Array.from({ length: 72 }, (_, i) => candle(i));
  candles[70] = candle(70, 98);
  const events = analyzeEvidence(candles, { granularity: 60 }).facts.modelEvents;
  const sweep = events.find((e) => e.context === 'range' && e.type === 'significant-sweep' && e.index === 70);
  assert.ok(sweep, 'confirmed independent spring must be available');
  assert.equal(sweep.confirmedIndex, 71, 'confirmation belongs to the next close');
  assert.equal(typeof sweep.poolAttributed, 'boolean', 'attribution must be recorded');
  assert.ok(Array.isArray(sweep.constituentIndices), 'constituent identities must be recorded');
  assert.ok(Object.hasOwn(sweep, 'poolSweepEventId'), 'pool-sweep identity or explicit absence must be recorded');
});

test('liquidity engine exposes immutable per-close pool snapshots', () => {
  const candles = Array.from({ length: 8 }, (_, i) => candle(i));
  const pivots = { confirmed: [
    { type: 'low', index: 1, price: 99, confirmedIndex: 2 },
    { type: 'low', index: 3, price: 99, confirmedIndex: 4 },
  ] };
  const result = analyzeLiquidity(candles, { pivots, referenceLevels: [], atr: candles.map(() => 1), captureSnapshots: true });
  assert.ok(result.poolSnapshots, 'pending integration: immutable historical snapshots are not provided');
  const first = result.poolSnapshots[2], later = result.poolSnapshots[4];
  assert.ok(first && later);
  assert.deepEqual(first.pools[0].pivotIndices, [1]);
  assert.deepEqual(later.pools[0].pivotIndices, [1, 3]);
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.pools[0]) && Object.isFrozen(first.pools[0].pivotIndices));
});

test('confirmed liquidity sweeps retain event-group identity at confirmation', () => {
  const candles = Array.from({ length: 7 }, (_, i) => candle(i));
  candles[4] = candle(4, 98, 101, 100);
  const result = analyzeLiquidity(candles, {
    pivots: { confirmed: [{ type: 'low', index: 1, price: 99, confirmedIndex: 2 }] },
    referenceLevels: [], atr: candles.map(() => 1), captureSnapshots: true,
  });
  const event = result.events.find((e) => e.kind === 'sweep-confirmed' && e.index === 4);
  assert.ok(event, 'expected a confirmed sweep');
  assert.equal(event.confirmedIndex, 5);
  assert.equal(event.extreme, 98, 'sweep extreme must be captured at confirmation');
  assert.equal(typeof event.id, 'string', 'pending integration: confirmed sweep has no stored event ID');
  assert.ok(event.id.length > 0);
  assert.equal(event.groupId, JSON.stringify(['sell', 4, 5, 98]));
  assert.equal(Object.getOwnPropertyDescriptor(event, 'id').writable, false);
});

test('equality on the confirmation candle is not a confirmed sweep', () => {
  const candles = Array.from({ length: 7 }, (_, i) => candle(i));
  candles[4] = candle(4, 98, 101, 100);
  candles[5] = candle(5, 99, 101, 99);
  const result = analyzeLiquidity(candles, {
    pivots: { confirmed: [{ type: 'low', index: 1, price: 99, confirmedIndex: 2 }] },
    referenceLevels: [], atr: candles.map(() => 1), captureSnapshots: true,
  });
  assert.equal(result.events.some((e) => e.kind === 'sweep-confirmed' && e.index === 4), false,
    'pending integration: equality lapses the candidate and must not confirm a sweep');
});

test('equality lapses buy and sell candidates without invalidating the pool', () => {
  for (const [type, side] of [['low', 'sell'], ['high', 'buy']]) {
    const level = side === 'sell' ? 99 : 101;
    const candles = Array.from({ length: 8 }, (_, i) => candle(i));
    candles[3] = side === 'sell' ? candle(3, 98, 101, level) : candle(3, 99, 102, level);
    candles[4] = side === 'sell' ? candle(4, 98, 101, 100) : candle(4, 99, 102, 100);
    candles[5] = side === 'sell' ? candle(5, 99, 101, level) : candle(5, 99, 101, level);
    candles[6] = side === 'sell' ? candle(6, 98, 101, 100) : candle(6, 99, 102, 100);
    const result = analyzeLiquidity(candles, {
      pivots: { confirmed: [{ type, index: 1, price: level, confirmedIndex: 2 }] },
      referenceLevels: [], atr: candles.map(() => 1), captureSnapshots: true,
    });
    assert.equal(result.events.some((event) => event.kind === 'sweep-candidate' && event.index === 3), false, side);
    assert.equal(result.events.some((event) => event.kind === 'sweep-confirmed' && event.index === 4), false, side);
    assert.equal(result.events.some((event) => event.kind === 'sweep-failed' && event.index === 4), false, side);
    assert.equal(result.poolSnapshots[5].pools[0].status, 'active', side);
    assert.equal(result.poolSnapshots[5].pools[0].pending, null, side);
    assert.equal(result.events.some((event) => event.kind === 'sweep-confirmed' && event.index === 6), true, side);
  }
});

test('a same-close pivot cannot change the prior pool level before its sweep', () => {
  for (const mirror of [false, true]) {
    let candles = Array.from({ length: 72 }, (_, i) =>
      ({ epoch: i * 60, open: 101, high: 102, low: 101, close: 101 }));
    for (const index of [50, 56]) candles[index].low = 100;
    candles[66].low = 99.9;
    candles[67] = { ...candles[67], open: 100, low: 100, close: 100 };
    candles[69].low = 99.95;
    if (mirror) candles = candles.map((c) => ({
      ...c, open: 202 - c.open, high: 202 - c.low, low: 202 - c.high, close: 202 - c.close,
    }));
    const side = mirror ? 'buy' : 'sell';
    const result = analyzeLiquidity(candles, { referenceLevels: [], atr: candles.map(() => 1), captureSnapshots: true });
    const before = result.poolSnapshots[68].pools.find((pool) => pool.side === side && pool.pivotIndices.includes(50));
    const old = result.poolSnapshots[69].pools.find((pool) => pool.id === before.id);
    const newPool = result.poolSnapshots[69].pools.find((pool) => pool.side === side && pool.pivotIndices.includes(66));
    assert.equal(before.level, mirror ? 102 : 100);
    assert.equal(before.pending, null);
    assert.equal(old.level, before.level);
    assert.equal(old.pending.index, 69);
    assert.notEqual(newPool.id, old.id);
    assert.deepEqual(newPool.pivotIndices, [66]);
    const confirmed = result.events.find((event) => event.kind === 'sweep-confirmed' && event.index === 69 && event.poolId === old.id);
    assert.ok(confirmed);
    assert.equal(confirmed.confirmedIndex, 70);
  }
});

test('production emits a diagnostic and fails closed on missing historical provenance', () => {
  const candles = Array.from({ length: 72 }, (_, i) => ({ ...candle(i, 101, 110, 105), open: 105 }));
  for (const index of [55, 61]) candles[index].low = 99;
  candles[70].low = 98;
  const liquidity = analyze(candles, { captureSnapshots: true, referenceLevels: [] }).liquidity;
  const event = (provenance) => modelASpringEvent({ candles, candidateIndex: 70, kind: 'spring',
    liquidity: provenance, asOfIndex: 71 });
  assert.equal(event(liquidity).poolAttributed, true);
  assert.ok(event(liquidity).poolSweepEventId);
  const missingSnapshot = { ...liquidity, poolSnapshots: [...liquidity.poolSnapshots] };
  missingSnapshot.poolSnapshots[69] = undefined;
  const noSnapshot = event(missingSnapshot);
  assert.equal(noSnapshot.poolAttributed, false);
  assert.equal(noSnapshot.poolSweepEventId, null);
  assert.ok(noSnapshot.diagnostics.includes('missing-or-invalid-point-in-time-pool-snapshot'));
  const missingIdentity = { ...liquidity, events: liquidity.events.map((record) =>
    record.kind === 'sweep-confirmed' && record.index === 70 ? { ...record, id: undefined } : record) };
  const noIdentity = event(missingIdentity);
  assert.equal(noIdentity.poolAttributed, false);
  assert.equal(noIdentity.poolSweepEventId, null);
  assert.ok(noIdentity.diagnostics.includes('missing-or-invalid-confirmed-sweep-event-id'));
});

test('production spring setup records lifecycle as of the preceding-close snapshot', () => {
  const candles = Array.from({ length: 72 }, (_, i) => ({ ...candle(i, 101, 110, 105), open: 105 }));
  candles[55] = { ...candle(55, 99, 110, 105), open: 105 };
  candles[61] = { ...candle(61, 99, 110, 105), open: 105 };
  candles[70] = { ...candle(70, 98, 110, 105), open: 105 };
  const event = analyzeEvidence(candles, { granularity: 60 }).facts.modelEvents
    .find((e) => e.context === 'range' && e.type === 'significant-sweep' && e.index === 70);
  assert.ok(event, 'a confirmed independent spring must be available');
  assert.equal(event.poolAttributed, true, 'the previously active non-pending pool must be attributed');
  assert.deepEqual(event.poolSnapshotState, { status: 'active', pending: false });
  assert.deepEqual(event.constituentIndices, [55, 61]);
  assert.equal(typeof event.poolSweepEventId, 'string', 'the same-group sweep identity must be recorded');
});
