import assert from 'node:assert/strict';
import test from 'node:test';
import {
  attributeSpringUpthrustV11,
  FROZEN_SPEC_SHA256,
} from './tradeSignalModelAV11.mjs';

const timeframeSeconds = 60;

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function fixture({
  type = 'spring',
  eventIndex = 25,
  tiedIndices = [10],
  poolSpecs,
  asOfIndex = eventIndex + 1,
  includeSweep = false,
  sweepOverrides = {},
  confirmedSweeps: sweepInputs,
} = {}) {
  const candles = Array.from({ length: eventIndex + 2 }, (_, index) => ({
    epoch: index * timeframeSeconds,
    open: 15,
    high: 20,
    low: 12,
    close: 15,
  }));
  const isSpring = type === 'spring';
  for (const index of tiedIndices) {
    if (isSpring) candles[index].low = 10;
    else candles[index].high = 30;
  }
  if (isSpring) {
    candles[eventIndex] = { ...candles[eventIndex], low: 9, close: 11 };
    candles[eventIndex + 1] = { ...candles[eventIndex + 1], close: 12 };
  } else {
    candles[eventIndex] = { ...candles[eventIndex], high: 31, close: 29 };
    candles[eventIndex + 1] = { ...candles[eventIndex + 1], high: 30, close: 28 };
  }
  const kind = isSpring ? 'low' : 'high';
  const side = isSpring ? 'sell' : 'buy';
  const boundary = isSpring ? 10 : 30;
  const pools = (poolSpecs ?? [{
    id: 'pool-A',
    side,
    level: boundary,
    constituentIndices: tiedIndices,
  }]).map((spec) => ({
    id: spec.id,
    side: spec.side ?? side,
    level: spec.level ?? boundary,
    status: spec.status ?? 'active',
    pending: spec.pending ?? null,
    constituentPivots: (spec.constituentIndices ?? []).map((index, ordinal) => ({
      id: `${spec.id}-pivot-${ordinal}`,
      index,
      kind,
      price: boundary,
      confirmationIndex: index + 3,
    })),
  }));
  const poolSnapshot = deepFreeze({ asOfIndex: eventIndex - 1, pools });
  const event = {
    id: `fixture-${type}-${eventIndex}`,
    type,
    eventIndex,
    windowStartIndex: eventIndex - 20,
    confirmationIndex: eventIndex + 1,
  };
  const extreme = isSpring ? candles[eventIndex].low : candles[eventIndex].high;
  const sweeps = includeSweep
    ? [{
      id: 'sweep-A',
      poolId: 'pool-A',
      side,
      candidateIndex: eventIndex,
      confirmationIndex: eventIndex + 1,
      extreme,
      confirmed: true,
      eligible: true,
      invalidated: false,
      retired: false,
      ...sweepOverrides,
    }]
    : [];
  return {
    candles,
    timeframeSeconds,
    asOfIndex,
    event,
    poolSnapshot,
    confirmedSweeps: sweepInputs ?? sweeps,
  };
}

function run(options) {
  return attributeSpringUpthrustV11(options);
}

test('records the frozen v1 and v1.1 SHA-256 identifiers', () => {
  assert.deepEqual(FROZEN_SPEC_SHA256, {
    v1: 'f4b226cfe8b970b77085d5fcc3288ebb693797f0c9c2c6a975c1cce6a8de5a86',
    v1_1: '58a441faf5495714d2e22b4136a8eb9431a5be16e63c3bfd54f2dbdac2fb4ab7',
    v1_2: '27c53e2dcfb75d68697dccac8d486f2168867d73ffca53c7b4536eb9cad9798f',
  });

});

test('only active non-pending pools at the preceding close qualify under v1.2', () => {
  for (const [status, pending, attributed] of [
    ['active', null, true], ['swept', null, false], ['invalidated', null, false],
    ['expired', null, false], ['active', { index: 24 }, false],
  ]) {
    const input = fixture({ poolSpecs: [{ id: 'pool-A', constituentIndices: [10], status, pending }] });
    const result = run(input);
    assert.equal(result.springUpthrustConfirmed, true, `${status} spring remains independently confirmed`);
    assert.equal(result.poolAttributed, attributed, `${status} pending=${Boolean(pending)}`);
  }
});

test('retains every qualifying tied spring boundary pivot, not a non-pivot tie', () => {
  const result = run(fixture({ tiedIndices: [10, 11, 18] }));
  assert.equal(result.springUpthrustConfirmed, true);
  assert.equal(result.poolAttributed, true);
  assert.deepEqual(result.qualifyingConstituents, ['pool-A-pivot-0', 'pool-A-pivot-2']);
});

test('applies the same tied-constituent rule symmetrically to an upthrust', () => {
  const result = run(fixture({ type: 'upthrust', tiedIndices: [10, 18] }));
  assert.equal(result.springUpthrustConfirmed, true);
  assert.equal(result.poolAttributed, true);
  assert.deepEqual(result.qualifyingConstituents, ['pool-A-pivot-0', 'pool-A-pivot-1']);
});

test('uses full-context strict-left pivot checks at the left edge of the 20-bar window', () => {
  const input = fixture({ tiedIndices: [5] });
  input.candles[4].low = 9;
  const result = run(input);
  assert.equal(result.springUpthrustConfirmed, true);
  assert.equal(result.poolAttributed, false);
  assert.ok(result.diagnostics.some(({ code }) => code === 'no-qualifying-pool-constituent'));
});

test('rejects the earliest bar of an equal-extreme run when its left neighbor ties', () => {
  const input = fixture({ tiedIndices: [5] });
  input.candles[4].low = 10;
  const result = run(input);
  assert.equal(result.boundaryCandidates.length, 0);
  assert.equal(result.poolAttributed, false);
});

test('does not use a right-edge pivot before its order-3 confirmation close', () => {
  const result = run(fixture({ tiedIndices: [22] }));
  assert.equal(result.poolAttributed, false);
});

test('supports two qualifying equal extrema more than one lookback apart in separate setups', () => {
  const first = run(fixture({ tiedIndices: [10] }));
  const second = run(fixture({ eventIndex: 50, tiedIndices: [35] }));
  assert.deepEqual(first.qualifyingConstituents, ['pool-A-pivot-0']);
  assert.deepEqual(second.qualifyingConstituents, ['pool-A-pivot-0']);
});

test('requires exact pool-level equality and keeps one-tick-off pools unattributed', () => {
  const exact = run(fixture());
  const offByOneTick = run(fixture({
    poolSpecs: [{
      id: 'pool-A',
      level: 10.01,
      constituentIndices: [10],
    }],
  }));
  assert.equal(exact.poolAttributed, true);
  assert.equal(offByOneTick.poolAttributed, false);
  assert.equal(offByOneTick.poolId, null);
});

test('reports multiple passing pools as ambiguous instead of choosing one', () => {
  const result = run(fixture({
    poolSpecs: [
      { id: 'pool-A', constituentIndices: [10] },
      { id: 'pool-B', constituentIndices: [10] },
    ],
  }));
  assert.equal(result.poolAttributed, false);
  assert.equal(result.poolId, null);
  assert.deepEqual(result.attributionCandidates.map(({ poolId }) => poolId), ['pool-A', 'pool-B']);
  assert.ok(result.diagnostics.some(({ code }) => code === 'pool-attribution-ambiguous'));
});

test('retains a confirmed spring independently when no pool passes attribution', () => {
  const result = run(fixture({ poolSpecs: [] }));
  assert.equal(result.springUpthrustConfirmed, true);
  assert.equal(result.poolAttributed, false);
  assert.equal(result.poolId, null);
  assert.deepEqual(result.boundaryCandidates.map(({ index }) => index), [10]);
});

test('requires strict candidate and next-close confirmation with equality rejected', () => {
  const candidateEquality = fixture();
  candidateEquality.candles[25].low = 10;
  const confirmationEquality = fixture();
  confirmationEquality.candles[26].low = 10;
  confirmationEquality.candles[26].close = 10;
  const candidateResult = run(candidateEquality);
  const confirmationResult = run(confirmationEquality);
  assert.equal(candidateResult.springUpthrustConfirmed, false);
  assert.ok(candidateResult.diagnostics.some(({ code }) => code === 'strict-pattern-candidate-failed'));
  assert.equal(confirmationResult.springUpthrustConfirmed, false);
  assert.ok(confirmationResult.diagnostics.some(({ code }) => (
    code === 'strict-next-close-confirmation-failed'
  )));
});

test('fails closed when the immediate confirmation candle is unavailable as of decision time', () => {
  const input = fixture({ asOfIndex: 25 });
  const result = run(input);
  assert.equal(result.springUpthrustConfirmed, false);
  assert.ok(result.diagnostics.some(({ code }) => code === 'event-not-available-as-of'));
});

test('admits pool-sweep evidence only for a separately supplied same-group sweep', () => {
  const result = run(fixture({ includeSweep: true }));
  assert.equal(result.poolAttributed, true);
  assert.equal(result.poolSweepEvidence, true);
  assert.equal(result.poolSweepId, 'sweep-A');
});

test('matches an upthrust only to its separately confirmed buy-side same-group sweep', () => {
  const result = run(fixture({
    type: 'upthrust',
    includeSweep: true,
    sweepOverrides: { id: 'sweep-buy' },
  }));
  assert.equal(result.poolAttributed, true);
  assert.equal(result.poolSweepEvidence, true);
  assert.equal(result.poolSweepId, 'sweep-buy');
});

test('fails closed with explicit diagnostics when the pool snapshot or sweep inputs are absent', () => {
  const input = fixture({ includeSweep: true });
  const noSnapshot = run({ ...input, poolSnapshot: undefined });
  const noSweepInputs = run({ ...fixture(), confirmedSweeps: undefined });
  assert.equal(noSnapshot.springUpthrustConfirmed, true);
  assert.equal(noSnapshot.poolAttributed, false);
  assert.equal(noSnapshot.poolSweepEvidence, false);
  assert.ok(noSnapshot.diagnostics.some(({ code }) => code === 'pool-snapshot-missing'));
  assert.ok(noSweepInputs.diagnostics.some(({ code }) => code === 'confirmed-sweep-inputs-missing'));
});

test('rejects mutable or differently dated point-in-time pool snapshots', () => {
  const input = fixture();
  const mutableSnapshot = {
    asOfIndex: input.event.eventIndex - 1,
    pools: input.poolSnapshot.pools,
  };
  const mutableResult = run({ ...input, poolSnapshot: mutableSnapshot });
  const staleSnapshot = deepFreeze({ asOfIndex: input.event.eventIndex - 2, pools: [] });
  const staleResult = run({ ...input, poolSnapshot: staleSnapshot });
  assert.ok(mutableResult.diagnostics.some(({ code }) => code === 'pool-snapshot-not-immutable'));
  assert.ok(staleResult.diagnostics.some(({ code }) => code === 'pool-snapshot-as-of-or-shape-invalid'));
});

test('requires pool state frozen at the close immediately before the candidate candle', () => {
  const input = fixture();
  assert.equal(input.poolSnapshot.asOfIndex, input.event.eventIndex - 1);
  assert.equal(input.asOfIndex, input.event.eventIndex + 1);
  assert.equal(run(input).poolAttributed, true);
});

test('does not infer sweep IDs or accept a same-candle, wrong-pool, side, or extreme sweep', () => {
  for (const override of [
    { id: undefined },
    { poolId: 'other-pool' },
    { side: 'buy' },
    { extreme: 8 },
    { confirmationIndex: 25 },
    { confirmed: false },
    { eligible: false },
  ]) {
    const result = run(fixture({ includeSweep: true, sweepOverrides: override }));
    assert.equal(result.poolSweepEvidence, false);
    assert.equal(result.poolSweepId, null);
  }
});

test('fails pool attribution and sweep evidence when a matching eligible sweep lacks its ID', () => {
  for (const missingId of [undefined, '']) {
    const result = run(fixture({
      includeSweep: true,
      sweepOverrides: { id: missingId },
    }));
    assert.equal(result.poolAttributed, false);
    assert.equal(result.poolId, null);
    assert.equal(result.poolSweepEvidence, false);
    assert.equal(result.poolSweepId, null);
    assert.ok(result.diagnostics.some(({ code }) => (
      code === 'matching-confirmed-sweep-identity-missing'
    )));
  }
});

test('allows an absent sweep to leave exact pool attribution intact', () => {
  const result = run(fixture({ confirmedSweeps: [] }));
  assert.equal(result.poolAttributed, true);
  assert.equal(result.poolId, 'pool-A');
  assert.equal(result.poolSweepEvidence, false);
  assert.ok(result.diagnostics.some(({ code }) => code === 'pool-sweep-not-present'));
});

test('ignores future-appended ties and produces the same as-of decision', () => {
  const original = fixture();
  const before = run(original);
  const appended = original.candles.concat(
    Array.from({ length: 5 }, (_, offset) => ({
      epoch: (original.candles.length + offset) * timeframeSeconds,
      open: 15,
      high: 20,
      low: 10,
      close: 15,
    })),
  );
  const after = run({ ...original, candles: appended });
  assert.deepEqual(after, before);
});
