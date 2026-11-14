import test from 'node:test';
import assert from 'node:assert/strict';
import { computeModelProgress, createFunnel } from '../../src/analysis/tradeSignalProgress.js';

test('model J progress does not combine unrelated or unidentified ranges', () => {
  const events = [
    { type: 'range-established', dir: 0, confirmedIndex: 1, rangeId: 'a' },
    { type: 'sos-or-sow', dir: 1, confirmedIndex: 2, rangeId: 'b' },
    { type: 'lps-or-lpsy', dir: 1, confirmedIndex: 3, rangeId: 'a' },
  ];
  const progress = (input) => computeModelProgress({ events: input, dir: 1 }).models.find((m) => m.id === 'J');
  assert.equal(progress(events).matched, 1);
  assert.equal(progress([...events, { ...events[1], rangeId: 'a' }]).matched, 3);
  assert.equal(progress(events.map(({ rangeId, ...event }) => event)).matched, 0);
});
import { MODEL_REGISTRY } from '../../src/analysis/tradeSignalArchitecture.js';

const modelA = MODEL_REGISTRY[0];
const ev = (type, confirmedIndex, dir = 1) => ({ type, confirmedIndex, dir });

test('no bias lean means no model has progressed', () => {
  const p = computeModelProgress({ events: [ev(modelA.sequence[0], 5)], dir: 0 });
  assert.ok(p.models.every((m) => m.matched === 0));
});

test('progress follows the ordered sequence and names the next step', () => {
  const p = computeModelProgress({ events: [ev(modelA.sequence[0], 5)], dir: 1, hasLocation: true });
  const a = p.models.find((m) => m.id === modelA.model_id);
  assert.equal(a.matched, 1);
  assert.match(a.text, /confirmed, waiting for/);
});

test('out-of-order and opposite-direction events do not count', () => {
  const p = computeModelProgress({ events: [ev(modelA.sequence[1], 2), ev(modelA.sequence[0], 9), ev(modelA.sequence[0], 1, -1)], dir: 1 });
  const a = p.models.find((m) => m.id === modelA.model_id);
  assert.equal(a.matched, 1);
});

test('confirmed model is reported and ranked best', () => {
  const p = computeModelProgress({ events: [], dir: 1, confirmedIds: [modelA.model_id] });
  assert.equal(p.best.id, modelA.model_id);
  assert.match(p.best.text, /confirmed$/);
});

test('funnel counts bias, location, steps, completion without confirmation and per symbol', () => {
  const f = createFunnel();
  const all = modelA.sequence.map((type, i) => ev(type, i));
  f.record('scalp', computeModelProgress({ events: all, dir: 1, hasLocation: false }), 'R_10');
  f.record('scalp', computeModelProgress({ events: [], dir: 0 }), 'R_10');
  f.record('scalp', null, 'R_25');
  const p = f.data.scalp, row = p.models[modelA.model_id];
  assert.equal(p.scans, 3); assert.equal(p.bias, 1); assert.equal(p.notEvaluated, 1);
  assert.equal(row.steps[modelA.sequence.length - 1], 1);
  assert.equal(row.completeNotConfirmed, 1); assert.equal(row.completeNoLocation, 1);
  assert.equal(f.bySymbol['R_10|scalp'].scans, 2);
});
