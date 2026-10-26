// Phase 7C: chronological out-of-sample validation of analysis events against subsequent price.
//
// Rules that keep this honest:
//  * An event is only *known* at `confirmedIndex`; the entry reference is the OPEN of the next bar, so the
//    confirming candle can never leak into the outcome.
//  * Events are scored on the later part of the series only (default: last 40%); the earlier part is
//    reported separately so an in-sample "edge" that vanishes out of sample is visible.
//  * Hit = price moved in the event's direction (ties count as misses, as in the app's shadow outcomes).
//  * Wilson 95% intervals are reported; groups with n < minN are flagged `insufficient` and carry no verdict.
//  * Overlapping events of the same kind/direction closer than `minGap` bars are collapsed to the first,
//    to limit serial dependence. Remaining samples are still not independent: treat intervals as optimistic.
//  * "Significant" means the interval excludes 50% - nothing about payout, risk or expected return.

import { analyze } from './engine.js';
import { analyzeZones } from './zones.js';
import { analyzePatterns } from './patterns.js';

export const VALIDATION_DEFAULTS = Object.freeze({ horizons: [1, 3, 5, 10, 20], mfeBars: 20, testFraction: 0.4, minN: 30, minGap: 5 });

export function wilson(k, n, z = 1.96) {
  if (!n) return null;
  const p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return { lo: (c - m) / d, hi: (c + m) / d };
}

export function collectEvents(candles, opts = {}) {
  const base = analyze(candles);
  const pat = analyzePatterns(base.candles);
  const zr = analyzeZones(base.candles, { atr: base.atr, structure: base });
  const ev = [];
  const add = (kind, dir, index, confirmedIndex) => { if (dir === 1 || dir === -1) ev.push({ kind, dir, index, confirmedIndex }); };
  for (const [scale, r] of [['swing', base.swing], ['internal', base.internal]]) for (const e of r.events) add(`${scale}-${e.mss ? 'MSS' : e.type}`, e.dir, e.index, e.confirmedIndex ?? e.index);
  for (const d of base.displacement) add('displacement', d.dir, d.index, d.confirmedIndex);
  for (const e of base.liquidity.events) if (e.kind === 'sweep-confirmed') add('sweep-reversal', e.side === 'buy' ? -1 : 1, e.index, e.confirmedIndex);
  for (const e of pat.candle) add(`candle-${e.kind}`, e.dir, e.index, e.confirmedIndex);
  for (const e of pat.wyckoff) if (e.kind !== 'effort-no-result') add(`wyckoff-${e.kind}`, e.dir, e.index, e.confirmedIndex);
  for (const p of pat.chart) if (p.status !== 'forming' && p.breakIndex != null) add(`pattern-${p.kind}-break`, p.dir, p.breakIndex, p.breakIndex);
  // Formation measures continuation after the zone appears. Retest (first touch) measures the usual zone
  // hypothesis: price reacts in the zone's direction after returning to it. Both are known at their own bar.
  for (const z of zr.zones) {
    if (z.confirmedIndex == null) continue;
    add(`zone-${z.kind}-formed`, z.dir, z.createdIndex, z.confirmedIndex);
    const touch = z.history.find((h) => h.status === 'partial' || h.status === 'filled');
    if (touch) add(`zone-${z.kind}-retest`, z.dir, touch.index, touch.index);
  }
  return { events: ev.sort((a, b) => a.confirmedIndex - b.confirmedIndex), base, pat };
}

export function validateEvents(candles, meta = {}, opts = {}) {
  const O = { ...VALIDATION_DEFAULTS, ...opts };
  const { events, base, pat } = collectEvents(candles, O);
  const c = base.candles, n = c.length, atr = base.atr;
  const split = Math.floor(n * (1 - O.testFraction));
  const maxH = Math.max(...O.horizons);
  const lastAt = new Map();
  const records = [];
  const baseline = unconditionalBaseline(c, O, split);
  for (const e of events) {
    const k = `${e.kind}|${e.dir}`;
    if (lastAt.has(k) && e.confirmedIndex - lastAt.get(k) < O.minGap) continue;
    lastAt.set(k, e.confirmedIndex);
    const ci = e.confirmedIndex, entryIdx = ci + 1;
    if (entryIdx >= n || atr[ci] == null) continue;
    const entry = c[entryIdx].open, a = atr[ci];
    const rec = {
      instrument: meta.instrument ?? null, timeframe: meta.timeframe ?? null, kind: e.kind, dir: e.dir,
      eventTime: c[e.index].epoch, confirmTime: c[ci].epoch, confirmedIndex: ci,
      regime: pat.volatility.series[ci]?.regime ?? 'unknown', sample: ci >= split ? 'test' : 'train',
      outcomes: {}, matured: true,
    };
    for (const h of O.horizons) {
      const j = entryIdx + h - 1;
      if (j >= n) { rec.outcomes[h] = null; if (h === maxH) rec.matured = false; continue; }
      const move = e.dir * (c[j].close - entry);
      rec.outcomes[h] = { hit: move > 0, move: move / a };
    }
    let mfe = 0, mae = 0; const end = Math.min(n - 1, entryIdx + O.mfeBars - 1);
    for (let j = entryIdx; j <= end; j++) {
      const fav = e.dir === 1 ? c[j].high - entry : entry - c[j].low, adv = e.dir === 1 ? entry - c[j].low : c[j].high - entry;
      mfe = Math.max(mfe, fav / a); mae = Math.max(mae, adv / a);
    }
    rec.mfe = mfe; rec.mae = mae; rec.excursionBars = end - entryIdx + 1;
    records.push(rec);
  }
  return { records, summary: summarize(records, O, baseline), baseline, params: O, candles: n, splitIndex: split };
}

// Rate at which a trade in each direction would have been "correct" when entered at the next open of EVERY eligible
// bar, per sample and horizon. This is the reference an event must beat; 50% is wrong when price drifts or ties occur.
export function unconditionalBaseline(c, O, split) {
  const out = { 1: { train: {}, test: {} }, '-1': { train: {}, test: {} } };
  const n = c.length;
  for (let ci = 14; ci + 1 < n; ci++) {
    const s = ci >= split ? 'test' : 'train', e = ci + 1;
    for (const h of O.horizons) {
      const j = e + h - 1; if (j >= n) continue;
      const m = c[j].close - c[e].open;
      for (const d of [1, -1]) { const b = (out[d][s][h] ||= { n: 0, hits: 0 }); b.n++; if (d * m > 0) b.hits++; }
    }
  }
  return out;
}

export function summarize(records, O = VALIDATION_DEFAULTS, baseline = null) {
  const groups = {};
  for (const r of records) for (const key of [r.kind, `${r.kind}|dir${r.dir}`, `${r.kind}|${r.regime}`]) {
    const isDir = key.includes('|dir'), isReg = !isDir && key.includes('|');
    const g = (groups[key] ||= { key, kind: r.kind, dir: isDir ? r.dir : 0, regime: isReg ? r.regime : 'all', test: {}, train: {}, mfe: [], mae: [], dirs: {} });
    g.dirs[r.dir] = (g.dirs[r.dir] || 0) + 1;
    for (const h of O.horizons) {
      const o = r.outcomes[h]; if (!o) continue;
      const s = (g[r.sample][h] ||= { n: 0, hits: 0 });
      s.n++; if (o.hit) s.hits++;
    }
    if (r.sample === 'test' && r.matured) { g.mfe.push(r.mfe); g.mae.push(r.mae); }
  }
  const med = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
  const out = [];
  for (const g of Object.values(groups)) {
    const bd = g.dir !== 0 ? g.dir : (g.dirs[1] && !g.dirs[-1] ? 1 : g.dirs[-1] && !g.dirs[1] ? -1 : 0);
    const row = { key: g.key, kind: g.kind, dir: g.dir, regime: g.regime, horizons: {}, medianMfeAtr: med(g.mfe), medianMaeAtr: med(g.mae), excursionN: g.mfe.length };
    for (const h of O.horizons) {
      const t = g.test[h] || { n: 0, hits: 0 }, tr = g.train[h] || { n: 0, hits: 0 };
      const w = wilson(t.hits, t.n), insufficient = t.n < O.minN;
      const bt = baseline && bd !== 0 ? baseline[bd].test[h] : null, btr = baseline && bd !== 0 ? baseline[bd].train[h] : null;
      const br = bt ? bt.hits / bt.n : null;
      row.horizons[h] = {
        test: { n: t.n, rate: t.n ? t.hits / t.n : null, ci: w }, train: { n: tr.n, rate: tr.n ? tr.hits / tr.n : null },
        baseline: br == null ? null : { test: br, train: btr ? btr.hits / btr.n : null },
        verdictVsBaseline: insufficient ? 'insufficient' : br == null ? 'no-single-direction' : w.lo > br ? 'above-baseline' : w.hi < br ? 'below-baseline' : 'indistinguishable-from-baseline',
        insufficient,
        verdict: insufficient ? 'insufficient' : w.lo > 0.5 ? 'above-50' : w.hi < 0.5 ? 'below-50' : 'indistinguishable-from-50',
      };
    }
    out.push(row);
  }
  return out.sort((a, b) => (b.horizons[O.horizons[0]]?.test.n ?? 0) - (a.horizons[O.horizons[0]]?.test.n ?? 0));
}
