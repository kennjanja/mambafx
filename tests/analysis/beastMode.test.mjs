import test from 'node:test';
import assert from 'node:assert/strict';
import { combine, openBeast, updateBeast, summarize, progress, MIN_REMAINING_SEC } from '../../src/analysis/beastMode.js';

// Synthetic inputs only: these tests check the combination and scoring rules, not market behaviour.
const bz = (o = {}) => ({ direction: 'Rise', ok: true, durationSec: 180, duration: '3m', strength: 0.7, decisionTs: 1000, ...o });
const ts = (dir, o = {}) => ({ status: 'signal', dir, holdSec: 180, profileName: 'Scalp', headline: 'h', trigger: { kind: 'pullback', label: 'x' }, target: { price: 102 }, invalidation: { price: 99 }, ...o });

test('combine: beast only when Bazu is tradable and a trade signal agrees', () => {
  assert.equal(combine(bz(), [ts(1)]).state, 'beast');
  assert.equal(combine(bz({ direction: 'Fall' }), [ts(-1)]).dir, -1);
  assert.equal(combine(bz(), [ts(-1)]).state, 'conflict');
  assert.equal(combine(bz(), [{ status: 'watching', dir: 1 }]).state, 'bazu-only');
  assert.equal(combine(bz({ ok: false }), [ts(1)]).state, 'trade-only');
  assert.equal(combine(null, [{ status: 'watching', dir: 1 }]).state, 'watching');
  assert.equal(combine(null, []).state, 'none');
});

test('combine picks the agreeing profile whose hold is closest to the Bazu duration', () => {
  const c = combine(bz({ durationSec: 1700 }), [ts(1, { holdSec: 180, profileName: 'Scalp' }), ts(1, { holdSec: 1800, profileName: 'Intraday' }), ts(-1, { holdSec: 1700 })]);
  assert.equal(c.trade.profileName, 'Intraday'); assert.equal(c.agreeing, 2);
});

test('openBeast: only for beast, valid price, and enough time left; window is the Bazu prediction window', () => {
  const c = combine(bz(), [ts(1)]);
  assert.equal(openBeast('R_10', 'V10', { state: 'none' }, bz(), 100, 1010), null);
  assert.equal(openBeast('R_10', 'V10', c, bz(), 0, 1010), null);
  assert.equal(openBeast('R_10', 'V10', c, bz(), 100, 1000 + 180 - MIN_REMAINING_SEC + 1), null);
  const r = openBeast('R_10', 'V10', c, bz(), 100, 1010);
  assert.equal(r.expiresAt, 1180); assert.equal(r.side, 'Rise'); assert.equal(r.target, 102);
});

test('scoring: exit vs entry, a tie loses, SELL mirrors BUY', () => {
  const mk = (dir) => openBeast('R_10', 'V10', combine(bz({ direction: dir === 1 ? 'Rise' : 'Fall' }), [ts(dir)]), bz({ direction: dir === 1 ? 'Rise' : 'Fall' }), 100, 1010);
  let r = mk(1); updateBeast(r, 100.4, 1100); updateBeast(r, 100.5, 1180); assert.equal(r.state, 'correct'); assert.equal(r.exit, 100.5);
  r = mk(1); updateBeast(r, 100, 1179); updateBeast(r, 100, 1181); assert.equal(r.state, 'wrong');
  r = mk(-1); updateBeast(r, 99, 1179); updateBeast(r, 99, 1182); assert.equal(r.state, 'correct');
});

test('target/invalidation first touch is recorded but does not decide the result', () => {
  const r = openBeast('R_10', 'V10', combine(bz(), [ts(1)]), bz(), 100, 1010);
  updateBeast(r, 102.1, 1050); assert.equal(r.touch, 'target');
  updateBeast(r, 98, 1100); assert.equal(r.touch, 'target', 'first touch stays');
  updateBeast(r, 99.5, 1180); assert.equal(r.state, 'wrong');
});

test('a window that lapses without a price near its end is void, not guessed', () => {
  const r = openBeast('R_10', 'V10', combine(bz(), [ts(1)]), bz(), 100, 1010);
  updateBeast(r, 105, 1050);
  updateBeast(r, 106, 1500);   // first sample long after the end
  assert.equal(r.state, 'void');
  const s = summarize([r, { state: 'correct' }, { state: 'wrong' }, { state: 'open' }]);
  assert.deepEqual(s, { open: 1, correct: 1, wrong: 1, void: 1, hitRate: 0.5, n: 2 });
  assert.equal(progress({ openedAt: 0, expiresAt: 100 }, 25), 0.25);
});
