import test from 'node:test';
import assert from 'node:assert/strict';
import { chartPatterns, analyzePatterns, PATTERN_STATES } from '../../src/analysis/patterns.js';
import { atrSeries } from '../../src/analysis/core.js';

// Candles that follow straight segments between waypoints [bar, close]; each bar has a small range.
function path(points, pad = 0.15, warm = 30, warmPrice = 100) {
  const closes = [];
  for (let i = 0; i < warm; i++) closes.push(warmPrice + (i % 2 ? 0.4 : -0.4));
  const base = warm;
  for (let k = 0; k < points.length - 1; k++) {
    const [x0, y0] = points[k], [x1, y1] = points[k + 1];
    for (let x = x0 + 1; x <= x1; x++) closes[base + x] = y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  }
  for (let i = 0; i < closes.length; i++) if (closes[i] == null) closes[i] = closes[i - 1];
  const out = []; let prev = closes[0];
  closes.forEach((c, i) => { out.push({ epoch: 1.7e9 + i * 60, open: prev, high: Math.max(prev, c) + pad, low: Math.min(prev, c) - pad, close: c }); prev = c; });
  return out;
}
const mirror = (d, C = 200) => d.map((c) => ({ ...c, open: C - c.open, high: C - c.low, low: C - c.high, close: C - c.close }));
const run = (d) => chartPatterns(d, atrSeries(d, 14));
// a pole needs a pivot low to start from: dip to 98.5 first, then shift the rest by 3 bars
const pole = (pts) => [[0, 100], [3, 98.5], ...pts.slice(1).map(([x, y]) => [x + 3, y])];
const kinds = (d, ...k) => run(d).filter((p) => k.includes(p.kind));

// bull flag: pole 0..6 (+10), then a down-sloping parallel channel, then a break upward
const FLAG = [[0, 100], [6, 110], [10, 107.5], [14, 109.1], [18, 106.8], [22, 108.5], [24, 108.3], [30, 116], [34, 118]];
const PENNANT = [[0, 100], [6, 110], [10, 107], [14, 109], [18, 107.8], [22, 108.6], [26, 108.1], [34, 117], [38, 119]];

test('states are documented', () => {
  for (const s of ['potential', 'developing', 'confirmed', 'failed', 'invalidated', 'expired']) assert.ok(PATTERN_STATES.includes(s));
});
test('bull flag: detected, developing then confirmed on upward close, direction up', () => {
  const f = kinds(path(pole(FLAG)), 'flag');
  assert.ok(f.length >= 1, 'flag found');
  assert.equal(f[0].dir, 1);
  assert.equal(f[0].status, 'confirmed');
  assert.deepEqual(f[0].history.map((h) => h.status), ['potential', 'developing', 'confirmed']);
  assert.ok(f[0].pole.atr >= 3.5);
  assert.ok(f[0].breakIndex > f[0].formedIndex);
});
test('bear flag is the exact reflection of the bull flag', () => {
  const a = kinds(path(pole(FLAG)), 'flag')[0], b = kinds(mirror(path(pole(FLAG))), 'flag')[0];
  assert.ok(b);
  assert.equal(b.dir, -1); assert.equal(b.status, a.status);
  assert.equal(b.formedIndex, a.formedIndex); assert.equal(b.breakIndex, a.breakIndex);
});
test('pennant: converging lines after a pole', () => {
  const p = kinds(path(pole(PENNANT)), 'pennant');
  assert.ok(p.length >= 1, 'pennant found');
  assert.equal(p[0].dir, 1);
  assert.equal(p[0].status, 'confirmed');
});
test('flag near miss: retracement deeper than 50% of the pole is rejected', () => {
  const deep = [[0, 100], [6, 110], [10, 103.5], [14, 108.6], [18, 102.8], [22, 107.5], [30, 112]];
  assert.equal(kinds(path(pole(deep)), 'flag', 'pennant').length, 0);
});
test('flag near miss: pole too small (< 3.5 ATR) is rejected', () => {
  const small = [[0, 100], [6, 100.8], [10, 100.2], [14, 100.7], [18, 100.1], [22, 100.6], [30, 102]];
  assert.equal(kinds(path(pole(small)), 'flag', 'pennant').length, 0);
});
test('flag invalidated when price closes beyond 50% retracement before breaking out', () => {
  const bad = [[0, 100], [6, 110], [10, 107.5], [14, 109.1], [18, 106.8], [22, 108.0], [26, 106.4], [30, 104], [34, 103.5], [38, 102]];
  const f = kinds(path(pole(bad)), 'flag');
  assert.ok(f.length >= 1);
  assert.equal(f[0].status, 'invalidated');
});
test('flag fails after confirmation when price returns through the retracement level', () => {
  const fail = [[0, 100], [6, 110], [10, 107.5], [14, 109.1], [18, 106.8], [22, 108.5], [24, 108.3], [30, 111], [36, 103], [40, 100]];
  const f = kinds(path(pole(fail)), 'flag');
  assert.ok(f.length >= 1);
  assert.equal(f[0].status, 'failed');
});
test('potential flag-pole is reported only while the consolidation window is open, and never retroactively', () => {
  const d = path(pole([[0, 100], [6, 110], [9, 108.5]]));
  const potential = run(d).filter((p) => p.status === 'potential' && p.kind === 'flag-pole');
  assert.equal(potential.length, 1);
  const later = path(pole([[0, 100], [6, 110], [9, 108.5], [60, 108]]));
  assert.equal(run(later).filter((p) => p.kind === 'flag-pole').length, 0);
});
test('broadening formation: diverging lines (neutral until a close beyond a line)', () => {
  const BR = [[0, 100], [4, 98], [8, 102], [12, 96], [16, 104], [20, 94], [24, 106], [28, 92], [34, 112]];
  const b = kinds(path(BR, 0.15, 30), 'broadening');
  assert.ok(b.length >= 1, 'broadening found');
  assert.equal(b[0].dir === 1 || b[0].dir === -1 || b[0].dir === 0, true);
  const m = kinds(mirror(path(BR)), 'broadening');
  assert.equal(m.length, b.length);
});
test('triangle is not mistaken for broadening', () => {
  const TRI = [[0, 100], [4, 94], [8, 106], [12, 96], [16, 104], [20, 97.5], [24, 102.5], [28, 98.5], [34, 106]];
  assert.equal(kinds(path(TRI), 'broadening', 'right-angled-broadening').length, 0);
});
test('AB=CD bullish: ratios, state and direction', () => {
  const ABCD = [[0, 110], [3, 112], [11, 102], [17, 108], [25, 98], [29, 101.5], [35, 110]];
  const a = kinds(path(ABCD, 0.15, 30, 110), 'abcd').filter((p) => p.status !== 'potential');
  assert.ok(a.length >= 1, 'abcd found');
  assert.equal(a[0].dir, 1);
  assert.ok(Math.abs(a[0].ratioCD - 1) <= 0.15);
  assert.ok(a[0].retraceBC >= 0.382 && a[0].retraceBC <= 0.886);
  assert.ok(['confirmed', 'developing', 'failed', 'invalidated', 'expired'].includes(a[0].status));
  assert.equal(a[0].pivots.length, 4);
});
test('AB=CD bearish is the reflection of bullish', () => {
  const ABCD = [[0, 110], [3, 112], [11, 102], [17, 108], [25, 98], [29, 101.5], [35, 110]];
  const d = path(ABCD, 0.15, 30, 110);
  const a = kinds(d, 'abcd').filter((p) => p.status !== 'potential'), b = kinds(mirror(d), 'abcd').filter((p) => p.status !== 'potential');
  assert.equal(a.length, b.length);
  assert.equal(b[0].dir, -1);
  assert.equal(a[0].formedIndex, b[0].formedIndex);
});
test('AB=CD near miss: CD much longer than AB', () => {
  const LONG = [[0, 110], [3, 112], [11, 102], [17, 108], [25, 90], [29, 94], [35, 100]];
  assert.equal(kinds(path(LONG, 0.15, 30, 110), 'abcd').filter((p) => p.status !== 'potential').length, 0);
});
test('AB=CD near miss: BC retraces less than 38.2%', () => {
  const SHALLOW = [[0, 110], [3, 112], [11, 102], [17, 104], [25, 94], [29, 97], [35, 104]];
  assert.equal(kinds(path(SHALLOW, 0.15, 30, 110), 'abcd').filter((p) => p.status !== 'potential').length, 0);
});
test('AB=CD potential: A,B,C present, projected D reported', () => {
  const d = path([[0, 110], [3, 112], [11, 102], [17, 108], [21, 105]], 0.15, 30, 110);
  const pot = run(d).filter((p) => p.kind === 'abcd' && p.status === 'potential');
  assert.equal(pot.length, 1);
  assert.equal(pot[0].dir, 1);
  assert.ok(Math.abs(pot[0].projectedD - 98) < 0.5);
});
test('insufficient history and malformed input do not throw and yield nothing', () => {
  assert.deepEqual(run(path([[0, 100]], 0.15, 5)), []);
  assert.doesNotThrow(() => analyzePatterns([]));
  assert.doesNotThrow(() => analyzePatterns(path(pole(FLAG)).slice(0, 20)));
});
test('new detectors do not look ahead: prefix run equals full run for resolved patterns', () => {
  const d = path(pole(FLAG)), full = analyzePatterns(d);
  for (const k of [45, 55, 62, 70]) {
    const pre = analyzePatterns(d.slice(0, k));
    const f = (a) => JSON.stringify(a.chart.filter((p) => p.status !== 'potential' && p.formedIndex < k).map((p) => [p.id, p.history.filter((h) => h.index < k).map((h) => h.status + h.index)]));
    assert.equal(f(pre), f(full));
  }
});
