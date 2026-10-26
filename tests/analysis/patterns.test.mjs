import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzePatterns, candlePatterns, volatilityRegimes, chartPatterns } from '../../src/analysis/patterns.js';
import { atrSeries } from '../../src/analysis/core.js';

const K = (o, h, l, c, i) => ({ epoch: 1e9 + i * 60, open: o, high: h, low: l, close: c });
function rng(seed) { let s = seed; return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296; }
function walk(seed, n) {
  const r = rng(seed); let p = 100; const out = [];
  for (let i = 0; i < n; i++) { const o = p; p += (r() - 0.5) * 2 + Math.sin(i / 11) * 0.8; out.push(K(o, Math.max(o, p) + r() * 0.6, Math.min(o, p) - r() * 0.6, p, i)); }
  return out;
}
const run = (c) => candlePatterns(c, atrSeries(c));

test('hammer and shooting star', () => {
  const h = run([K(10, 10.1, 8, 10.05, 0)]);
  assert.ok(h.some((e) => e.kind === 'pin-bar' && e.dir === 1 && e.name === 'hammer'));
  const s = run([K(10, 12, 9.95, 10.05, 0)]);
  assert.ok(s.some((e) => e.kind === 'pin-bar' && e.dir === -1));
});
test('engulfing, inside, outside', () => {
  const e = run([K(10, 10.2, 9.4, 9.5, 0), K(9.4, 10.6, 9.3, 10.5, 1)]);
  assert.ok(e.some((x) => x.kind === 'engulfing' && x.dir === 1));
  assert.ok(run([K(10, 12, 8, 11, 0), K(10, 11, 9, 10.5, 1)]).some((x) => x.kind === 'inside-bar'));
  assert.ok(run([K(10, 11, 9, 10.5, 0), K(10, 12, 8, 11, 1)]).some((x) => x.kind === 'outside-bar'));
});
test('NR4 needs the narrowest of 4', () => {
  const c = [K(10, 12, 8, 11, 0), K(11, 13, 9, 10, 1), K(10, 12, 8, 9, 2), K(9, 9.5, 8.8, 9.2, 3)];
  assert.ok(run(c).some((x) => x.kind === 'NR4' && x.index === 3));
  assert.ok(!run(c.slice(0, 3)).some((x) => x.kind === 'NR4'));
});
test('three-bar reversal bullish', () => {
  const c = [K(10, 10.1, 9, 9.1, 0), K(9.1, 9.2, 8.5, 8.9, 1), K(8.9, 10.5, 8.8, 10.4, 2)];
  assert.ok(run(c).some((x) => x.kind === 'three-bar-reversal' && x.dir === 1));
});
test('regime unknown until enough history; no NaN', () => {
  const c = walk(1, 150), atr = atrSeries(c);
  const v = volatilityRegimes(c, atr);
  assert.equal(v.series[5], null);
  const first = v.series.find((s) => s);
  assert.equal(first.regime, 'unknown');
  assert.ok(v.series.filter(Boolean).every((s) => Number.isFinite(s.rangeVsAtr)));
  assert.ok(v.series.some((s) => s && s.regime !== 'unknown'));
});
test('double top detected, confirmed on neckline close', () => {
  const pts = [100, 101, 102, 104, 106, 108, 110, 108, 106, 104, 102, 101, 100, 101, 103, 105, 107, 109.9, 108, 106, 104, 102, 100, 98, 96, 95, 94];
  const c = pts.map((p, i) => K(p, p + 0.4, p - 0.4, p + (i % 2 ? 0.1 : -0.1), i));
  const pats = analyzePatterns(c, { patternTolAtr: 2 }).chart.filter((p) => p.kind === 'double-top');
  assert.ok(pats.length >= 1);
  assert.equal(pats[0].dir, -1);
  assert.ok(['confirmed', 'failed'].includes(pats[0].status));
  assert.ok(pats[0].breakIndex > pats[0].formedIndex);
});
test('spring / upthrust', () => {
  const c = walk(3, 60);
  for (let i = 0; i < 60; i++) { c[i] = K(100, 100.5, 99.5, 100, i); }
  c[40] = K(100, 100.2, 98.5, 100.1, 40);
  c[41] = K(100, 100.5, 99.5, 100, 41);
  const w = analyzePatterns(c).wyckoff;
  assert.ok(w.some((e) => e.kind === 'spring' && e.index === 40));
});
test('invalid candles dropped', () => {
  const c = walk(2, 50); c[10] = { ...c[10], high: NaN };
  assert.equal(analyzePatterns(c).dropped, 1);
});

// Look-ahead: analysing a prefix must equal the full run restricted to what was knowable by then.
for (const seed of [11, 12, 13]) {
  test('no look-ahead / repaint, seed ' + seed, () => {
    const data = walk(seed, 260), full = analyzePatterns(data);
    for (const k of [90, 150, 210]) {
      const pre = analyzePatterns(data.slice(0, k));
      const f = (a) => JSON.stringify(a.filter((e) => e.confirmedIndex < k).map((e) => [e.index, e.kind, e.dir]));
      assert.equal(f(pre.candle), f(full.candle));
      assert.equal(f(pre.wyckoff), f(full.wyckoff));
      assert.equal(JSON.stringify(pre.volatility.series.slice(0, k)), JSON.stringify(full.volatility.series.slice(0, k)));
      const stat = (a) => JSON.stringify(a.filter((p) => p.formedIndex < k).map((p) => [p.id, p.history.filter((h) => h.index < k).map((h) => h.status + h.index)]));
      assert.equal(stat(pre.chart), stat(full.chart));
    }
  });
}
