import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeEvidence } from '../../src/analysis/evidence.js';
import { analyze } from '../../src/analysis/engine.js';
import { attributeSpringUpthrustV11 } from '../reference/tradeSignalModelAV11.mjs';

function fixture() {
  const candles = Array.from({ length: 76 }, (_, i) =>
    ({ epoch: i * 60, open: 15, high: 20, low: 12, close: 15 }));
  candles[55].low = 10;
  candles[61].low = 10;
  candles[70].low = 9;
  const event = { type: 'spring', id: 'SPR|20|50|70', eventIndex: 70, confirmationIndex: 71, windowStartIndex: 50 };
  return { candles, event };
}

function reference(input, asOfIndex) {
  const replay = analyze(input.candles, { captureSnapshots: true, referenceLevels: [] });
  const pivots = replay.internal.pivots.confirmed;
  const pools = replay.liquidity.poolSnapshots[69].pools.filter((pool) => pool.source === 'pivot').map((pool) =>
    Object.freeze({ id: String(pool.id), side: pool.side, level: pool.level, status: pool.status,
      pending: pool.pending, constituentPivots: Object.freeze(pool.pivotIndices.map((index) => {
        const pivot = pivots.find((item) => item.index === index && item.type === (pool.side === 'sell' ? 'low' : 'high'));
        assert.ok(pivot, 'replayed pool constituent must be a confirmed pivot');
        return Object.freeze({ id: `pivot-${pivot.type}-${pivot.index}`, index: pivot.index, kind: pivot.type,
          price: pivot.price, confirmationIndex: pivot.confirmedIndex });
      })) }));
  const poolSnapshot = Object.freeze({ asOfIndex: 69, pools: Object.freeze(pools) });
  const confirmedSweeps = replay.liquidity.events.filter((record) => record.kind === 'sweep-confirmed').map((record) =>
    ({ id: record.id, poolId: String(record.poolId), side: record.side, candidateIndex: record.index,
      confirmationIndex: record.confirmedIndex, extreme: record.extreme, confirmed: true, eligible: record.eligible }));
  return attributeSpringUpthrustV11({ ...input, poolSnapshot, confirmedSweeps, timeframeSeconds: 60, asOfIndex });
}

function actual(candles) {
  return analyzeEvidence(candles, { granularity: 60 })
    .facts.modelEvents.find((e) => e.type === 'significant-sweep' && e.context === 'range' && e.index === 70);
}

test('differential replay does not admit a spring before independent next-close confirmation', () => {
  const input = fixture();
  const expected = reference(input, 70);
  assert.equal(expected.springUpthrustConfirmed, false);
  assert.equal(Boolean(actual(input.candles.slice(0, 71))), expected.springUpthrustConfirmed,
    'production still emits candidate-time Model A evidence');
});

test('differential replay preserves confirmed tied-pivot attribution at the decision', () => {
  const input = fixture();
  const expected = reference(input, 71);
  assert.equal(expected.springUpthrustConfirmed, true);
  assert.deepEqual(expected.qualifyingConstituents, ['pivot-low-55', 'pivot-low-61']);
  const found = actual(input.candles);
  assert.ok(found, 'production must emit the confirmed event');
  assert.equal(found.confirmedIndex, expected.confirmationIndex);
  assert.equal(found.poolAttributed, expected.poolAttributed);
  assert.deepEqual(found.constituentIndices, [55, 61]);
  assert.equal(found.poolSweepEventId, expected.poolSweepId);
  assert.ok(found.poolSweepEventId, 'the replay must contain a real confirmed sweep');
});

test('differential replay does not let later appended ties change the earlier decision', () => {
  const input = fixture();
  const expected = reference(input, 71);
  input.candles[74].low = 10;
  assert.deepEqual(reference(input, 71), expected);
  const found = actual(input.candles);
  assert.ok(found);
  assert.equal(found.confirmedIndex, expected.confirmationIndex);
  assert.equal(found.poolAttributed, expected.poolAttributed);
  assert.deepEqual(found.constituentIndices, [55, 61]);
});
