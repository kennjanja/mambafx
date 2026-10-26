import { DEFAULTS, atrSeries, anatomy } from './core.js';
import { analyzeStructure } from './structure.js';

// Lifecycle-aware zones: order blocks (+breakers), fair value gaps (+IFVG), balanced price ranges
// and rejection blocks. Everything is produced by a single forward pass; a zone's state at bar j
// depends only on bars <= j (see tests/analysis/zones.test.mjs prefix-equivalence tests).
//
// Rules (all thresholds in ZONE_DEFAULTS, ATR units):
//  FVG        3-candle gap: bull if low[i] > high[i-2]; bear if high[i] < low[i-2]. Size >= fvgMinAtr * ATR[i-1].
//             Created (confirmed) at bar i. fill% = deepest wick penetration / gap size.
//             untouched -> partial -> filled (wick through far edge). A *close* beyond the far edge inverts
//             it into an IFVG (or invalidates it when invert=false). Expires if never filled within fvgMaxAge.
//  OB         Last opposite-colour candle (within obLookback bars) before a displacement candle/run.
//             Candidate at the displacement bar; confirmed when a same-direction BOS/CHoCH occurs within
//             obBreakWindow bars, otherwise the candidate expires. Zone = full candle range (or body).
//             First entry into the zone = mitigation; each later re-entry increments testCount.
//             A close beyond the far side invalidates it and, if breakers are enabled, spawns a breaker
//             of the opposite direction on the same bounds. Overlapping same-direction OBs are merged.
//  BPR        Overlap of a bull and a bear FVG formed within bprWindow bars of each other.
//  Rejection  Long-wick candle (wick >= rejWickRatio * body and >= rejWickRange * range) at a confirmed pivot.
//             Zone = the wick. Created at pivot confirmation (not at the wick bar).
// Not implemented: "mitigation blocks" (no unambiguous rule distinct from the breaker conversion above).

export const ZONE_DEFAULTS = Object.freeze({
  fvgMinAtr: 0.4, fvgMaxAge: 200, invert: true,
  obLookback: 10, obBreakWindow: 5, obMaxAge: 300, obUseBody: false, obMergeOverlap: 0.5, breakers: true,
  bprWindow: 10, bprMaxAge: 200,
  rejWickRatio: 2, rejWickRange: 0.5, rejMaxAge: 200,
  structureScale: 'internal',
});

const TERMINAL = new Set(['invalidated', 'expired', 'inverted']);

export function overlapRatio(a, b) {
  const lo = Math.max(a.bottom, b.bottom), hi = Math.min(a.top, b.top);
  if (hi <= lo) return 0;
  return (hi - lo) / Math.min(a.top - a.bottom, b.top - b.bottom);
}

function makeZone(id, kind, dir, bottom, top, createdIndex, confirmedIndex, candles, extra = {}) {
  return {
    id, kind, dir, bottom, top, mid: (top + bottom) / 2, createdIndex, createdEpoch: candles[createdIndex].epoch,
    confirmedIndex, confirmedEpoch: confirmedIndex == null ? null : candles[confirmedIndex].epoch,
    status: 'active', fill: 0, testCount: 0, firstMitigationIndex: null, endIndex: null,
    history: [], outside: true, ...extra,
  };
}

function setStatus(z, status, j) {
  if (z.status === status) return;
  z.status = status; z.history.push({ status, index: j });
  if (TERMINAL.has(status) || (z.kind === 'FVG' && status === 'filled')) z.endIndex = j;
}

export function analyzeZones(candles, opts = {}) {
  const o = { ...DEFAULTS, ...ZONE_DEFAULTS, ...opts };
  const atr = opts.atr || atrSeries(candles, o.atrPeriod);
  const st = opts.structure || analyzeStructure(candles, { ...o, atr });
  const structEvents = (st[o.structureScale] || st.internal).events;
  const pivots = (st[o.structureScale] || st.internal).pivots.confirmed;

  const dispAt = new Map(); for (const d of st.displacement) { (dispAt.get(d.index) || dispAt.set(d.index, []).get(d.index)).push(d); }
  const evAt = new Map(); for (const e of structEvents) { (evAt.get(e.index) || evAt.set(e.index, []).get(e.index)).push(e); }
  const pivAt = new Map(); for (const p of pivots) { (pivAt.get(p.confirmedIndex) || pivAt.set(p.confirmedIndex, []).get(p.confirmedIndex)).push(p); }

  const zones = [];
  let nid = 1;
  const add = (z) => { zones.push(z); return z; };
  const pending = []; // OB candidates awaiting a structure break
  const usedOBCandles = new Set();
  const fvgs = [];

  for (let j = 0; j < candles.length; j++) {
    const c = candles[j];

    // 1) lifecycle of zones that existed before this bar
    for (const z of zones.slice()) {
      if (TERMINAL.has(z.status) || z.confirmedIndex == null || z.confirmedIndex >= j) continue;
      const bull = z.dir === 1;
      const h = z.top - z.bottom;
      const beyond = bull ? c.close < z.bottom : c.close > z.top;
      const entered = bull ? c.low <= z.top : c.high >= z.bottom;
      const depth = Math.max(0, Math.min(1, bull ? (z.top - c.low) / h : (c.high - z.bottom) / h));
      if (entered && z.outside) {
        z.testCount++;
        if (z.firstMitigationIndex == null) z.firstMitigationIndex = j;
      }
      z.outside = !entered;
      if (depth > z.fill) z.fill = depth;
      const age = j - z.confirmedIndex;

      if (beyond) {
        if (z.kind === 'FVG' && o.invert) {
          setStatus(z, 'inverted', j);
          const inv = add(makeZone(nid++, 'IFVG', -z.dir, z.bottom, z.top, z.createdIndex, j, candles, { parentId: z.id }));
          z.ifvgId = inv.id;
        } else {
          setStatus(z, 'invalidated', j);
          if (z.kind === 'OB' && o.breakers) {
            const br = add(makeZone(nid++, 'BREAKER', -z.dir, z.bottom, z.top, z.createdIndex, j, candles, { parentId: z.id }));
            z.breakerId = br.id;
          }
        }
        continue;
      }
      if (z.kind === 'FVG' || z.kind === 'IFVG') {
        if (z.fill >= 1) setStatus(z, 'filled', j);
        else if (z.fill > 0) setStatus(z, 'partial', j);
        if (z.kind === 'FVG' && age > o.fvgMaxAge && z.status !== 'filled') setStatus(z, 'expired', j);
        if (z.kind === 'IFVG' && age > o.fvgMaxAge) setStatus(z, 'expired', j);
      } else {
        if (z.testCount > 0 && z.status === 'active') setStatus(z, 'mitigated', j);
        const maxAge = z.kind === 'BPR' ? o.bprMaxAge : z.kind === 'REJECTION' ? o.rejMaxAge : o.obMaxAge;
        if (age > maxAge) setStatus(z, 'expired', j);
      }
    }

    // 2) pending OB candidates: expire or invalidate
    for (let k = pending.length - 1; k >= 0; k--) {
      const p = pending[k]; const z = p.zone;
      const beyond = z.dir === 1 ? c.close < z.bottom : c.close > z.top;
      if (j > p.dispIndex && beyond) { setStatus(z, 'invalidated', j); pending.splice(k, 1); }
      else if (j - p.dispIndex > o.obBreakWindow) { setStatus(z, 'expired', j); z.reason = 'no-structure-break'; pending.splice(k, 1); }
    }

    // 3) new zones confirmed at bar j
    // FVG
    if (j >= 2 && atr[j - 1]) {
      const a = atr[j - 1], minSize = o.fvgMinAtr * a;
      const bullGap = candles[j].low - candles[j - 2].high, bearGap = candles[j - 2].low - candles[j].high;
      const dir = bullGap >= minSize && bullGap > 0 ? 1 : bearGap >= minSize && bearGap > 0 ? -1 : 0;
      if (dir) {
        const z = add(makeZone(nid++, 'FVG', dir, dir === 1 ? candles[j - 2].high : candles[j].high, dir === 1 ? candles[j].low : candles[j - 2].low, j - 1, j, candles, { sizeAtr: (dir === 1 ? bullGap : bearGap) / a, startIndex: j - 2 }));
        for (const f of fvgs) {
          if (f.dir === -dir && j - f.confirmedIndex <= o.bprWindow && !TERMINAL.has(f.status)) {
            const lo = Math.max(f.bottom, z.bottom), hi = Math.min(f.top, z.top);
            if (hi > lo) add(makeZone(nid++, 'BPR', dir, lo, hi, f.createdIndex, j, candles, { fvgIds: [f.id, z.id] }));
          }
        }
        fvgs.push(z);
      }
    }
    // OB candidates at displacement bars
    for (const d of dispAt.get(j) || []) {
      let k = d.startIndex - 1, found = -1;
      for (; k >= Math.max(0, d.startIndex - o.obLookback); k--) {
        const an = anatomy(candles[k]);
        if (an.dir === -d.dir) { found = k; break; }
      }
      if (found < 0 || usedOBCandles.has(found)) continue;
      const cd = candles[found];
      const bottom = o.obUseBody ? Math.min(cd.open, cd.close) : cd.low, top = o.obUseBody ? Math.max(cd.open, cd.close) : cd.high;
      if (!(top > bottom)) continue;
      const cand = { bottom, top };
      const dup = zones.find(z => z.kind === 'OB' && z.dir === d.dir && !TERMINAL.has(z.status) && overlapRatio(z, cand) >= o.obMergeOverlap);
      if (dup) { dup.merged = (dup.merged || 0) + 1; usedOBCandles.add(found); continue; }
      usedOBCandles.add(found);
      const z = add(makeZone(nid++, 'OB', d.dir, bottom, top, found, null, candles, { displacementIndex: j, candidateIndex: j }));
      z.status = 'candidate'; z.history.push({ status: 'candidate', index: j });
      pending.push({ zone: z, dispIndex: j });
    }
    // structure break promotes candidates
    for (const e of evAt.get(j) || []) {
      for (let k = pending.length - 1; k >= 0; k--) {
        const p = pending[k];
        if (p.zone.dir !== e.dir || j - p.dispIndex > o.obBreakWindow || j < p.dispIndex) continue;
        const z = p.zone; z.confirmedIndex = j; z.confirmedEpoch = c.epoch; z.breakType = e.type; z.mss = e.mss;
        z.status = 'active'; z.history.push({ status: 'active', index: j });
        pending.splice(k, 1);
      }
    }
    // rejection blocks at pivot confirmation
    for (const p of pivAt.get(j) || []) {
      const cd = candles[p.index], an = anatomy(cd);
      const wick = p.type === 'high' ? an.upperWick : an.lowerWick;
      if (an.range > 0 && wick >= o.rejWickRatio * Math.max(an.body, 1e-12) && wick >= o.rejWickRange * an.range) {
        const bottom = p.type === 'high' ? Math.max(cd.open, cd.close) : cd.low;
        const top = p.type === 'high' ? cd.high : Math.min(cd.open, cd.close);
        if (top > bottom) add(makeZone(nid++, 'REJECTION', p.type === 'high' ? -1 : 1, bottom, top, p.index, j, candles, {}));
      }
    }
  }
  return { zones, atr, structure: st };
}

// Zones containing a price, newest first; optionally restricted to live (non-terminal) zones.
export function zonesAtPrice(zones, price, { liveOnly = true } = {}) {
  return zones.filter(z => z.confirmedIndex != null && price >= z.bottom && price <= z.top && (!liveOnly || !TERMINAL.has(z.status) && z.status !== 'candidate'))
    .sort((a, b) => b.confirmedIndex - a.confirmedIndex);
}

// Pairs of live zones that overlap, with their overlap ratio (confluence).
export function zoneConfluence(zones, minRatio = 0.25) {
  const live = zones.filter(z => z.confirmedIndex != null && !TERMINAL.has(z.status) && z.status !== 'candidate');
  const out = [];
  for (let a = 0; a < live.length; a++) for (let b = a + 1; b < live.length; b++) {
    if (live[a].kind === live[b].kind && live[a].dir === live[b].dir) continue; // same-type duplicates are merged elsewhere
    const r = overlapRatio(live[a], live[b]);
    if (r >= minRatio) out.push({ a: live[a].id, b: live[b].id, ratio: r, sameDir: live[a].dir === live[b].dir });
  }
  return out;
}
