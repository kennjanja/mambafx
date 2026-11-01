import test from 'node:test';
import assert from 'node:assert/strict';
import { openTracked, updateTracked, progress, summarize, HORIZON_SEC } from '../../src/analysis/tradeSignalTracker.js';

// Synthetic data only: these tests check the scoring rules, not market behaviour.
const sig = (dir, o = {}) => ({ status: 'signal', symbol: 'R_100', label: 'V100', dir, action: dir === 1 ? 'BUY' : 'SELL', headline: 'h',
  price: 100, target: { price: dir === 1 ? 102 : 98 }, invalidation: { price: dir === 1 ? 99 : 101 }, ...o });
const T0 = 1000 * 300 + 120;                 // 2 min into a 5 min bar
const bar = (k, hi, lo, close) => ({ epoch: 1000 * 300 + 300 * k, open: 100, high: hi, low: lo, close });

test('only real signals open a record', () => {
  assert.equal(openTracked({ status: 'wait' }, T0), null);
  assert.equal(openTracked(sig(1, { price: 0 }), T0), null);
  const r = openTracked(sig(1), T0);
  assert.equal(r.expiresAt, T0 + HORIZON_SEC);
});

test('end-of-window rule: only the last price at the lapse decides; the target does not matter', () => {
  const r = openTracked(sig(1), T0);
  updateTracked(r, { candles: [bar(1, 100.8, 100.1, 100.4)], nowSec: T0 + 600 });
  assert.equal(r.state, 'open');
  updateTracked(r, { candles: [bar(1, 100.8, 100.1, 100.4)], nowSec: T0 + HORIZON_SEC });
  assert.equal(r.state, 'correct'); assert.equal(r.targetHit, false);
});

test('dipping below the entry mid-window does not lose if the period ends above it; SELL mirrors', () => {
  let r = openTracked(sig(1), T0);
  updateTracked(r, { candles: [bar(1, 100.5, 98, 99), bar(2, 101, 99.5, 100.6)], nowSec: T0 + HORIZON_SEC });
  assert.equal(r.state, 'correct'); assert.equal(r.hit, 'none');
  r = openTracked(sig(1), T0);
  updateTracked(r, { candles: [bar(1, 103, 100.5, 102), bar(2, 102, 99, 99.5)], nowSec: T0 + HORIZON_SEC });
  assert.equal(r.state, 'wrong'); assert.equal(r.targetHit, true);
  r = openTracked(sig(-1), T0);
  updateTracked(r, { candles: [bar(1, 102, 99, 101), bar(2, 100, 99, 99.4)], nowSec: T0 + HORIZON_SEC });
  assert.equal(r.state, 'correct');
  r = openTracked(sig(-1), T0);
  updateTracked(r, { candles: [bar(1, 100.5, 97, 98), bar(2, 101, 99, 100.3)], nowSec: T0 + HORIZON_SEC });
  assert.equal(r.state, 'wrong');
});

test('finishing exactly at the entry loses; samples before the lapse never resolve', () => {
  let r = openTracked(sig(1), T0);
  updateTracked(r, { price: 99, nowSec: T0 + 60 });
  assert.equal(r.state, 'open');
  updateTracked(r, { price: 100, nowSec: T0 + HORIZON_SEC });
  assert.equal(r.state, 'wrong');
  r = openTracked(sig(-1), T0);
  updateTracked(r, { price: 100.01, nowSec: T0 + 60 });
  updateTracked(r, { price: 99.9, nowSec: T0 + HORIZON_SEC });
  assert.equal(r.state, 'correct');
});

test('bars before or at the open bar, and after the lapse, are ignored', () => {
  const r = openTracked(sig(1), T0);
  updateTracked(r, { candles: [bar(0, 110, 90, 100), bar(7, 110, 90, 100)], nowSec: T0 + HORIZON_SEC });
  assert.equal(r.hit, 'none'); assert.equal(r.state, 'wrong');
});

test('resolved records do not change; progress and summary', () => {
  const r = openTracked(sig(1), T0);
  updateTracked(r, { price: 99, nowSec: T0 + HORIZON_SEC });
  assert.equal(r.state, 'wrong');
  assert.equal(progress(r, T0 + HORIZON_SEC / 2), 0.5);
  updateTracked(r, { candles: [bar(2, 105, 100, 105)], nowSec: T0 + HORIZON_SEC + 5 });
  assert.equal(r.state, 'wrong');
  assert.deepEqual(summarize([r, { state: 'correct' }, { state: 'open' }]), { open: 1, resolved: 2, correct: 1, wrong: 1, hitRate: 0.5 });
});

test('profile hold time; an opposing reversal no longer ends the signal early', () => {
  const r = openTracked(sig(1, { profile: 'scalp', holdSec: 180, entryG: 180, holdLabel: '3 min', exitOn: 'upthrust' }), T0);
  assert.equal(r.expiresAt, T0 + 180); assert.equal(r.profile, 'scalp');
  updateTracked(r, { price: 100.5, nowSec: T0 + 60, reversal: { epoch: T0 + 40, label: 'upthrust' } });
  assert.equal(r.state, 'open');
  updateTracked(r, { price: 100.5, nowSec: T0 + 180 });
  assert.equal(r.state, 'correct');
});
