import test from 'node:test';
import assert from 'node:assert/strict';
import * as N from '../../src/analysis/overlays.js';
import * as L from './legacy-overlays.js';

function rng(seed) { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }
function walk(n, seed, vol = 1) {
  const r = rng(seed); let p = 1000; const out = [];
  for (let i = 0; i < n; i++) {
    const o = p; const c = o + (r() - 0.5) * 4 * vol;
    const h = Math.max(o, c) + r() * 2 * vol; const l = Math.min(o, c) - r() * 2 * vol;
    out.push({ epoch: 1700000000 + i * 60, open: o, high: h, low: l, close: c }); p = c;
  }
  return out;
}
const flat = Array.from({ length: 60 }, (_, i) => ({ epoch: i, open: 100, high: 100, low: 100, close: 100 }));
const big = walk(200, 7, 50);
const fixtures = { normal: walk(50, 1), long: walk(500, 2), short: walk(5, 3), empty: [], flat, big, other: walk(120, 9, 3) };

for (const name of Object.keys(N).filter(k => typeof N[k] === 'function')) {
  test(`parity: ${name}`, () => {
    for (const [fx, arr] of Object.entries(fixtures)) {
      const copy = JSON.parse(JSON.stringify(arr));
      const args = name === 'findSwings' ? [copy, 2] : name === 'clusterLevels' ? null : [copy];
      if (!args) continue;
      assert.deepEqual(N[name](...args), L[name](...JSON.parse(JSON.stringify(args))), `${name} on ${fx}`);
      assert.deepEqual(copy, arr, `${name} must not mutate input (${fx})`);
    }
  });
}

test('parity: clusterLevels', () => {
  const pts = [{ i: 1, price: 100 }, { i: 5, price: 100.5 }, { i: 9, price: 120 }];
  assert.deepEqual(N.clusterLevels(pts, 30), L.clusterLevels(pts, 30));
  assert.deepEqual(N.clusterLevels([], 1), L.clusterLevels([], 1));
});

test('exports cover all 13 legacy functions', () => {
  assert.deepEqual(Object.keys(N).sort(), Object.keys(L).sort());
  assert.equal(Object.keys(N).length, 13);
});
