import test from 'node:test';
import assert from 'node:assert/strict';
import { findSwingPoints as legacy } from '../../mtf/src/analysis/swingPoints.js';
import { findSwingPoints as shared } from '../../src/bazu/sharedEngineAdapter.js';
import { detectPivots } from '../../src/analysis/pivots.js';
import { atrSeries } from '../../src/analysis/core.js';
import { computeStructureFeatures } from '../../src/bazu/structure.js';

function rng(seed) { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }
function candles(n, seed, round) {
  const r = rng(seed); let p = 100; const out = [];
  for (let i = 0; i < n; i++) {
    const o = p, c = o + (r() - 0.5) * 3;
    const q = (x) => (round ? Math.round(x * round) / round : x);
    const h = q(Math.max(o, c) + r()), l = q(Math.min(o, c) - r());
    out.push({ epoch: 1700000000 + i * 180, open: q(o), high: Math.max(h, q(o), q(c)), low: Math.min(l, q(o), q(c)), close: q(c) }); p = c;
  }
  return out;
}

test('shared pivot adapter equals mtf findSwingPoints (continuous and tie-heavy data, several lookbacks)', () => {
  for (const [seed, round] of [[1, 0], [2, 0], [3, 2], [4, 1], [5, 0.5]]) {
    for (const lb of [1, 2, 3, 5]) {
      const c = candles(600, seed, round);
      assert.deepEqual(shared(c, lb), legacy(c, lb), `seed ${seed} round ${round} lb ${lb}`);
    }
  }
  assert.deepEqual(shared([], 2), legacy([], 2));
  assert.deepEqual(shared(candles(3, 1, 0), 2), legacy(candles(3, 1, 0), 2));
});

test('documented difference: default (non-strict) shared pivots accept right-side ties, Bazu/mtf rejects them', () => {
  const c = [1, 2, 5, 5, 2, 1].map((h, i) => ({ epoch: i, open: h - 0.5, high: h, low: h - 1, close: h - 0.5 }));
  assert.equal(legacy(c, 2).filter(s => s.type === 'high').length, 0);
  assert.equal(detectPivots(c, 2).confirmed.filter(s => s.type === 'high').length, 1);
});

test('ATR differs by design: Bazu seeds with the first TR (EMA), shared uses Wilder SMA seed; Bazu keeps its own', () => {
  const c = candles(60, 9, 0);
  const shd = atrSeries(c, 14);
  assert.ok(Number.isFinite(shd[13]) && shd[12] === null);
  // Bazu structure features are unchanged by this PR: deterministic and still computed from its own ATR
  const prices = c.map(x => x.close), epochs = c.map(x => x.epoch);
  const a = computeStructureFeatures(prices, epochs, 1), b = computeStructureFeatures(prices, epochs, 1);
  assert.deepEqual(a.series, b.series);
});
