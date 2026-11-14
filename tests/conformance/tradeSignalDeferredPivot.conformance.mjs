import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../../src/analysis/engine.js';
import { analyzeEvidence } from '../../src/analysis/evidence.js';

const bars = (count) => Array.from({ length: count }, (_, index) =>
  ({ epoch: index * 60, open: 101, high: 102, low: 101, close: 101 }));

test('pre-ATR pivots are pooled once at t-star with the same available ATR', () => {
  const candles = bars(20);
  candles[3].low = 100;
  candles[9].low = 100.2;
  const result = analyze(candles, { captureSnapshots: true, referenceLevels: [] });
  assert.equal(result.atr[12], null);
  assert.ok(Math.abs(result.atr[13] - 1.1285714285714283) < 1e-12);
  assert.ok(100.2 - 100 < 0.25 * result.atr[13]);
  for (let index = 0; index < 13; index++) assert.deepEqual(result.liquidity.poolSnapshots[index].pools, []);
  const pool = result.liquidity.poolSnapshots[13].pools.find((item) => item.side === 'sell');
  assert.deepEqual(pool.pivotIndices, [3, 9]);
  assert.equal(pool.formedIndex, 13);
  assert.equal(pool.touches, 2);
  assert.deepEqual(result.liquidity.poolSnapshots[19].pools.find((item) => item.id === pool.id).pivotIndices, [3, 9]);
  assert.deepEqual(result.liquidity.diagnostics.map((item) => item.code),
    ['pivot-pool-assignment-awaiting-atr', 'pivot-pool-assignment-awaiting-atr']);
  const prefix = analyze(candles.slice(0, 13), { captureSnapshots: true, referenceLevels: [] });
  assert.deepEqual(result.liquidity.poolSnapshots[12], prefix.liquidity.poolSnapshots[12]);
});

test('t-star evaluates an existing reference sweep before assigning deferred and same-close pivots', () => {
  const candles = bars(15);
  candles[3].low = 99;
  candles[10] = { ...candles[10], high: 105, low: 100 };
  candles[13] = { ...candles[13], high: 104, low: 100.5 };
  const referenceLevels = [{ source: 'PDH', side: 'buy', level: 103, period: 'day', periodId: 0, startIndex: 12, partial: false }];
  const result = analyze(candles, { captureSnapshots: true, referenceLevels });
  const before = result.liquidity.poolSnapshots[12].pools;
  assert.equal(before.length, 1);
  assert.equal(before[0].source, 'PDH');
  const after = result.liquidity.poolSnapshots[13].pools;
  assert.equal(after.find((pool) => pool.source === 'PDH').pending.index, 13);
  assert.deepEqual(after.filter((pool) => pool.source === 'pivot').map((pool) => [pool.side, pool.pivotIndices]),
    [['sell', [3]], ['buy', [10]], ['sell', [10]]]);
  const event = result.liquidity.events.find((item) => item.kind === 'sweep-confirmed' && item.index === 13);
  assert.equal(event.poolId, before[0].id);
  assert.equal(event.confirmedIndex, 14);
});

test('bar-70 spring uses the later two-touch pool after prior-through pivots are dropped', () => {
  const candles = bars(72);
  for (const index of [3, 9, 55, 61]) candles[index].low = 99;
  for (const index of [13, 70]) candles[index].low = 98;
  const result = analyze(candles, { captureSnapshots: true, referenceLevels: [] });
  assert.deepEqual(result.liquidity.poolSnapshots[13].pools, []);
  assert.deepEqual(result.liquidity.diagnostics.filter((item) => item.code === 'deferred-pivot-traded-through')
    .map((item) => item.index), [3, 9]);
  const pool = result.liquidity.poolSnapshots[69].pools.find((item) => item.side === 'sell' && item.level === 99);
  assert.deepEqual(pool.pivotIndices, [55, 61]);
  assert.equal(pool.touches, 2);
  assert.equal(pool.status, 'active');
  assert.equal(pool.pending, null);
  const evidence = analyzeEvidence(candles, { granularity: 60 });
  const event = evidence.facts.modelEvents.find((item) => item.context === 'range' && item.index === 70);
  assert.equal(event.poolId, pool.id);
  assert.equal(event.poolAttributed, true);
  assert.equal(event.matchCount, 1);
  assert.deepEqual(event.constituentIndices, [55, 61]);
  assert.ok(event.poolSweepEventId);
  assert.ok(evidence.limitations.some((item) => item.includes('pivot-pool-assignment-awaiting-atr')));
  assert.ok(evidence.limitations.some((item) => item.includes('deferred-pivot-traded-through')));
});
