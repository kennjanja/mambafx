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

test('stay-above rule: staying above the entry to the lapse wins, even if the target was never reached', () => {
  const r = openTracked(sig(1), T0);
  updateTracked(r, { candles: [bar(1, 100.8, 100.1, 100.4)], nowSec: T0 + 600 });
  assert.equal(r.state, 'open'); assert.equal(r.hit, null);
  updateTracked(r, { candles: [bar(1, 100.8, 100.1, 100.4)], nowSec: T0 + HORIZON_SEC });
  assert.equal(r.state, 'correct'); assert.equal(r.targetHit, false);
});

test('going below the entry at any time loses, even if the target was touched and price recovered; SELL mirrors', () => {
  let r = openTracked(sig(1), T0);
  updateTracked(r, { candles: [bar(1, 100.5, 99.99, 100.4), bar(2, 103, 100.5, 102)], nowSec: T0 + HORIZON_SEC });
  assert.equal(r.state, 'wrong'); assert.equal(r.hit, 'wrong'); assert.equal(r.targetHit, true);
  r = openTracked(sig(1), T0);
  updateTracked(r, { candles: [bar(1, 103, 100, 102)], nowSec: T0 + HORIZON_SEC });   // touching the entry exactly is not below it
  assert.equal(r.state, 'correct'); assert.equal(r.targetHit, true);
  r = openTracked(sig(-1), T0);
  updateTracked(r, { candles: [bar(1, 100.01, 98, 98.5)], nowSec: T0 + HORIZON_SEC });
  assert.equal(r.state, 'wrong');
  r = openTracked(sig(-1), T0);
  updateTracked(r, { candles: [bar(1, 100, 97.9, 98)], nowSec: T0 + HORIZON_SEC });
  assert.equal(r.state, 'correct');
});

test('a loss is recorded immediately but the record resolves at the lapse', () => {
  const r = openTracked(sig(1), T0);
  updateTracked(r, { price: 99.9, nowSec: T0 + 60 });
  assert.equal(r.state, 'open'); assert.equal(r.hit, 'wrong');
  updateTracked(r, { price: 101, nowSec: T0 + HORIZON_SEC });
  assert.equal(r.state, 'wrong');
});
test('bars before or at the open bar, and after the lapse, are ignored', () => {
  const r = openTracked(sig(1), T0);
  updateTracked(r, { candles: [bar(0, 110, 90, 100), bar(7, 110, 90, 100)], nowSec: T0 + HORIZON_SEC });
  assert.equal(r.hit, 'none');
});

test('no touch: scored by direction of the last price', () => {
  let r = openTracked(sig(1), T0);
  updateTracked(r, { candles: [bar(1, 101, 100.2, 100.6)], nowSec: T0 + HORIZON_SEC });
  assert.equal(r.state, 'correct');
  r = openTracked(sig(1), T0);
  updateTracked(r, { candles: [bar(1, 100.5, 99.5, 99.7)], nowSec: T0 + HORIZON_SEC });
  assert.equal(r.state, 'wrong');
});

test('a price sample can resolve a hit; resolved records do not change; progress and summary', () => {
  const r = openTracked(sig(1), T0);
  updateTracked(r, { price: 99, nowSec: T0 + 60 });
  assert.equal(r.hit, 'wrong');
  assert.equal(progress(r, T0 + HORIZON_SEC / 2), 0.5);
  updateTracked(r, { nowSec: T0 + HORIZON_SEC });
  assert.equal(r.state, 'wrong');
  updateTracked(r, { candles: [bar(2, 105, 100, 105)], nowSec: T0 + HORIZON_SEC + 5 });
  assert.equal(r.state, 'wrong');
  const ok = { state: 'correct' };
  assert.deepEqual(summarize([r, ok, { state: 'open' }]), { open: 1, resolved: 2, correct: 1, wrong: 1, hitRate: 0.5 });
});

test('profile hold time and early exit on opposing reversal', () => {
  let r = openTracked(sig(1, { profile: 'scalp', holdSec: 180, entryG: 180, holdLabel: '3 min', exitOn: 'upthrust' }), T0);
  assert.equal(r.expiresAt, T0 + 180); assert.equal(r.profile, 'scalp');
  // reversal that formed before the open is ignored
  updateTracked(r, { price: 100.5, nowSec: T0 + 30, reversal: { epoch: T0 - 60, label: 'upthrust' } });
  assert.equal(r.state, 'open');
  // reversal after the open exits early; scored by price direction
  updateTracked(r, { price: 100.5, nowSec: T0 + 60, reversal: { epoch: T0 + 40, label: 'upthrust' } });
  assert.equal(r.state, 'correct'); assert.equal(r.hit, 'exit'); assert.equal(r.exitReason, 'upthrust');
  r = openTracked(sig(1), T0);
  updateTracked(r, { price: 99.5, nowSec: T0 + 60, reversal: { epoch: T0 + 40, label: 'x' } });
  assert.equal(r.state, 'open'); assert.equal(r.hit, 'wrong');   // already lost, resolves at the lapse
  r = openTracked(sig(1), T0);
  updateTracked(r, { price: 100, nowSec: T0 + 60, reversal: { epoch: T0 + 40, label: 'x' } });
  assert.equal(r.state, 'wrong');   // level with the entry is not above it
  // already below the entry: an exit does not override the loss
  r = openTracked(sig(1), T0);
  updateTracked(r, { price: 99.5, nowSec: T0 + 30 });
  updateTracked(r, { price: 101, nowSec: T0 + 60, reversal: { epoch: T0 + 50, label: 'x' } });
  assert.equal(r.state, 'open'); assert.equal(r.hit, 'wrong');
});