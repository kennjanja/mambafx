import test from 'node:test';
import assert from 'node:assert/strict';
import { openTracked, updateTracked, progress, summarize, deduplicateOpenRecords, lifecycleMatchesPrediction, HORIZON_SEC } from '../../src/analysis/tradeSignalTracker.js';

const sig = (dir, o = {}) => ({ status: 'signal', symbol: 'R_100', label: 'V100', dir, action: dir === 1 ? 'BUY' : 'SELL', headline: 'h',
  price: 100, target: { price: dir === 1 ? 102 : 98 }, invalidation: { price: dir === 1 ? 99 : 101 }, ...o });
const T0 = 1000 * 300 + 120;
const candle = (epoch, hi, lo, close) => ({ epoch, open: 100, high: hi, low: lo, close });
const minuteSeries = (openedAt, expiresAt, close = 101) => {
  const bars = [{ epoch: Math.floor(openedAt / 60) * 60, open: 100, high: 120, low: 80, close: 100 }];
  for (let t = Math.floor(openedAt / 60) * 60 + 60; t + 60 <= expiresAt; t += 60) bars.push(candle(t, 103, 97, close));
  return bars;
};

test('resolution closes only the lifecycle belonging to the tracked prediction', () => {
  const record = openTracked(sig(1, { profile: 'scalp' }), T0);
  assert.equal(lifecycleMatchesPrediction({ signalId: record.id }, record), true);
  assert.equal(lifecycleMatchesPrediction({ signalId: 'R_100|scalp@1' }, record), false);
  assert.equal(lifecycleMatchesPrediction({}, record), false);
  assert.equal(lifecycleMatchesPrediction(null, record), false);
  assert.equal(lifecycleMatchesPrediction({ signalId: '' }, { id: '' }), false);
});

test('only real signals open a record and exact entry metadata is retained', () => {
  assert.equal(openTracked({ status: 'wait' }, T0), null);
  assert.equal(openTracked(sig(1, { price: 0 }), T0), null);
  const r = openTracked(sig(1, { confirmedAt: T0 - 20, detectedAt: T0 + 2 }), T0);
  assert.equal(r.expiresAt, T0 + HORIZON_SEC); assert.equal(r.detectedAt, T0 + 2); assert.equal(r.entryAt, T0); assert.equal(r.confirmedAt, T0 - 20);
});

test('end-of-window rule uses the post-entry expiry candle; targets are informational', () => {
  const r = openTracked(sig(1), T0), bars = minuteSeries(T0, T0 + HORIZON_SEC, 100.4);
  updateTracked(r, { candles: bars, nowSec: T0 + 600 });
  assert.equal(r.state, 'open');
  updateTracked(r, { candles: bars, nowSec: T0 + HORIZON_SEC });
  assert.equal(r.state, 'correct'); assert.equal(r.hit, 'none'); assert.equal(r.targetHit, true);
  assert.equal(r.resolution_method, 'post-entry-1m-close');
});

test('entry candle is excluded; dips do not lose when the expiry close is favorable; SELL mirrors', () => {
  let r = openTracked(sig(1), T0), bars = minuteSeries(T0, T0 + HORIZON_SEC, 100.6);
  bars[0] = candle(T0, 110, 90, 90); // includes entry-time data and must be excluded
  updateTracked(r, { candles: bars, nowSec: r.expiresAt });
  assert.equal(r.state, 'correct');
  r = openTracked(sig(1), T0); bars = minuteSeries(T0, r.expiresAt, 99.5); bars[bars.length - 1] = candle(bars[bars.length - 1].epoch, 103, 97, 99.5);
  updateTracked(r, { candles: bars, nowSec: r.expiresAt }); assert.equal(r.state, 'wrong');
  r = openTracked(sig(-1), T0); bars = minuteSeries(T0, r.expiresAt, 99.4);
  updateTracked(r, { candles: bars, nowSec: r.expiresAt }); assert.equal(r.state, 'correct');
});

test('ties lose; no early resolution from intermediate samples or reversal hints', () => {
  const r = openTracked(sig(1), T0);
  updateTracked(r, { price: 99, nowSec: T0 + 60, reversal: { epoch: T0 + 40 } }); assert.equal(r.state, 'open');
  updateTracked(r, { price: 100, nowSec: r.expiresAt }); assert.equal(r.state, 'wrong');
});

test('gaps and duplicate expiry candles never fabricate an outcome', () => {
  const r = openTracked(sig(1), T0), bars = minuteSeries(T0, r.expiresAt);
  bars.pop();
  updateTracked(r, { candles: bars, nowSec: r.expiresAt });
  assert.equal(r.state, 'open'); assert.equal(r.resolutionPending, true); assert.equal(r.resolutionIssue, 'missing-expiry-candle');
  const d = openTracked(sig(1), T0), duplicate = minuteSeries(T0, d.expiresAt); duplicate.push({ ...duplicate[duplicate.length - 1], close: 102 });
  updateTracked(d, { candles: duplicate, nowSec: d.expiresAt });
  assert.equal(d.state, 'open'); assert.equal(d.resolutionIssue, 'ambiguous-expiry-candle');
});

test('gapped intermediate data and the candle containing entry are identified; after-expiry data ignored', () => {
  const r = openTracked(sig(1), T0), bars = minuteSeries(T0, r.expiresAt);
  bars.splice(2, 1); bars.unshift(candle(T0, 111, 89, 90)); bars.push(candle(r.expiresAt, 120, 80, 120));
  updateTracked(r, { candles: bars, nowSec: r.expiresAt });
  assert.equal(r.state, 'correct'); assert.ok(r.gaps.length > 0);
});

test('expiry tick is preferred when available and stale expiry samples are not used', () => {
  const r = openTracked(sig(1), T0);
  updateTracked(r, { ticks: [{ epoch: r.expiresAt - 10, quote: 101 }], nowSec: r.expiresAt });
  assert.equal(r.state, 'correct'); assert.equal(r.resolution_method, 'expiry-tick');
  const pending = openTracked(sig(1), T0);
  updateTracked(pending, { ticks: [{ epoch: pending.expiresAt - 45, quote: 101 }], nowSec: pending.expiresAt });
  assert.equal(pending.state, 'open');
});

test('resolved records do not change; progress and summary', () => {
  const r = openTracked(sig(1), T0);
  updateTracked(r, { price: 99, nowSec: r.expiresAt }); assert.equal(r.state, 'wrong');
  assert.equal(progress(r, T0 + HORIZON_SEC / 2), 0.5);
  updateTracked(r, { candles: [candle(r.expiresAt - 60, 105, 100, 105)], nowSec: r.expiresAt + 5 }); assert.equal(r.state, 'wrong');
  assert.deepEqual(summarize([r, { state: 'correct' }, { state: 'open' }]), { open: 1, resolved: 2, correct: 1, wrong: 1, hitRate: 0.5 });
});

test('profile hold time and opposing reversal do not end early', () => {
  const r = openTracked(sig(1, { profile: 'scalp', holdSec: 180, entryG: 180, holdLabel: '3 min', exitOn: 'upthrust' }), T0);
  assert.equal(r.expiresAt, T0 + 180); assert.equal(r.profile, 'scalp');
  updateTracked(r, { price: 100.5, nowSec: T0 + 60, reversal: { epoch: T0 + 40, label: 'upthrust' } }); assert.equal(r.state, 'open');
  updateTracked(r, { price: 100.5, nowSec: r.expiresAt }); assert.equal(r.state, 'correct');
});


test('duplicate active records for a market/profile are collapsed while terminal history remains', () => {
  const records = [{ id: 'a', symbol: 'R_10', profile: 'scalp', state: 'open' }, { id: 'b', symbol: 'R_10', profile: 'scalp', state: 'open' }, { id: 'c', symbol: 'R_10', profile: 'scalp', state: 'correct' }, { id: 'd', symbol: 'R_10', profile: 'swing', state: 'open' }];
  assert.deepEqual(deduplicateOpenRecords(records).map((record) => record.id), ['a', 'c', 'd']);
});

test('open outcome records keep their entry evidence, model and references frozen while advancing', () => {
  const snapshot = [{ sequenceNumber: 1, occurredAt: T0 - 60 }], model = { model_id: 'F', context: 'trend' };
  const record = openTracked(sig(1, { entry: { verdict: 'bullish-lean', balance: 0.4 }, evidenceSnapshot: snapshot, primaryModel: model, target: { price: 102 }, invalidation: { price: 99 } }), T0);
  updateTracked(record, { candles: [candle(T0 + 60, 101)], nowSec: T0 + 60 });
  assert.deepEqual(record.evidenceSnapshot, snapshot);
  assert.deepEqual(record.entryEvidence, { verdict: 'bullish-lean', balance: 0.4 });
  assert.deepEqual(record.primaryModel, model);
  assert.equal(record.target, 102); assert.equal(record.invalidation, 99);
});


test('complete qualification snapshot and finalized outcome survive mutation, reload and repeated resolution', () => {
  const source = sig(1, {
    confirmedAt: T0 - 30, detectedAt: T0 - 10,
    primaryModel: { model_id: 'F', context: 'trend', sequence: [{ type: 'sweep', confirmedAt: T0 - 30 }] },
    secondaryModels: [{ model_id: 'G' }], qualifyingModelIds: ['F', 'G'],
    entry: { verdict: 'bullish-lean', balance: 0.55, families: [{ family: 'liquidity', value: 0.7 }] },
    evidenceSnapshot: [{ group: 'liquidity', occurredAt: T0 - 60, confirmedAt: T0 - 30, label: 'sweep' }],
    familyValues: [{ family: 'liquidity', value: 0.7 }], overallBalance: 0.55,
    inducementEvents: [{ state: 'confirmed', sweepIndex: 9 }],
    lifecycleHistory: [{ to: 'Signal Active', at: T0 - 1 }],
  });
  const record = openTracked(source, T0);
  const entryFields = ['confirmedAt', 'detectedAt', 'entryAt', 'entry', 'dir', 'model_id', 'model_context', 'primaryModel',
    'secondaryModels', 'qualifyingModelIds', 'entryEvidence', 'evidenceSnapshot', 'familyValues', 'overallBalance',
    'target', 'invalidation', 'inducementEvents', 'lifecycleHistory'];
  const frozen = Object.fromEntries(entryFields.map((key) => [key, JSON.parse(JSON.stringify(record[key]))]));
  assert.equal(record.state, 'open');
  assert.equal(record.exitAt, undefined);
  source.primaryModel.sequence[0].confirmedAt = -1;
  source.entry.families[0].value = -1;
  source.evidenceSnapshot[0].label = 'mutated';
  source.inducementEvents[0].state = 'invalid';
  updateTracked(record, { candles: minuteSeries(T0, record.expiresAt, 101), nowSec: T0 + 60 });
  assert.deepEqual(Object.fromEntries(entryFields.map((key) => [key, record[key]])), frozen);
  assert.equal(record.state, 'open');
  assert.equal(record.exitAt, undefined);

  updateTracked(record, { price: 101, nowSec: record.expiresAt });
  assert.equal(record.state, 'correct');
  assert.equal(record.last, 101);
  assert.equal(record.exitAt, record.expiresAt);
  const resolvedOutcome = { state: record.state, last: record.last, exitAt: record.exitAt, resolvedAt: record.resolvedAt };
  const reloaded = JSON.parse(JSON.stringify(record));
  updateTracked(reloaded, { price: 1, nowSec: reloaded.expiresAt + 120 });
  assert.deepEqual({ state: reloaded.state, last: reloaded.last, exitAt: reloaded.exitAt, resolvedAt: reloaded.resolvedAt }, resolvedOutcome);
  assert.deepEqual(Object.fromEntries(entryFields.map((key) => [key, reloaded[key]])), frozen);
});
