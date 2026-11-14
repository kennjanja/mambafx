import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeEvidence } from '../../src/analysis/evidence.js';
import { evaluateEntryModels } from '../../src/analysis/tradeSignalArchitecture.js';

function springCandles(poolLevel) {
  const exactBoundary = poolLevel === 100;
  const candles = Array.from({ length: 72 }, (_, index) =>
    ({ epoch: index * 60, open: 102, high: 103, low: exactBoundary ? 101 : 100, close: 102 }));
  if (exactBoundary) for (const index of [55, 61]) candles[index].low = 100;
  else for (const index of [40, 46]) candles[index].low = poolLevel;
  candles[70] = { ...candles[70], low: 97, close: 101 };
  candles[71] = { ...candles[71], close: 101 };
  return candles;
}

function upthrustCandles(poolLevel) {
  const candles = Array.from({ length: 72 }, (_, index) =>
    ({ epoch: index * 60, open: 99, high: 100, low: 98, close: 99 }));
  for (const index of [40, 46]) candles[index].high = poolLevel;
  candles[70] = { ...candles[70], high: 103, close: 99 };
  candles[71] = { ...candles[71], close: 99 };
  return candles;
}

function modelEvent(candles, index = 70) {
  const evidence = analyzeEvidence(candles, { granularity: 60 });
  const event = evidence.facts.modelEvents.find((item) => item.modelAGroupId
    && item.index === index && item.kind === (item.dir === 1 ? 'spring' : 'upthrust'));
  assert.ok(event, 'production must emit the next-close-confirmed Model A group');
  return { evidence, event };
}

function evaluateLocation(event, location) {
  return evaluateEntryModels({ events: [event,
    { type: 'displacement', dir: event.dir, index: 72, startIndex: 72, confirmedIndex: 72, id: 'D1' },
    { type: 'structure-shift', dir: event.dir, index: 73, confirmedIndex: 73, id: 'CH1', displacementIndex: 72 }],
  biasDirection: event.dir, entryDirection: event.dir, marketContext: ['range'],
  locations: [{ dir: event.dir, ...location }], asOfIndex: 73 }).candidates.some((candidate) =>
    candidate.model_id === 'A' && candidate.confirmingEvents[0].modelAGroupId === event.groupId);
}

for (const [kind, candlesFor, level] of [
  ['spring', springCandles, 99],
  ['upthrust', upthrustCandles, 101],
]) {
  test(`real ${kind} co-sweeps a different-level pool once and applies its own location`, () => {
    const candles = candlesFor(level);
    const before = analyzeEvidence(candles.slice(0, 71), { granularity: 60 });
    assert.equal(before.facts.modelEvents.some((event) => event.modelAGroupId && event.index === 70), false,
      'candidate-time events cannot be emitted before the next-close confirmation');
    const { event } = modelEvent(candles);
    const groupId = JSON.stringify([event.side, 70, 71, kind === 'spring' ? 97 : 103]);
    assert.equal(event.groupId, groupId);
    assert.equal(event.confirmedIndex, 71);
    assert.equal(event.poolAttributed, false);
    assert.equal(event.matchCount, 0);
    assert.equal(event.attributionAmbiguous, true);
    assert.equal(event.poolSweepEventId, null);
    assert.deepEqual(event.coSweptPools.map((pool) => pool.level), [level]);
    assert.equal(event.groupMemberKinds.includes('pool-sweep'), true);
    assert.equal(event.groupMemberKinds.includes(kind), true);
    assert.equal(modelEvent(candles).evidence.facts.modelEvents.filter((item) => item.modelAGroupId === groupId).length, 1,
      'the spring/upthrust and co-swept pool are one Model A setup');
    assert.equal(evaluateLocation(event, { bottom: 99, top: 101 }), true,
      'the directional location contains the spring/upthrust boundary');
    assert.equal(evaluateLocation(event, kind === 'spring'
      ? { bottom: 99, top: 99 } : { bottom: 101, top: 101 }), false,
    'a location containing only the different-level pool cannot qualify the spring/upthrust');
  });
}

test('real exact-boundary pool match remains one attributed Model A setup', () => {
  const { event, evidence } = modelEvent(springCandles(100));
  assert.equal(event.poolAttributed, true);
  assert.equal(event.matchCount, 1);
  assert.equal(event.attributionAmbiguous, false);
  assert.equal(event.poolSnapshotState.status, 'active');
  assert.ok(event.poolSweepEventId);
  assert.equal(event.groupMemberKinds.includes('spring'), true);
  assert.equal(event.groupMemberKinds.includes('pool-sweep'), true);
  assert.equal(evidence.facts.modelEvents.filter((item) => item.modelAGroupId === event.groupId).length, 1);
});
