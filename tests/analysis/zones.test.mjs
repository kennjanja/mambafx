import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeZones, overlapRatio, zonesAtPrice, zoneConfluence } from '../../src/analysis/zones.js';

const T0 = 19676 * 86400;
const mk = (i, o, h, l, c) => ({ epoch: T0 + i * 60, open: o, high: h, low: l, close: c });
const calm = (n) => Array.from({ length: n }, (_, i) => mk(i, i % 2 ? 100.2 : 99.8, 100.5, 99.5, i % 2 ? 99.8 : 100.2));
function rng(seed) { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }
function walk(n, seed, vol) {
  const r = rng(seed); let p = 1000; const out = [];
  for (let i = 0; i < n; i++) { const o = p, c = o + (r() - 0.5) * 6 * vol; out.push(mk(i, o, Math.max(o, c) + r() * 2 * vol, Math.min(o, c) - r() * 2 * vol, c)); p = c; }
  return out;
}
const byKind = (r, k) => r.zones.filter(z => z.kind === k);

function fvgBase() {
  return [...calm(20), mk(20, 100, 100.5, 99.6, 100.3), mk(21, 100.3, 103, 100.2, 102.8), mk(22, 102.8, 103.5, 101.5, 103.2)];
}

test('bullish FVG: creation, bounds, CE, size threshold', () => {
  const r = analyzeZones(fvgBase());
  const f = byKind(r, 'FVG')[0];
  assert.equal(f.dir, 1); assert.equal(f.bottom, 100.5); assert.equal(f.top, 101.5); assert.equal(f.mid, 101);
  assert.equal(f.confirmedIndex, 22); assert.equal(f.createdIndex, 21); assert.equal(f.status, 'active');
  assert.ok(f.sizeAtr >= 0.4);
  // gap below threshold is ignored
  const small = [...calm(20), mk(20, 100, 100.5, 99.6, 100.3), mk(21, 100.3, 101, 100.2, 100.9), mk(22, 100.9, 101.2, 100.7, 101.0)];
  assert.equal(byKind(analyzeZones(small), 'FVG').length, 0);
});

test('bearish FVG', () => {
  const c = [...calm(20), mk(20, 100, 100.4, 99.5, 99.7), mk(21, 99.7, 99.8, 97, 97.2), mk(22, 97.2, 98.5, 96.5, 96.8)];
  const f = byKind(analyzeZones(c), 'FVG')[0];
  assert.equal(f.dir, -1); assert.equal(f.top, 99.5); assert.equal(f.bottom, 98.5);
});

test('FVG lifecycle: untouched -> partial -> filled -> inverted (IFVG), with history and fill %', () => {
  const c = fvgBase();
  const at = (extra) => analyzeZones([...c, ...extra]);
  assert.equal(byKind(at([]), 'FVG')[0].status, 'active');
  const p = at([mk(23, 103.2, 103.3, 101.0, 101.8)]);
  assert.equal(byKind(p, 'FVG')[0].status, 'partial'); assert.ok(Math.abs(byKind(p, 'FVG')[0].fill - 0.5) < 1e-9);
  const f = at([mk(23, 103.2, 103.3, 101.0, 101.8), mk(24, 101.8, 102, 100.4, 100.8)]);
  assert.equal(byKind(f, 'FVG')[0].status, 'filled'); assert.equal(byKind(f, 'FVG')[0].fill, 1);
  assert.equal(byKind(f, 'FVG')[0].endIndex, 24);
  const inv = at([mk(23, 103.2, 103.3, 101.0, 101.8), mk(24, 101.8, 102, 100.4, 100.8), mk(25, 100.8, 100.9, 99.8, 100.0)]);
  const z = byKind(inv, 'FVG')[0];
  assert.equal(z.status, 'inverted');
  assert.deepEqual(z.history.map(h => h.status), ['partial', 'filled', 'inverted']);
  const ifvg = byKind(inv, 'IFVG')[0];
  assert.equal(ifvg.dir, -1); assert.equal(ifvg.parentId, z.id); assert.equal(ifvg.bottom, 100.5); assert.equal(ifvg.confirmedIndex, 25);
});

test('FVG invalidated (no IFVG) when inversion is disabled; expires when never touched', () => {
  const c = [...fvgBase(), mk(23, 100.8, 100.9, 99.8, 100.0)];
  const r = analyzeZones(c, { invert: false });
  assert.equal(byKind(r, 'FVG')[0].status, 'invalidated'); assert.equal(byKind(r, 'IFVG').length, 0);
  const far = [...fvgBase()];
  for (let i = 23; i < 40; i++) far.push(mk(i, 104, 104.4, 103.9, 104.1));
  const e = analyzeZones(far, { fvgMaxAge: 5 });
  assert.equal(byKind(e, 'FVG')[0].status, 'expired');
});

// order-block fixture: unique pivot high at idx10 (101.2) confirmed at 13, bearish candle at 20, displacement at 21
function obBase(pivotHigh = 101.2) {
  const c = calm(20);
  c[10] = mk(10, 100, pivotHigh, 99.6, 100.1);
  return [...c, mk(20, 100.3, 100.4, 99.7, 99.9), mk(21, 99.9, 102.8, 99.85, 102.8)];
}

test('order block: last opposing candle before displacement + BOS; candidate then confirmed', () => {
  const r = analyzeZones(obBase());
  const ob = byKind(r, 'OB');
  assert.equal(ob.length, 1);
  assert.equal(ob[0].dir, 1); assert.equal(ob[0].createdIndex, 20); assert.equal(ob[0].bottom, 99.7); assert.equal(ob[0].top, 100.4);
  assert.ok(Math.abs(ob[0].mid - 100.05) < 1e-9); assert.equal(ob[0].confirmedIndex, 21); assert.equal(ob[0].status, 'active');
  assert.deepEqual(ob[0].history.map(h => h.status), ['candidate', 'active']);
  assert.equal(ob[0].breakType, 'BOS');
});

test('candidate order block expires without a structure break; opposing candles are not all OBs', () => {
  const c = [...obBase(104), ...Array.from({ length: 8 }, (_, i) => mk(22 + i, 102.8, 103.0, 102.6, 102.8))];
  const r = analyzeZones(c);
  const ob = byKind(r, 'OB');
  assert.equal(ob.length, 1); assert.equal(ob[0].status, 'expired'); assert.equal(ob[0].reason, 'no-structure-break');
  assert.equal(ob[0].confirmedIndex, null);
  assert.equal(byKind(analyzeZones(calm(40)), 'OB').length, 0);
});

test('order block mitigation, test count, then invalidation spawns a breaker', () => {
  const tail = [
    mk(22, 102.8, 103.5, 102.8, 103.2), mk(23, 103.2, 103.3, 100.3, 100.9), // first entry (mitigation)
    mk(24, 100.9, 103, 100.8, 102.9), mk(25, 102.9, 103, 100.2, 100.8),     // second entry
    mk(26, 100.8, 100.9, 98.9, 99.0),                                        // closes below 99.7
  ];
  const full = analyzeZones([...obBase(), ...tail]);
  const ob = byKind(full, 'OB')[0];
  assert.equal(ob.firstMitigationIndex, 23); assert.equal(ob.testCount, 2);
  assert.equal(ob.status, 'invalidated'); assert.equal(ob.endIndex, 26);
  const br = byKind(full, 'BREAKER')[0];
  assert.equal(br.dir, -1); assert.equal(br.bottom, ob.bottom); assert.equal(br.parentId, ob.id); assert.equal(br.confirmedIndex, 26);
  const mid = byKind(analyzeZones([...obBase(), ...tail.slice(0, 2)]), 'OB')[0];
  assert.equal(mid.status, 'mitigated');
  assert.equal(byKind(analyzeZones([...obBase(), ...tail], { breakers: false }), 'BREAKER').length, 0);
});

test('duplicate / repeated OBs are merged: one opposing candle is used only once', () => {
  const c = [...obBase(), mk(22, 102.8, 105.9, 102.7, 105.8)]; // 2nd displacement walks back to the same candle
  assert.equal(byKind(analyzeZones(c), 'OB').length, 1);
  assert.equal(overlapRatio({ bottom: 1, top: 3 }, { bottom: 2, top: 6 }), 0.5);
  assert.equal(overlapRatio({ bottom: 1, top: 2 }, { bottom: 3, top: 4 }), 0);
});

test('BPR from overlapping opposite FVGs', () => {
  const c = [...fvgBase(), mk(23, 103.2, 103.3, 102.6, 102.8), mk(24, 102.8, 102.9, 100.8, 101.0), mk(25, 101.0, 101.4, 100.7, 101.2)];
  const r = analyzeZones(c);
  const bpr = byKind(r, 'BPR')[0];
  assert.ok(bpr); assert.equal(bpr.dir, -1); assert.ok(Math.abs(bpr.bottom - 101.4) < 1e-9 && Math.abs(bpr.top - 101.5) < 1e-9);
  assert.equal(bpr.confirmedIndex, 25); assert.equal(bpr.fvgIds.length, 2);
});

test('rejection block at a confirmed long-wick pivot, created at confirmation', () => {
  const c = calm(25); c[10] = mk(10, 100, 102, 99.9, 100.1);
  const z = byKind(analyzeZones(c), 'REJECTION')[0];
  assert.ok(z); assert.equal(z.dir, -1); assert.equal(z.createdIndex, 10); assert.equal(z.confirmedIndex, 13);
  assert.equal(z.bottom, 100.1); assert.equal(z.top, 102);
  const none = calm(25); none[10] = mk(10, 100, 100.25, 99.9, 100.1);
  assert.equal(byKind(analyzeZones(none), 'REJECTION').length, 0);
});

test('overlap / confluence helpers and price lookup', () => {
  const r = analyzeZones([...fvgBase(), mk(23, 103.2, 103.3, 102.6, 102.8), mk(24, 102.8, 102.9, 100.8, 101.0), mk(25, 101.0, 101.4, 100.7, 101.2)]);
  assert.ok(zonesAtPrice(r.zones, 101.45).length >= 2);
  assert.ok(zoneConfluence(r.zones, 0.01).length >= 1);
  assert.equal(zonesAtPrice(r.zones, 50).length, 0);
});

test('safe on degenerate input', () => {
  assert.deepEqual(analyzeZones([]).zones, []);
  assert.deepEqual(analyzeZones(calm(3)).zones, []);
});

const norm = (zs, k) => zs.map(z => ({
  kind: z.kind, dir: z.dir, bottom: z.bottom, top: z.top, createdIndex: z.createdIndex,
  confirmedIndex: z.confirmedIndex != null && z.confirmedIndex < k ? z.confirmedIndex : null,
  history: z.history.filter(h => h.index < k),
})).filter(z => z.history.length > 0 || z.confirmedIndex != null);

for (const [name, data] of [['walk-a', walk(500, 3, 1)], ['walk-b', walk(500, 8, 4)]]) {
  test(`zones: no look-ahead / no repainting (${name})`, () => {
    const full = analyzeZones(data);
    assert.ok(full.zones.length > 5);
    const kinds = new Set(full.zones.map(z => z.kind)); assert.ok(kinds.has('FVG'));
    for (const k of [80, 160, 241, 333, 450]) {
      const part = analyzeZones(data.slice(0, k));
      const f = norm(full.zones.filter(z => z.createdIndex < k && (z.confirmedIndex == null || z.confirmedIndex < k || z.history.some(h => h.index < k))), k);
      assert.deepEqual(norm(part.zones, k), f, `zones @${k}`);
    }
  });
}
