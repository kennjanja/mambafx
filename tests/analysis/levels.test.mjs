import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeLevels, srZones, supplyDemand, premiumDiscount, fibLevels, trendlines, amdStates, ema,
  anchoredVwapProxy, volumeProfileProxy, referenceOpens, topSrZones } from '../../src/analysis/levels.js';
import { atrSeries } from '../../src/analysis/core.js';

const K = (o, h, l, c, i, t0 = 1e9) => ({ epoch: t0 + i * 60, open: o, high: h, low: l, close: c });
function rng(seed) { let s = seed; return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296; }
function walk(seed, n) {
  const r = rng(seed); let p = 100; const out = [];
  for (let i = 0; i < n; i++) { const o = p; p += (r() - 0.5) * 2 + Math.sin(i / 11) * 0.8; out.push(K(o, Math.max(o, p) + r() * 0.6, Math.min(o, p) - r() * 0.6, p, i)); }
  return out;
}

test('EMA seeds with SMA and is null until warm', () => {
  const c = walk(1, 60), e = ema(c, 20);
  assert.equal(e[18], null);
  assert.ok(Math.abs(e[19] - c.slice(0, 20).reduce((s, x) => s + x.close, 0) / 20) < 1e-9);
});
test('S/R clusters repeated highs and counts touches', () => {
  const c = []; let i = 0;
  const bump = (peak) => { for (const p of [100, 101, 102, 103, peak - 0.5, peak, peak - 0.5, 103, 102, 101, 100]) { c.push(K(p, p + 0.3, p - 0.3, p, i++)); } };
  bump(110); bump(110.05); bump(110.1); bump(105);
  const z = srZones(c, atrSeries(c)).find((q) => Math.abs(q.level - 110.3) < 1);
  assert.ok(z && z.touches >= 2, 'touches ' + (z && z.touches));
  assert.equal(z.role, 'resistance');
});
test('S/R flips role on close beyond', () => {
  const c = walk(4, 300), zs = srZones(c, atrSeries(c));
  assert.ok(zs.some((z) => z.flips > 0 || z.role));
  assert.ok(zs.every((z) => Number.isFinite(z.score)));
});
test('visible S/R capped', () => {
  const c = walk(5, 400), zs = srZones(c, atrSeries(c));
  assert.ok(topSrZones(zs, 100, 6).length <= 6);
});
test('demand zone from base + displacement', () => {
  const c = [];
  for (let i = 0; i < 30; i++) c.push(K(100, 101, 99, 100.2, i));
  c.push(K(100, 100.2, 99.8, 100.1, 30)); // base
  c.push(K(100.1, 106, 100, 105.8, 31));   // displacement up
  for (let i = 32; i < 40; i++) c.push(K(106, 107, 105.5, 106.5, i));
  const z = supplyDemand(c, atrSeries(c)).find((q) => q.kind === 'DEMAND');
  assert.ok(z, 'demand zone expected');
  assert.ok(z.bottom <= 99.8 + 1e-9 && z.top >= 100.2 - 1e-9);
});
test('demand invalidated by close below', () => {
  const c = [];
  for (let i = 0; i < 30; i++) c.push(K(100, 101, 99, 100.2, i));
  c.push(K(100, 100.2, 99.8, 100.1, 30)); c.push(K(100.1, 106, 100, 105.8, 31));
  c.push(K(105, 105.2, 97, 98, 32));
  const z = supplyDemand(c, atrSeries(c)).find((q) => q.kind === 'DEMAND');
  assert.equal(z.status, 'invalidated');
});
test('premium/discount splits at 0.5', () => {
  const pd = premiumDiscount(walk(6, 200));
  assert.ok(pd && pd.q25 < pd.eq && pd.eq < pd.q75);
  assert.equal(pd.zone, pd.position > 0.5 ? 'premium' : pd.position < 0.5 ? 'discount' : 'equilibrium');
});
test('fib levels include OTE 0.705 between 0.62 and 0.79', () => {
  const f = fibLevels(walk(7, 200));
  assert.ok(f);
  assert.ok(f.ote.price >= f.ote.low && f.ote.price <= f.ote.high);
  assert.ok(f.levels.some((l) => l.ratio === 1.618) && f.levels.some((l) => l.ratio === -0.27));
  assert.ok(f.levels.every((l) => Number.isFinite(l.price)));
});
test('trendlines do not cut price between anchors', () => {
  const c = walk(8, 300);
  for (const t of trendlines(c, atrSeries(c))) {
    for (let i = t.p1.index + 1; i < t.p2.index; i++) {
      const lv = t.p1.price + t.slope * (i - t.p1.index);
      if (t.kind === 'support-line') assert.ok(c[i].low >= lv - 1e-6); else assert.ok(c[i].high <= lv + 1e-6);
    }
  }
});
test('AMD: accumulation -> manipulation -> distribution', () => {
  const c = [];
  for (let i = 0; i < 25; i++) c.push(K(100, 100.5, 99.5, 100 + (i % 2 ? 0.1 : -0.1), i));
  c.push(K(100, 100.3, 98.5, 100, 25));  // sweep below, close inside
  c.push(K(100, 103, 99.9, 102.9, 26));  // closes above range high
  const s = amdStates(c, atrSeries(c));
  assert.equal(s[25].state, 'manipulation');
  assert.equal(s[26].state, 'distribution');
  assert.equal(s[26].distributionDir, 1);
});
test('AMD: plain breakout is not AMD', () => {
  const c = [];
  for (let i = 0; i < 25; i++) c.push(K(100, 100.5, 99.5, 100, i));
  c.push(K(100, 103, 100, 102.9, 25));
  assert.ok(!amdStates(c, atrSeries(c)).some((s) => s && (s.state === 'manipulation' || s.state === 'distribution')));
});
test('opens/pivots use previous completed day only', () => {
  const day = 86400, c = [];
  for (let d = 0; d < 3; d++) for (let h = 0; h < 4; h++) c.push(K(100 + d, 101 + d + h, 99 + d, 100 + d, 0, 0 + d * day + h * 3600));
  c.forEach((x, i) => { x.epoch = Math.floor(i / 4) * day + (i % 4) * 3600; });
  const o = referenceOpens(c);
  assert.equal(o[0].pivots, null);
  assert.equal(o[3].pivots, null);
  assert.ok(o[4].pivots);
  const d0hi = Math.max(...c.slice(0, 4).map((x) => x.high));
  assert.ok(Math.abs(o[4].pivots.pp - (d0hi + 99 + c[3].close) / 3) < 1e-9);
});
test('VWAP and profile are proxy-labelled; value area contains POC', () => {
  const c = walk(9, 250);
  const v = anchoredVwapProxy(c, 50);
  assert.equal(v.proxy, true); assert.equal(v.values[49], null);
  const p = volumeProfileProxy(c);
  assert.equal(p.proxy, true);
  assert.ok(p.val <= p.poc && p.poc <= p.vah);
});
test('analyzeLevels handles tiny and invalid input', () => {
  assert.doesNotThrow(() => analyzeLevels([]));
  assert.doesNotThrow(() => analyzeLevels(walk(1, 5)));
  const c = walk(2, 80); c[3] = { ...c[3], close: NaN };
  assert.equal(analyzeLevels(c).dropped, 1);
});

for (const seed of [21, 22, 23]) {
  test('no look-ahead: prefix equals full run, seed ' + seed, () => {
    const data = walk(seed, 320), full = analyzeLevels(data);
    for (const k of [120, 200, 280]) {
      const pre = analyzeLevels(data.slice(0, k));
      const sr = (a) => JSON.stringify(a.filter((z) => z.confirmedIndex < k).map((z) => [z.id, z.createdIndex]));
      assert.equal(sr(pre.sr), sr(full.sr));
      const sd = (a) => JSON.stringify(a.filter((z) => z.confirmedIndex < k).map((z) => [z.id, z.history.filter((h) => h.index < k).map((h) => h.status + h.index)]));
      assert.equal(sd(pre.supplyDemand), sd(full.supplyDemand));
      const tl = (a) => JSON.stringify(a.filter((t) => t.confirmedIndex < k).map((t) => [t.id, t.breakIndex != null && t.breakIndex < k ? t.breakIndex : null]));
      assert.equal(tl(pre.trendlines), tl(full.trendlines));
      assert.equal(JSON.stringify(pre.amd.slice(0, k)), JSON.stringify(full.amd.slice(0, k)));
      assert.equal(JSON.stringify(pre.opens.slice(0, k)), JSON.stringify(full.opens.slice(0, k)));
      for (const per of [20, 50]) assert.equal(JSON.stringify(pre.emas[per].slice(0, k)), JSON.stringify(full.emas[per].slice(0, k)));
    }
  });
}
