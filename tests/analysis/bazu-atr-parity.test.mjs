import test from 'node:test';
import assert from 'node:assert/strict';
import { wilderAtr } from '../../src/bazu/crt3m.js';
import { atrSeries } from '../../src/analysis/core.js';

// Frozen copy of the pre-unification Bazu implementation (parity oracle; do not edit).
function legacyWilderAtr(candles, period) {
  const result = Array(candles.length).fill(null);
  if (candles.length < period) return result;
  const br = (b) => b.high - b.low;
  const tr = candles.map((c, i) => {
    if (i === 0) return br(c);
    const pc = candles[i - 1].close;
    return Math.max(br(c), Math.abs(c.high - pc), Math.abs(c.low - pc));
  });
  let atr = tr.slice(0, period).reduce((s, v) => s + v, 0) / period;
  result[period - 1] = atr;
  for (let i = period; i < tr.length; i++) { atr = ((atr * (period - 1)) + tr[i]) / period; result[i] = atr; }
  return result;
}
function rng(seed) { let s = seed; return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296; }
function walk(seed, n) {
  const r = rng(seed); let p = 100; const out = [];
  for (let i = 0; i < n; i++) { const o = p; p += (r() - 0.5) * 3; out.push({ epoch: 1e9 + i * 180, open: o, high: Math.max(o, p) + r(), low: Math.min(o, p) - r(), close: p }); }
  return out;
}

test('shared Wilder ATR is bit-identical to the legacy Bazu ATR', () => {
  for (const seed of [1, 2, 3, 4, 5]) for (const n of [0, 1, 5, 14, 15, 60, 400]) for (const period of [1, 5, 14, 20]) {
    const c = walk(seed, n);
    assert.deepEqual(atrSeries(c, period), legacyWilderAtr(c, period), `seed ${seed} n ${n} p ${period}`);
    assert.deepEqual(wilderAtr(c, period), legacyWilderAtr(c, period));
  }
});
test('Bazu wrapper keeps its validation contract', () => {
  assert.throws(() => wilderAtr(walk(1, 30), 0), RangeError);
  assert.throws(() => wilderAtr(walk(1, 30), 1.5), RangeError);
  const bad = walk(1, 30); bad[3] = { ...bad[3], close: NaN };
  assert.throws(() => wilderAtr(bad, 14), TypeError);
  const inv = walk(1, 30); inv[3] = { ...inv[3], high: 1, low: 2 };
  assert.throws(() => wilderAtr(inv, 14), TypeError);
});
