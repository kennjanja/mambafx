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

test('stays open until the lapse even if the target is already touched', () => {
  const r = openTracked(sig(1), T0);
  updateTracked(r, { candles: [bar(1, 102.5, 100, 102)], nowSec: T0 + 600 });
  assert.equal(r.state, 'open'); assert.equal(r.hit, 'correct');
  updateTracked(r, { candles: [bar(1, 102.5, 100, 102)], nowSec: T0 + HORIZON_SEC });
  assert.equal(r.state, 'correct');
});

test('invalidation first is wrong; a bar touching both is wrong; SELL mirrors BUY', () => {
  let r = openTracked(sig(1), T0);
  updateTracked(r, { candles: [bar(1, 100.5, 98.9, 99), bar(2, 103, 99, 102)], nowSec: T0 + HORIZON_SEC });
  assert.equal(r.state, 'wrong');
  r = openTracked(sig(1), T0);
  updateTracked(r, { candles: [bar(1, 103, 98.5, 100)], nowSec: T0 + HORIZON_SEC });
  assert.equal(r.state, 'wrong');
  r = openTracked(sig(-1), T0);
  updateTracked(r, { candles: [bar(1, 100.2, 97.9, 98)], nowSec: T0 + HORIZON_SEC });
  assert.equal(r.state, 'correct');
});

test('bars before or at the open bar, and after the lapse, are ignored', () => {
  const r = openTracked(sig(1), T0);
  updateTracked(r, { candles: [bar(0, 110, 90, 100), bar(7, 110, 90, 100)], nowSec: T0 + HORIZON_SEC });
  assert.equal(r.hit, 'none');
});

test('no touch: scored by direction of the last price', () => {
  let r = openTracked(sig(1), T0);
  updateTracked(r, { candles: [bar(1, 101, 99.5, 100.6)], nowSec: T0 + HORIZON_SEC });
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
  assert.equal(r.state, 'wrong');
  // a target already touched keeps its result (no exit override)
  r = openTracked(sig(1), T0);
  updateTracked(r, { price: 103, nowSec: T0 + 30 });
  updateTracked(r, { price: 101, nowSec: T0 + 60, reversal: { epoch: T0 + 50, label: 'x' } });
  assert.equal(r.state, 'open'); assert.equal(r.hit, 'correct');
});