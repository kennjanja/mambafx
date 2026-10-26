// Phase 5: levels and context layers. Pure, deterministic; items carry `confirmedIndex`.
//
// PROXY LABELS: this feed has no traded volume. Anchored VWAP weights every candle equally
// (typical price) and the volume profile is a time-at-price (TPO-style) profile. Both are
// price-structure proxies, not volume measures, and are labelled `proxy: true`.
// Scores are heuristic rankings, not probabilities.

import { sanitize, atrSeries, DEFAULTS, dayId, weekId } from './core.js';
import { detectPivots } from './pivots.js';
import { detectDisplacement } from './displacement.js';

export const LEVEL_DEFAULTS = Object.freeze({
  pivotWindow: 5, srTolAtr: 0.25, srMaxVisible: 6, srMaxAge: 400,
  sdBaseMaxAtr: 0.6, sdBaseMaxBars: 3, sdMaxAge: 300,
  fibLevels: [0, 0.236, 0.382, 0.5, 0.618, 0.705, 0.786, 1, -0.27, -0.62, 1.272, 1.618],
  emaPeriods: [20, 50, 200],
  profileBins: 24, valueArea: 0.7, profileBars: 200,
  amdRangeBars: 20, amdRangeAtr: 3,
});

const sma = (a) => a.reduce((s, v) => s + v, 0) / a.length;

export function ema(candles, period) {
  const out = new Array(candles.length).fill(null);
  if (candles.length < period) return out;
  const k = 2 / (period + 1);
  let prev = sma(candles.slice(0, period).map((c) => c.close));
  out[period - 1] = prev;
  for (let i = period; i < candles.length; i++) { prev = candles[i].close * k + prev * (1 - k); out[i] = prev; }
  return out;
}

// Support/resistance zones: confirmed pivots clustered within tolerance*ATR (ATR at the latest member's confirmation).
// A zone is built incrementally, so its state at bar k depends only on pivots confirmed by k.
export function srZones(candles, atr, opts = {}) {
  const P = { ...LEVEL_DEFAULTS, ...opts };
  const { confirmed } = detectPivots(candles, P.pivotWindow);
  const zones = [];
  for (const p of confirmed) {
    const a = atr[p.confirmedIndex];
    if (a == null) continue;
    const tol = P.srTolAtr * a;
    let z = zones.find((q) => q.status !== 'expired' && Math.abs(q.level - p.price) <= tol);
    if (z) {
      z.touches++; z.pivotIndices.push(p.index);
      z.low = Math.min(z.low, p.price); z.high = Math.max(z.high, p.price);
      z.level = (z.low + z.high) / 2; z.lastTouchIndex = p.index; z.updatedIndex = p.confirmedIndex;
    } else {
      zones.push({ id: 'sr-' + p.index, kind: 'SR', level: p.price, low: p.price, high: p.price, touches: 1,
        pivotIndices: [p.index], createdIndex: p.index, confirmedIndex: p.confirmedIndex, lastTouchIndex: p.index,
        updatedIndex: p.confirmedIndex, role: p.type === 'high' ? 'resistance' : 'support', flips: 0, status: 'active', history: [] });
    }
  }
  // walk candles to apply flips / expiry; only closes after confirmation matter
  for (const z of zones) {
    for (let i = z.confirmedIndex + 1; i < candles.length; i++) {
      const a = atr[i - 1] ?? 0, buf = P.srTolAtr * a, cl = candles[i].close;
      if (i - z.lastTouchIndex > P.srMaxAge) { z.status = 'expired'; z.endIndex = i; z.history.push({ status: 'expired', index: i }); break; }
      if (z.role === 'resistance' && cl > z.high + buf) { z.role = 'support'; z.flips++; z.history.push({ status: 'flip-to-support', index: i }); }
      else if (z.role === 'support' && cl < z.low - buf) { z.role = 'resistance'; z.flips++; z.history.push({ status: 'flip-to-resistance', index: i }); }
    }
    // heuristic strength: touches, flips, recency of last touch (ranking only)
    const last = candles.length - 1;
    z.score = z.touches + 0.5 * z.flips - (last - z.lastTouchIndex) / 200;
  }
  return zones;
}

export function topSrZones(zones, price, max = LEVEL_DEFAULTS.srMaxVisible) {
  return zones.filter((z) => z.status === 'active').sort((a, b) => b.score - a.score).slice(0, max)
    .sort((a, b) => Math.abs(a.level - price) - Math.abs(b.level - price));
}

// Supply/demand: 1..N small-range base candles followed by a displacement leaving the base.
export function supplyDemand(candles, atr, opts = {}) {
  const P = { ...LEVEL_DEFAULTS, ...opts };
  const disp = detectDisplacement(candles, atr, DEFAULTS);
  const zones = [];
  const used = new Set();
  for (const d of disp) {
    const first = d.startIndex ?? d.index;
    const dirBase = d.dir;
    let b = first - 1; const base = [];
    while (b >= 0 && base.length < P.sdBaseMaxBars && atr[b] != null && (candles[b].high - candles[b].low) <= P.sdBaseMaxAtr * atr[b]) { base.push(b); b--; }
    if (!base.length) continue;
    const lo = Math.min(...base.map((i) => candles[i].low)), hi = Math.max(...base.map((i) => candles[i].high));
    const key = base[base.length - 1];
    if (used.has(key)) continue; used.add(key);
    const z = { id: 'sd-' + key, kind: dirBase === 1 ? 'DEMAND' : 'SUPPLY', dir: dirBase, bottom: lo, top: hi,
      createdIndex: base[base.length - 1], baseIndices: base.slice().reverse(), displacementIndex: d.index,
      confirmedIndex: d.confirmedIndex ?? d.index, status: 'active', testCount: 0, history: [] };
    let inside = false;
    for (let i = z.confirmedIndex + 1; i < candles.length; i++) {
      const c = candles[i];
      if (i - z.confirmedIndex > P.sdMaxAge) { z.status = 'expired'; z.endIndex = i; z.history.push({ status: 'expired', index: i }); break; }
      if (dirBase === 1 ? c.close < lo : c.close > hi) { z.status = 'invalidated'; z.endIndex = i; z.history.push({ status: 'invalidated', index: i }); break; }
      const touching = c.low <= hi && c.high >= lo;
      if (touching && !inside) { z.testCount++; if (z.testCount === 1) z.history.push({ status: 'tested', index: i }); }
      inside = touching;
    }
    zones.push(z);
  }
  return zones;
}

// Premium/discount 25/50/75 of the most recent confirmed swing range (known at bar `k`).
export function premiumDiscount(candles, opts = {}) {
  const P = { ...LEVEL_DEFAULTS, ...opts };
  const { confirmed } = detectPivots(candles, P.pivotWindow);
  const hi = [...confirmed].reverse().find((p) => p.type === 'high');
  const lo = [...confirmed].reverse().find((p) => p.type === 'low');
  if (!hi || !lo) return null;
  const top = hi.price, bottom = lo.price;
  if (top <= bottom) return null;
  const px = candles[candles.length - 1].close;
  const at = (f) => bottom + (top - bottom) * f;
  const pos = (px - bottom) / (top - bottom);
  return { top, bottom, q25: at(0.25), eq: at(0.5), q75: at(0.75), position: pos,
    zone: pos > 0.5 ? 'premium' : pos < 0.5 ? 'discount' : 'equilibrium', confirmedIndex: Math.max(hi.confirmedIndex, lo.confirmedIndex) };
}

// Fibonacci / OTE on the latest confirmed leg (older pivot -> newer pivot of opposite type).
export function fibLevels(candles, opts = {}) {
  const P = { ...LEVEL_DEFAULTS, ...opts };
  const { confirmed } = detectPivots(candles, P.pivotWindow);
  if (confirmed.length < 2) return null;
  const b = confirmed[confirmed.length - 1];
  const a = [...confirmed].reverse().find((p) => p.type !== b.type);
  if (!a) return null;
  const up = b.type === 'high'; // leg a->b upward
  const from = a.price, to = b.price, d = to - from;
  if (d === 0) return null;
  // retracement r measured back from the leg end; extensions beyond the leg end
  const levels = P.fibLevels.map((r) => ({ ratio: r, price: to - d * r }));
  const ote = { ratio: 0.705, price: to - d * 0.705, low: Math.min(to - d * 0.62, to - d * 0.79), high: Math.max(to - d * 0.62, to - d * 0.79) };
  return { dir: up ? 1 : -1, from: { index: a.index, price: from }, to: { index: b.index, price: to }, levels, ote,
    confirmedIndex: b.confirmedIndex, note: 'ratios: 0=leg end, 1=leg start; negative=beyond the leg end for retracement view; 1.272/1.618 are projections of the leg from its start' };
}

// Trendlines through the last two confirmed pivots of each type; touches counted on later pivots,
// broken on the first close beyond the line by more than 0.25 ATR.
export function trendlines(candles, atr, opts = {}) {
  const P = { ...LEVEL_DEFAULTS, ...opts };
  const { confirmed } = detectPivots(candles, P.pivotWindow);
  const out = [];
  for (const type of ['high', 'low']) {
    const ps = confirmed.filter((p) => p.type === type);
    for (let k = 1; k < ps.length; k++) {
      const p1 = ps[k - 1], p2 = ps[k];
      if (p2.index - p1.index < 5) continue;
      const slope = (p2.price - p1.price) / (p2.index - p1.index);
      // supports must rise-or-fall freely; a trendline is only meaningful if it doesn't cut price between its anchors
      let cuts = false;
      for (let i = p1.index + 1; i < p2.index; i++) {
        const lv = p1.price + slope * (i - p1.index);
        if (type === 'low' ? candles[i].low < lv - 1e-9 : candles[i].high > lv + 1e-9) { cuts = true; break; }
      }
      if (cuts) continue;
      const t = { id: `tl-${type}-${p1.index}-${p2.index}`, kind: type === 'low' ? 'support-line' : 'resistance-line', p1, p2, slope,
        confirmedIndex: p2.confirmedIndex, touches: 2, status: 'active', history: [] };
      for (let i = p2.confirmedIndex + 1; i < candles.length; i++) {
        const lv = p1.price + slope * (i - p1.index), a = atr[i - 1] ?? 0;
        if (type === 'low' ? candles[i].close < lv - P.srTolAtr * a : candles[i].close > lv + P.srTolAtr * a) { t.status = 'broken'; t.breakIndex = i; t.history.push({ status: 'broken', index: i }); break; }
      }
      for (const q of ps.slice(k + 1)) {
        if (t.breakIndex != null && q.confirmedIndex > t.breakIndex) break;
        const lv = p1.price + slope * (q.index - p1.index);
        if (Math.abs(q.price - lv) <= P.srTolAtr * (atr[q.confirmedIndex] ?? Infinity)) t.touches++;
      }
      out.push(t);
    }
  }
  return out;
}

// AMD (accumulation -> manipulation -> distribution) per-bar state machine.
// accumulation: a tight range (<= amdRangeAtr * ATR over amdRangeBars); manipulation: a wick sweeps a range
// extreme and closes back inside; distribution: a close beyond the opposite extreme after manipulation.
export function amdStates(candles, atr, opts = {}) {
  const P = { ...LEVEL_DEFAULTS, ...opts };
  const out = new Array(candles.length).fill(null);
  let st = 'none', range = null, manip = null;
  for (let i = P.amdRangeBars; i < candles.length; i++) {
    const c = candles[i], a = atr[i - 1];
    if (a == null) { continue; }
    if (st === 'none' || st === 'distribution') {
      const w = candles.slice(i - P.amdRangeBars, i);
      const hi = Math.max(...w.map((x) => x.high)), lo = Math.min(...w.map((x) => x.low));
      if (hi - lo <= P.amdRangeAtr * a) { st = 'accumulation'; range = { hi, lo, startIndex: i - P.amdRangeBars }; manip = null; }
    } else if (st === 'accumulation') {
      if (c.high > range.hi && c.close <= range.hi) { st = 'manipulation'; manip = { side: 'up', index: i }; }
      else if (c.low < range.lo && c.close >= range.lo) { st = 'manipulation'; manip = { side: 'down', index: i }; }
      else if (c.close > range.hi || c.close < range.lo) { st = 'none'; range = null; } // plain breakout, not AMD
    } else if (st === 'manipulation') {
      if (manip.side === 'down' && c.close > range.hi) { st = 'distribution'; }
      else if (manip.side === 'up' && c.close < range.lo) { st = 'distribution'; }
      else if (i - manip.index > 10) { st = 'none'; range = null; } // failed: no distribution in time
    }
    out[i] = { index: i, state: st, range: range ? { ...range } : null, manipulation: manip ? { ...manip } : null,
      distributionDir: st === 'distribution' ? (manip.side === 'down' ? 1 : -1) : null };
  }
  return out;
}

// Opens and classic floor pivots from the *previous completed* UTC day (no look-ahead).
export function referenceOpens(candles) {
  const out = new Array(candles.length).fill(null);
  let curDay = null, curWeek = null, dayOpen = null, weekOpen = null, dayH = 0, dayL = 0, dayC = 0, prev = null;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i], d = dayId(c.epoch), w = weekId(c.epoch);
    if (d !== curDay) {
      if (curDay != null) prev = { high: dayH, low: dayL, close: dayC };
      curDay = d; dayOpen = c.open; dayH = c.high; dayL = c.low;
    } else { dayH = Math.max(dayH, c.high); dayL = Math.min(dayL, c.low); }
    dayC = c.close;
    if (w !== curWeek) { curWeek = w; weekOpen = c.open; }
    let pivots = null;
    if (prev) {
      const pp = (prev.high + prev.low + prev.close) / 3;
      pivots = { pp, r1: 2 * pp - prev.low, s1: 2 * pp - prev.high, r2: pp + (prev.high - prev.low), s2: pp - (prev.high - prev.low) };
    }
    out[i] = { dayOpen, weekOpen, pivots };
  }
  return out;
}

// Anchored VWAP PROXY: equal weight per candle on typical price (no volume available).
export function anchoredVwapProxy(candles, anchorIndex) {
  const out = new Array(candles.length).fill(null);
  let s = 0, n = 0;
  for (let i = Math.max(0, anchorIndex); i < candles.length; i++) {
    s += (candles[i].high + candles[i].low + candles[i].close) / 3; n++;
    out[i] = s / n;
  }
  return { values: out, proxy: true, anchorIndex, note: 'equal-weight typical price; not volume weighted' };
}

// Time-at-price profile PROXY over the last N bars: each candle spreads one unit across the bins its range touches.
export function volumeProfileProxy(candles, opts = {}) {
  const P = { ...LEVEL_DEFAULTS, ...opts };
  const w = candles.slice(-P.profileBars);
  if (w.length < 5) return null;
  const hi = Math.max(...w.map((c) => c.high)), lo = Math.min(...w.map((c) => c.low));
  if (hi <= lo) return null;
  const nb = P.profileBins, step = (hi - lo) / nb, bins = new Array(nb).fill(0);
  for (const c of w) {
    const b0 = Math.min(nb - 1, Math.floor((c.low - lo) / step)), b1 = Math.min(nb - 1, Math.floor((c.high - lo) / step));
    for (let b = b0; b <= b1; b++) bins[b] += 1 / (b1 - b0 + 1);
  }
  let poc = 0; for (let b = 1; b < nb; b++) if (bins[b] > bins[poc]) poc = b;
  const total = bins.reduce((s, v) => s + v, 0);
  let acc = bins[poc], l = poc, h = poc;
  while (acc < P.valueArea * total && (l > 0 || h < nb - 1)) {
    const dn = l > 0 ? bins[l - 1] : -1, up = h < nb - 1 ? bins[h + 1] : -1;
    if (up >= dn) { h++; acc += bins[h]; } else { l--; acc += bins[l]; }
  }
  return { proxy: true, poc: lo + (poc + 0.5) * step, val: lo + l * step, vah: lo + (h + 1) * step, bins, lo, hi, step,
    note: 'time-at-price proxy, not traded volume' };
}

export function analyzeLevels(input, opts = {}) {
  const { candles, dropped } = sanitize(input);
  const atr = atrSeries(candles, opts.atrPeriod || DEFAULTS.atrPeriod);
  const P = { ...LEVEL_DEFAULTS, ...opts };
  const emas = {}; for (const p of P.emaPeriods) emas[p] = ema(candles, p);
  const amd = amdStates(candles, atr, opts);
  const lastSweep = [...amd].reverse().find((s) => s && s.manipulation);
  return {
    candles, dropped, atr,
    sr: srZones(candles, atr, opts), supplyDemand: supplyDemand(candles, atr, opts),
    premiumDiscount: premiumDiscount(candles, opts), fib: fibLevels(candles, opts),
    trendlines: trendlines(candles, atr, opts), amd, emas,
    opens: referenceOpens(candles),
    vwap: anchoredVwapProxy(candles, lastSweep ? lastSweep.manipulation.index : Math.max(0, candles.length - 100)),
    profile: volumeProfileProxy(candles, opts),
  };
}
