import test from 'node:test';
import assert from 'node:assert/strict';
import { openTracked, updateTracked, progress, summarize, HORIZON_SEC } from '../../src/analysis/tradeSignalTracker.js';

const sig = (dir, o = {}) => ({ status: 'signal', symbol: 'R_100', label: 'V100', dir, action: dir === 1 ? 'BUY' : 'SELL', headline: 'h',
  price: 100, target: { price: dir === 1 ? 102 : 98 }, invalidation: { price: dir === 1 ? 99 : 101 }, ...o });
const T0 = 1000 * 300 + 120;
const candle = (epoch, hi, lo, close) => ({ epoch, open: 100, high: hi, low: lo, close });
const minuteSeries = (openedAt, expiresAt, close = 101) => {
  const bars = [{ epoch: Math.floor(openedAt / 60) * 60, open: 100, high: 120, low: 80, close: 100 }];
  for (let t = Math.floor(openedAt / 60) * 60 + 60; t + 60 <= expiresAt; t += 60) bars.push(candle(t, 103, 97, close));
  return bars;
};

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
