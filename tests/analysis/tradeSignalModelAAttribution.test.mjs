import test from 'node:test';
import assert from 'node:assert/strict';
import { assessModelASpring } from '../../src/analysis/tradeSignalModelA.js';

// Isolated helper unit tests only. They are NOT production integration or v1.1
// conformance coverage; the separate Batch 1 gate must pass before audit work.
function assess(input) {
  const pools = Object.freeze(input.pools.map((pool) => Object.freeze({
    ...pool, pivotIndices: Object.freeze([...pool.pivotIndices]),
    pending: pool.pending === null ? null : Object.freeze({ ...pool.pending }),
  })));
  const poolSnapshot = Object.freeze({
    index: input.candidateIndex - 1, epoch: input.candles[input.candidateIndex - 1].epoch, pools,
  });
  return assessModelASpring({ ...input, poolSnapshot });
}
const bar = (i, low = 12, high = 20, close = 15) =>
  ({ epoch: i * 60, open: 15, high, low, close });

function fixture() {
  const candles = Array.from({ length: 28 }, (_, i) => bar(i));
  candles[8] = bar(8, 10);
  candles[14] = bar(14, 10);
  candles[25] = bar(25, 9);
  const pool = { id: 1, source: 'pivot', side: 'sell', level: 10, pivotIndices: [8, 14], status: 'active', pending: null };
  const groupId = JSON.stringify(['sell', 25, 26, 9]);
  const sweep = { id: JSON.stringify(['pool-sweep', 1, groupId]), groupId, kind: 'sweep-confirmed', poolId: 1, side: 'sell',
    index: 25, confirmedIndex: 26, extreme: 9, eligible: true };
  return { candles, candidateIndex: 25, kind: 'spring', pools: [pool], sweeps: [sweep], asOfIndex: 26 };
}

test('all independently confirmed equal boundary pivots are attributed', () => {
  const result = assess(fixture());
  assert.equal(result.confirmedIndex, 26);
  assert.equal(result.poolAttributed, true);
  assert.equal(result.poolId, 1);
  assert.deepEqual(result.constituentIndices, [8, 14]);
  assert.equal(result.poolSweepEventId, fixture().sweeps[0].id);
});

test('nearby pool level is not exact attribution, and unattributed spring remains eligible', () => {
  const input = fixture();
  input.pools[0].level = 10.01;
  const result = assess(input);
  assert.equal(result.poolAttributed, false);
  assert.equal(result.poolId, null);
  assert.equal(result.poolSweepEventId, null);
  assert.equal(result.confirmedIndex, 26);
});

test('a later equal pivot inside the strict-left window is not a constituent', () => {
  const input = fixture();
  input.candles[10] = bar(10, 10);
  assert.deepEqual(assess(input).constituentIndices, [8, 14]);
});

test('a tie needing the event candle for confirmation cannot be attributed', () => {
  const input = fixture();
  input.candles[23] = bar(23, 10);
  input.pools[0].pivotIndices = [23];
  const result = assess(input);
  assert.equal(result.poolAttributed, false);
  assert.ok(result.diagnostics.includes('missing-or-invalid-point-in-time-pool-snapshot'));
});

test('window-edge tie must pass pivot checks outside the window', () => {
  const input = fixture();
  input.candles[4] = bar(4, 9);
  input.candles[5] = bar(5, 10);
  input.pools[0].pivotIndices = [5];
  const result = assess(input);
  assert.equal(result.poolAttributed, false);
  assert.ok(result.diagnostics.includes('missing-or-invalid-point-in-time-pool-snapshot'));
});

test('multiple matching pools are ambiguous and cannot supply pool evidence', () => {
  const input = fixture();
  input.pools.push({ ...input.pools[0], id: 2 });
  const result = assess(input);
  assert.equal(result.poolAttributed, false);
  assert.equal(result.poolId, null);
  assert.equal(result.poolSweepEventId, null);
});

test('next-close confirmation is required and strict', () => {
  const input = fixture();
  assert.equal(assess({ ...input, asOfIndex: 25 }), null);
  input.candles[26] = bar(26, 10, 20, 10);
  assert.equal(assess(input), null);
});

test('sweep evidence requires a confirmed eligible matching group and pool', () => {
  const input = fixture();
  const cases = [
    [],
    [{ ...input.sweeps[0], kind: 'sweep-candidate' }],
    [{ ...input.sweeps[0], eligible: false }],
    [{ ...input.sweeps[0], poolId: 2 }],
    [{ ...input.sweeps[0], side: 'buy' }],
    [{ ...input.sweeps[0], index: 24 }],
    [{ ...input.sweeps[0], confirmedIndex: 27 }],
    [{ ...input.sweeps[0], extreme: 8 }],
  ];
  for (const sweeps of cases) {
    const result = assess({ ...input, sweeps });
    assert.equal(result.poolAttributed, true);
    assert.equal(result.poolSweepEventId, null);
  }
});

test('future ties cannot change the event as of its original decision', () => {
  const input = fixture();
  const initial = assess(input);
  input.candles.push(bar(28, 10), bar(29), bar(30), bar(31));
  assert.deepEqual(assess(input), initial);
});

test('invalid input guard: forged equal-level pivot confirmed on sweep close fails closed', () => {
  const input = fixture();
  input.candles[22] = bar(22, 10);
  input.pools[0].pivotIndices.push(22);
  const result = assess(input);
  assert.equal(result.poolAttributed, false);
  assert.equal(result.poolSweepEventId, null);
  assert.ok(result.diagnostics.includes('missing-or-invalid-point-in-time-pool-snapshot'));
});

test('upthrust attribution and confirmation mirror spring behavior', () => {
  const input = fixture();
  input.candles = input.candles.map((c) => ({
    ...c, open: 30 - c.open, high: 30 - c.low, low: 30 - c.high, close: 30 - c.close,
  }));
  input.kind = 'upthrust';
  input.pools = [{ ...input.pools[0], side: 'buy', level: 20 }];
  const groupId = JSON.stringify(['buy', 25, 26, 21]);
  input.sweeps = [{ ...input.sweeps[0], side: 'buy', extreme: 21,
    groupId, id: JSON.stringify(['pool-sweep', 1, groupId]) }];
  const result = assess(input);
  assert.equal(result.poolAttributed, true);
  assert.deepEqual(result.constituentIndices, [8, 14]);
  assert.equal(result.poolSweepEventId, input.sweeps[0].id);
  assert.equal(result.sweptLevelId, 'UPT|20|5|25');
  input.candles[26] = bar(26, 10, 20, 20);
  assert.equal(assess(input), null);
});

test('missing snapshot or confirmed event identity fails closed with diagnostics', () => {
  const input = fixture();
  const missingSnapshot = assessModelASpring(input);
  assert.equal(missingSnapshot.poolAttributed, false);
  assert.equal(missingSnapshot.poolSweepEventId, null);
  assert.deepEqual(missingSnapshot.diagnostics, ['missing-or-invalid-point-in-time-pool-snapshot']);
  const missingId = assess({ ...input, sweeps: [{ ...input.sweeps[0], id: null }] });
  assert.equal(missingId.poolAttributed, false);
  assert.equal(missingId.poolSweepEventId, null);
  assert.deepEqual(missingId.diagnostics, ['missing-or-invalid-confirmed-sweep-event-id']);
});

test('only the snapshot active non-pending pool can be attributed', () => {
  for (const [status, pending, expected] of [
    ['active', null, true], ['swept', null, false], ['invalidated', null, false],
    ['expired', null, false], ['active', { index: 24 }, false],
  ]) {
    const input = fixture();
    input.pools[0].status = status;
    input.pools[0].pending = pending;
    const result = assess(input);
    assert.equal(result.poolAttributed, expected, `${status} pending=${Boolean(pending)}`);
    assert.equal(result.confirmedIndex, 26);
    if (expected) assert.equal(result.poolSnapshotState.status, 'active');
  }
});
