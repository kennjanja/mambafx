// Characterisation tests for the Bazu-vs-shared-engine detector audit (docs/bazu-detector-audit.md).
// They PIN the current behaviour of Bazu's detectors and assert the measured relationship to the shared
// analysis engine. They must not be loosened to make a change pass: a failure here means Bazu behaviour moved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { emaSeries } from '../../src/bazu/ta3m.js';
import { robustAtr } from '../../src/bazu/candles3m.js';
import { atrSeries as bazuAtr, computeStructureFeatures } from '../../src/bazu/structure.js';
import { structureState } from '../../src/bazu/factors3m.js';
import { detectStructureBreaks } from '../../mtf/src/analysis/structurePatterns.js';
import { detectFVG, detectOrderBlock } from '../../mtf/src/analysis/zonePatterns.js';
import { ema as sharedEma } from '../../src/analysis/levels.js';
import { atrSeries as sharedAtr } from '../../src/analysis/core.js';
import { analyze } from '../../src/analysis/engine.js';
import { analyzeZones } from '../../src/analysis/zones.js';

function walk(seed, n, vol = 1) {
  let s = seed >>> 0; const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const out = []; let p = 100;
  for (let i = 0; i < n; i++) {
    const o = p, c = o + (r() - 0.5) * 2 * vol * (r() < 0.1 ? 4 : 1);
    out.push({ epoch: 1000 + i * 60, open: o, close: c, high: Math.max(o, c) + r() * vol * 0.6, low: Math.min(o, c) - r() * vol * 0.6 }); p = c;
  }
  return out;
}
const SEEDS = [1, 2, 3, 7, 11, 23, 99];

test('EMA: Bazu is seeded with the first value, shared with the SMA of the first n; after seeding the gap decays exactly as (1-k)^m', () => {
  const C = walk(7, 300), cl = C.map((c) => c.close), n = 20, k = 2 / (n + 1);
  const a = emaSeries(cl, n), b = sharedEma(C, n);
  assert.equal(a[0], cl[0]);
  assert.equal(b[n - 2], null);
  assert.notEqual(a[n - 1], b[n - 1]);
  const d0 = a[n - 1] - b[n - 1];
  for (const i of [n, n + 5, 60, 150, 299]) assert.ok(Math.abs((a[i] - b[i]) - d0 * Math.pow(1 - k, i - n + 1)) < 1e-9, `i=${i}`);
  assert.ok(Math.abs(a[299] - b[299]) < 1e-9, 'converged long before the end of a 300-candle series');
});

test('ATR: Bazu structure ATR is a Wilder RMA seeded from the first true range; shared is seeded with the SMA of n true ranges', () => {
  const C = walk(7, 300), n = 14;
  const a = bazuAtr(C, n), b = sharedAtr(C, n);
  assert.ok(Number.isNaN(a[n - 2]) && b[n - 2] === null);
  assert.ok(Number.isFinite(a[n - 1]) && Number.isFinite(b[n - 1]));
  assert.notEqual(a[n - 1], b[n - 1]);
  const d0 = a[n - 1] - b[n - 1];
  for (const i of [n, n + 10, 100, 299]) assert.ok(Math.abs((a[i] - b[i]) - d0 * Math.pow((n - 1) / n, i - n + 1)) < 1e-9, `i=${i}`);
});

test('ATR: robustAtr is a median of true ranges (intentionally NOT Wilder) and shrugs off an isolated spike', () => {
  const C = walk(3, 80);
  const spiked = C.map((c, i) => (i === 70 ? { ...c, high: c.high + 40 } : c));
  const rob0 = robustAtr(C, 14)[75], rob1 = robustAtr(spiked, 14)[75];
  const w0 = sharedAtr(C, 14)[75], w1 = sharedAtr(spiked, 14)[75];
  assert.ok(Math.abs(rob1 / rob0 - 1) < 0.05, 'median moves by well under 5% with one spike');
  assert.ok(w1 > w0 * 1.5 && w1 / w0 > rob1 / rob0 * 1.4, 'Wilder ATR is pulled up by the same spike');
  assert.ok(Number.isFinite(robustAtr(C, 14)[4]) && Number.isNaN(robustAtr(C, 14)[3]), 'defined from min(n,5) candles (shared: from n)');
});

const k3 = (e) => `${e.index}|${e.direction ?? (e.dir === 1 ? 'bullish' : 'bearish')}`;

test('BOS/CHoCH: >=90% of shared (consuming) break bars are also mtf break bars, but the BOS-vs-CHoCH label agrees far less; mtf re-reports repeated breaks', () => {
  for (const seed of SEEDS) {
    const C = walk(seed, 400);
    const m = detectStructureBreaks(C, 2), label = new Map([...m.bos.map((e) => [k3(e), 'BOS']), ...m.choch.map((e) => [k3(e), 'CHoCH'])]);
    const s = analyze(C, { internalPivot: 2 }).internal.events;
    const hit = s.filter((e) => label.has(k3(e))), same = hit.filter((e) => label.get(k3(e)) === e.type);
    assert.ok(hit.length / s.length >= 0.9, `seed ${seed} bar overlap ${hit.length}/${s.length}`);
    assert.ok(same.length / hit.length < 0.9, `seed ${seed}: labels agree ${same.length}/${hit.length}; if this reaches 90% the trend notions converged`);
    assert.ok(label.size > 2 * s.length, `seed ${seed}: mtf ${label.size} vs shared ${s.length}`);
  }
});
test('BOS/CHoCH: the raw mtf detector is NOT causal at the right edge (known, mitigated in Bazu by a +lookback availability delay)', () => {
  const C = walk(7, 400), full = detectStructureBreaks(C, 2);
  const key = (e) => `${e.type}|${e.index}|${e.direction}`;
  let mismatches = 0;
  for (let len = 60; len < 400; len++) {
    const p = detectStructureBreaks(C.slice(0, len), 2);
    const a = [...p.bos, ...p.choch].map(key).sort().join(), b = [...full.bos, ...full.choch].filter((e) => e.index < len).map(key).sort().join();
    if (a !== b) mismatches++;
  }
  assert.ok(mismatches > 0, 'if this becomes 0 the detector was fixed: update docs/bazu-detector-audit.md');
  // the shared engine has no such mismatch (also covered in tests/analysis)
  const sFull = analyze(C, { internalPivot: 2 }).internal.events;
  for (const len of [120, 200, 301]) {
    const p = analyze(C.slice(0, len), { internalPivot: 2 }).internal.events.map(k3).join();
    assert.equal(p, sFull.filter((e) => e.index < len).map(k3).join());
  }
});

test('Bazu structure features (mtf detectors + availability delay) are causal: truncating the future never changes earlier values', () => {
  const C = walk(7, 400), prices = C.map((c) => c.close), epochs = C.map((c) => c.epoch);
  const full = computeStructureFeatures(prices, epochs, 1);
  for (const len of [120, 187, 250, 333]) {
    const part = computeStructureFeatures(prices.slice(0, len), epochs.slice(0, len), 1);
    for (const name of ['bosDir', 'chochDir', 'sweepDir', 'fvgDir', 'obDir', 'trendHHHL']) {
      for (let t = 0; t < len; t++) {
        const x = part.series[name][t], y = full.series[name][t];
        assert.ok(Object.is(x, y) || (Number.isNaN(x) && Number.isNaN(y)), `${name}[${t}] len=${len}`);
      }
    }
  }
});

test('BOS/CHoCH: factors3m structureState keeps reporting a break while price stays beyond the swing (not consumed), shared reports it once', () => {
  let found = null;
  for (const seed of SEEDS) {
    const C = walk(seed, 400);
    for (let i = 40; i < 399 && !found; i++) {
      const s0 = structureState(C.slice(0, i + 1)), s1 = structureState(C.slice(0, i + 2));
      if (s0.bos && s0.bos === s1.bos && s0.lastHigh === s1.lastHigh && s0.lastLow === s1.lastLow) found = { C, i };
    }
    if (found) break;
  }
  assert.ok(found, 'a repeated report exists on the fixtures');
  const ev = analyze(found.C.slice(0, found.i + 2), { internalPivot: 2 }).internal.events;
  const dir = structureState(found.C.slice(0, found.i + 2)).bos;
  const same = ev.filter((e) => (e.index === found.i || e.index === found.i + 1) && e.dir === dir);
  assert.ok(same.length <= 1, 'shared engine consumes the pivot on the first break');
});

test('trend definition differs: structureState uses the last two swing highs and lows; shared trend is the direction of the last break', () => {
  let disagree = 0, total = 0;
  const C = walk(7, 400);
  for (let i = 60; i < 400; i += 7) {
    const s = structureState(C.slice(0, i + 1)), e = analyze(C.slice(0, i + 1), { internalPivot: 2 }).internal;
    total++; if (s.trend !== e.trend) disagree++;
  }
  assert.ok(disagree / total > 0.3, `disagreement ${disagree}/${total}: the two trend notions are not interchangeable`);
});

test('FVG: shared FVG zones are exactly the mtf FVGs (same bar, direction and bounds) that pass the size >= 0.4 ATR filter', () => {
  for (const seed of SEEDS) {
    const C = walk(seed, 400);
    const mtf = new Map(detectFVG(C).map((q) => [`${q.index}|${q.direction === 'bullish' ? 1 : -1}`, q]));
    const zs = analyzeZones(C).zones.filter((q) => q.kind === 'FVG');
    for (const z of zs) {
      const m = mtf.get(`${z.createdIndex}|${z.dir}`);
      assert.ok(m, `seed ${seed} shared FVG at ${z.createdIndex} not in mtf`);
      assert.ok(Math.abs(m.top - z.top) < 1e-9 && Math.abs(m.bottom - z.bottom) < 1e-9);
      assert.equal(z.confirmedIndex, z.createdIndex + 1, 'known when the third candle closes = mtf index + 1 (Bazu availability shift)');
    }
    assert.ok(mtf.size > zs.length * 1.5, 'mtf reports many small gaps the shared engine filters out');
  }
});

test('OB: mtf (body > 2x average body, walk-back 5, body zone) and shared (ATR displacement + structure break, walk-back 10, full-range zone) overlap heavily but are different detectors', () => {
  for (const seed of SEEDS) {
    const C = walk(seed, 400);
    const mtf = new Map(detectOrderBlock(C).map((q) => [`${q.index}|${q.direction === 'bullish' ? 1 : -1}`, q]));
    const zs = analyzeZones(C).zones.filter((q) => q.kind === 'OB');
    let hit = 0;
    for (const z of zs) {
      const m = mtf.get(`${z.createdIndex}|${z.dir}`);
      if (m) { hit++; assert.ok(z.bottom <= m.bottom + 1e-9 && z.top >= m.top - 1e-9, 'shared zone is the full candle range, mtf the body'); }
    }
    assert.ok(hit / zs.length >= 0.8, `seed ${seed}: overlap ${hit}/${zs.length}`);
    assert.ok(mtf.size > zs.length, 'mtf does not require a subsequent structure break, so it reports more');
  }
});
