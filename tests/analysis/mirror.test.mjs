// Price-reflection invariants. Reflecting prices (p -> C - p, high/low swapped) must:
//   REVERSE: every direction (dir), bullish<->bearish kinds, top<->bottom patterns, evidence balance sign, verdict side
//   KEEP:    event/confirmation indices, counts, timestamps, ATR, regimes, neutral kinds (inside bar, NR, rectangle)
// Price LEVELS reflect (level' = C - level) rather than stay or negate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../../src/analysis/engine.js';
import { analyzePatterns } from '../../src/analysis/patterns.js';
import { analyzeZones } from '../../src/analysis/zones.js';
import { analyzeEvidence } from '../../src/analysis/evidence.js';
import { chartPatterns } from '../../src/analysis/patterns.js';
import { atrSeries } from '../../src/analysis/core.js';
import { detectPivots } from '../../src/analysis/pivots.js';

const K = (o, h, l, c, i) => ({ epoch: 1.7e9 + i * 60, open: o, high: h, low: l, close: c });
function rng(seed) { let s = seed; return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296; }
function walk(seed, n) {
  const r = rng(seed); let p = 100; const out = [];
  for (let i = 0; i < n; i++) { const o = p; p += (r() - 0.5) * 2 + Math.sin(i / 11) * 0.8; out.push(K(o, Math.max(o, p) + r() * 0.6, Math.min(o, p) - r() * 0.6, p, i)); }
  return out;
}
const mirror = (d, C = 200) => d.map((c, i) => K(C - c.open, C - c.low, C - c.high, C - c.close, i));
const flipKind = (k) => k
  .replace('inverse-head-shoulders', '@ihs').replace('head-shoulders', 'inverse-head-shoulders').replace('@ihs', 'head-shoulders')
  .replace('top', '@t').replace('bottom', 'top').replace('@t', 'bottom')
  .replace('ascending', '@a').replace('descending', 'ascending').replace('@a', 'descending')
  .replace('rising', '@r').replace('falling', 'rising').replace('@r', 'falling');
const flipName = (k) => ({ hammer: 'shooting-star', 'shooting-star': 'hammer', spring: 'upthrust', upthrust: 'spring', SOS: 'SOW', SOW: 'SOS' }[k] ?? k);
const sortKey = (a) => a.sort();
const SEEDS = Array.from({ length: 120 }, (_, i) => i + 1);

test('pivots mirror: type flips, index and confirmation unchanged', () => {
  for (const s of SEEDS) {
    const d = walk(s, 240), a = detectPivots(d, 3).confirmed, b = detectPivots(mirror(d), 3).confirmed;
    assert.deepEqual(sortKey(a.map((p) => `${p.type === 'high' ? 'L' : 'H'}${p.index}/${p.confirmedIndex}`)), sortKey(b.map((p) => `${p.type === 'high' ? 'H' : 'L'}${p.index}/${p.confirmedIndex}`)), `seed ${s}`);
  }
});
test('structure, displacement and liquidity events mirror', () => {
  for (const s of SEEDS) {
    const d = walk(s, 240), a = analyze(d), b = analyze(mirror(d));
    const ev = (r, sign) => sortKey([...r.swing.events, ...r.internal.events].map((e) => `${e.type}${e.mss ? 'M' : ''}:${e.dir * sign}@${e.index}/${e.confirmedIndex}`));
    assert.deepEqual(ev(a, 1), ev(b, -1), `structure seed ${s}`);
    const dp = (r, sign) => sortKey(r.displacement.map((x) => `${x.dir * sign}@${x.index}`));
    assert.deepEqual(dp(a, 1), dp(b, -1), `displacement seed ${s}`);
    const lq = (r, flip) => sortKey(r.liquidity.events.map((e) => `${e.kind}:${flip ? (e.side === 'buy' ? 'sell' : 'buy') : e.side}@${e.index}`));
    assert.deepEqual(lq(a, false), lq(b, true), `liquidity seed ${s}`);
  }
});
test('candle, wyckoff and chart patterns mirror (kinds flip, neutral kinds stay)', () => {
  for (const s of SEEDS) {
    const d = walk(s, 260), a = analyzePatterns(d), b = analyzePatterns(mirror(d));
    const cs = (r, sign) => sortKey(r.candle.map((e) => `${e.kind}:${e.dir * sign}@${e.index}`));
    assert.deepEqual(cs(a, 1), cs(b, -1), `candle seed ${s}`);
    const ws = (r, sign, flip) => sortKey(r.wyckoff.map((e) => `${flip ? flipName(e.kind) : e.kind}:${e.dir * sign}@${e.index}`));
    assert.deepEqual(ws(a, 1, false), ws(b, -1, true), `wyckoff seed ${s}`);
    const ch = (r, sign, flip) => sortKey(r.chart.map((p) => `${flip ? flipKind(p.kind) : p.kind}:${p.status}:${p.dir * sign}@${p.formedIndex}:${p.pivots.map((q) => q.index).sort((x, y) => x - y)}`));
    assert.deepEqual(ch(a, 1, false), ch(b, -1, true), `chart seed ${s}`);
    assert.deepEqual(a.volatility.series.map((x) => x && x.regime), b.volatility.series.map((x) => x && x.regime), `regime seed ${s}`);
  }
});
test('evidence balance negates and verdict side flips', () => {
  const flipV = { 'bullish-lean': 'bearish-lean', 'bearish-lean': 'bullish-lean' };
  for (const s of SEEDS) {
    const d = walk(s, 260), a = analyzeEvidence(d), b = analyzeEvidence(mirror(d));
    assert.ok(Math.abs(a.balance + b.balance) < 1e-9, `balance seed ${s}: ${a.balance} vs ${b.balance}`);
    assert.equal(b.verdict, flipV[a.verdict] ?? a.verdict, `verdict seed ${s}`);
  }
});
test('zones mirror: same count, direction flipped', () => {
  for (const s of SEEDS) {
    const d = walk(s, 240), a = analyze(d), b = analyze(mirror(d));
    const za = analyzeZones(a.candles, { atr: a.atr, structure: a }).zones, zb = analyzeZones(b.candles, { atr: b.atr, structure: b }).zones;
    const key = (z, sign) => `${z.kind}:${z.dir * sign}@${z.createdIndex}`;
    assert.deepEqual(sortKey(za.map((z) => key(z, 1))), sortKey(zb.map((z) => key(z, -1))), `zones seed ${s}`);
  }
});
test('regression: pivots confirmed on the same bar are order-independent (seed 79 outside bar)', () => {
  const d = walk(79, 260), m = mirror(d);
  const f = (x) => chartPatterns(x, atrSeries(x, 14)).filter((p) => p.formedIndex === 213).map((p) => p.kind).sort();
  assert.deepEqual(f(d).map(flipKind).sort(), f(m));
});
test('regression: channel slope test is symmetric when one line is near the flat threshold', () => {
  for (const s of [35, 41]) {
    const d = walk(s, 260), a = chartPatterns(d, atrSeries(d, 14)), b = chartPatterns(mirror(d), atrSeries(mirror(d), 14));
    assert.equal(a.filter((p) => p.kind === 'channel').length, b.filter((p) => p.kind === 'channel').length, `seed ${s}`);
  }
});
