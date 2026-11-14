import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../../src/analysis/engine.js';
import { modelASpringEvent } from '../../src/analysis/tradeSignalModelA.js';

test('injected same-level pools preserve multi-match ambiguity without pool-sweep evidence', () => {
  const candles = Array.from({ length: 72 }, (_, index) =>
    ({ epoch: index * 60, open: 11, high: 12, low: 11, close: 11 }));
  candles[55].low = 10;
  candles[61].low = 10;
  candles[70] = { ...candles[70], low: 9, close: 11 };
  candles[71] = { ...candles[71], close: 11 };
  const liquidity = analyze(candles, { captureSnapshots: true, referenceLevels: [] }).liquidity;
  const actual = liquidity.poolSnapshots[69];
  const pools = [55, 61].map((pivotIndex, index) => Object.freeze({
    id: 100 + index,
    source: 'pivot',
    side: 'sell',
    level: 10,
    touches: 1,
    equal: false,
    pivotIndices: Object.freeze([pivotIndex]),
    lastTouchIndex: pivotIndex,
    formedIndex: pivotIndex + 3,
    formedEpoch: candles[pivotIndex + 3].epoch,
    updatedIndex: pivotIndex + 3,
    status: 'active',
    pending: null,
    period: null,
    periodId: null,
  }));
  const snapshot = Object.freeze({ ...actual, pools: Object.freeze(pools) });
  const event = modelASpringEvent({ candles, candidateIndex: 70, kind: 'spring',
    liquidity: { ...liquidity, poolSnapshots: Object.freeze(liquidity.poolSnapshots.map((item, index) =>
      index === 69 ? snapshot : item)) }, asOfIndex: 71 });
  assert.ok(event, 'the independently confirmed spring remains eligible');
  assert.equal(event.poolAttributed, false);
  assert.equal(event.matchCount, 2);
  assert.equal(event.attributionAmbiguous, true);
  assert.equal(event.poolId, null);
  assert.equal(event.poolSnapshotState, null);
  assert.deepEqual(event.attributionCandidates.map((candidate) => candidate.poolId), [100, 101]);
  assert.equal(event.poolSweepEventId, null);
  assert.equal(event.groupId, JSON.stringify(['sell', 70, 71, 9]));
});
