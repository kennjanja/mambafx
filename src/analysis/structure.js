import { DEFAULTS, atrSeries } from './core.js';
import { detectPivots } from './pivots.js';
import { detectDisplacement } from './displacement.js';

// BOS / CHoCH / MSS from confirmed pivots only.
//  - BOS   : break of the latest confirmed pivot in the direction of the prevailing trend (or first break).
//  - CHoCH : break against the prevailing trend.
//  - MSS   : a CHoCH accompanied by same-direction displacement on the break candle or the 2 bars before.
// A pivot is usable only from its confirmedIndex onwards, and is consumed by the first break, so
// results at bar i never depend on bars after i. 'close' mode needs a close beyond the level,
// 'wick' mode needs the high/low to trade beyond it. If one bar breaks both sides in wick mode,
// only the side matching the candle colour is taken.
export function detectStructure(candles, pivots, displacement, opts = {}) {
  const mode = opts.breakMode ?? DEFAULTS.breakMode;
  const lastClosed = opts.lastCandleClosed !== false;
  const byConfirm = new Map();
  for (const p of pivots) {
    if (!byConfirm.has(p.confirmedIndex)) byConfirm.set(p.confirmedIndex, []);
    byConfirm.get(p.confirmedIndex).push(p);
  }
  const dispAt = new Map(displacement.map(d => [d.index, d]));
  const events = [];
  let hi = null, lo = null, trend = 0;
  for (let i = 0; i < candles.length; i++) {
    for (const p of byConfirm.get(i) || []) (p.type === 'high' ? (hi = p) : (lo = p));
    const c = candles[i];
    const upBreak = hi && (mode === 'wick' ? c.high > hi.price : c.close > hi.price);
    const dnBreak = lo && (mode === 'wick' ? c.low < lo.price : c.close < lo.price);
    let dir = 0;
    if (upBreak && dnBreak) dir = c.close >= c.open ? 1 : -1;
    else if (upBreak) dir = 1; else if (dnBreak) dir = -1;
    if (!dir) continue;
    const piv = dir === 1 ? hi : lo;
    const type = trend !== 0 && trend !== dir ? 'CHoCH' : 'BOS';
    let disp = null;
    for (let k = i; k >= Math.max(0, i - 2); k--) { const d = dispAt.get(k); if (d && d.dir === dir) { disp = d; break; } }
    events.push({
      type, dir, level: piv.price, pivotIndex: piv.index, pivotConfirmedIndex: piv.confirmedIndex,
      index: i, epoch: c.epoch, confirmedIndex: i, mode,
      mss: type === 'CHoCH' && !!disp, displacementIndex: disp ? disp.index : null,
      status: !lastClosed && i === candles.length - 1 ? 'provisional' : 'confirmed',
    });
    if (dir === 1) hi = null; else lo = null;
    trend = dir;
  }
  return { events, trend, openHigh: hi, openLow: lo };
}

export function analyzeStructure(candles, opts = {}) {
  const atr = opts.atr || atrSeries(candles, opts.atrPeriod ?? DEFAULTS.atrPeriod);
  const displacement = opts.displacement || detectDisplacement(candles, atr, opts);
  const scales = {
    internal: opts.internalPivot ?? DEFAULTS.internalPivot,
    swing: opts.swingPivot ?? DEFAULTS.swingPivot,
  };
  const out = { atr, displacement };
  for (const [name, w] of Object.entries(scales)) {
    const pv = detectPivots(candles, w);
    out[name] = { pivots: pv, ...detectStructure(candles, pv.confirmed, displacement, opts) };
  }
  return out;
}
