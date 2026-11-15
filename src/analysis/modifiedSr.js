import { atrSeries, sanitize } from './core.js';
import { findSwings } from './overlays.js';

export const SR_GROUPS = Object.freeze([
  { label: 'Low TFSR', frames: [30, 60, 180, 300, 600] },
  { label: 'Medium TFSR', frames: [900, 1800, 2700] },
  { label: 'High TFSR', frames: [3600, 7200, 14400, 28800] },
  { label: 'Ultra TFSR', frames: [86400, 604800, 2592000] },
]);

export function periodStart(epoch, kind) {
  const d = new Date(epoch * 1000);
  if (kind === 'month') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
  if (kind === 'week') {
    const day = Math.floor(epoch / 86400);
    return (day - ((day + 3) % 7 + 7) % 7) * 86400;
  }
  return Math.floor(epoch / kind) * kind;
}

export function periodEnd(epoch, kind) {
  if (kind === 'month') {
    const d = new Date(epoch * 1000);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000;
  }
  return periodStart(epoch, kind) + (kind === 'week' ? 604800 : kind);
}

// Only complete source sequences are retained; an incomplete current bucket may be displayed.
export function aggregateCandles(source, sourceSeconds, kind, now) {
  const { candles } = sanitize(source);
  const result = [];
  let bucket = null;
  const flush = () => {
    if (!bucket) return;
    const end = periodEnd(bucket.epoch, kind);
    if (bucket.first === bucket.epoch && bucket.contiguous &&
        (end > now || bucket.last + sourceSeconds === end)) {
      result.push({ epoch: bucket.epoch, open: bucket.open, high: bucket.high, low: bucket.low, close: bucket.close });
    }
  };
  for (const c of candles) {
    const start = periodStart(c.epoch, kind);
    if (!bucket || bucket.epoch !== start) {
      flush();
      bucket = { epoch: start, first: c.epoch, last: c.epoch, open: c.open, high: c.high, low: c.low, close: c.close, contiguous: true };
    } else {
      if (c.epoch !== bucket.last + sourceSeconds) bucket.contiguous = false;
      bucket.last = c.epoch;
      bucket.high = Math.max(bucket.high, c.high);
      bucket.low = Math.min(bucket.low, c.low);
      bucket.close = c.close;
    }
  }
  flush();
  return result;
}

function frameAnalysis(input, endOf, now, price) {
  const candles = sanitize(input).candles.filter(c => endOf(c.epoch) <= now);
  if (candles.length < 5) return null;
  const atr = atrSeries(candles).at(-1);
  const swings = findSwings(candles, 2);
  return {
    atr,
    support: swings.lows.map(p => p.price).filter(p => p <= price),
    resistance: swings.highs.map(p => p.price).filter(p => p >= price),
  };
}

function matchingLevels(frames, analyses, role) {
  if (frames.some(g => !analyses[g]) || !Number.isFinite(analyses[frames[0]].atr) || analyses[frames[0]].atr <= 0) return [];
  const tolerance = analyses[frames[0]].atr * 0.25;
  const points = frames.flatMap(g => analyses[g][role].map(price => ({ g, price })))
    .sort((a, b) => a.price - b.price);
  const levels = [];
  for (let i = 0; i < points.length; i++) {
    const chosen = new Map();
    for (let j = i; j < points.length && points[j].price - points[i].price <= tolerance; j++) {
      if (!chosen.has(points[j].g)) chosen.set(points[j].g, points[j].price);
      if (chosen.size === frames.length) {
        const values = [...chosen.values()];
        const price = (Math.min(...values) + Math.max(...values)) / 2;
        if (!levels.some(l => Math.abs(l.price - price) <= tolerance)) levels.push({ price, tolerance });
        break;
      }
    }
  }
  return levels;
}

export function computeModifiedSr(data, now, currentPrice) {
  const frames = SR_GROUPS.flatMap(g => g.frames);
  const analyses = {};
  for (const g of frames) {
    const kind = g === 2592000 ? 'month' : g === 604800 ? 'week' : g;
    analyses[g] = frameAnalysis(data[g] || [], epoch => periodEnd(epoch, kind), now, currentPrice);
  }
  const missing = frames.filter(g => !analyses[g] ||
    (SR_GROUPS.some(group => group.frames[0] === g) && !(analyses[g].atr > 0)));
  const available = frames.filter(g => !missing.includes(g));
  const output = { support: [], resistance: [], available, missing };
  if (!Number.isFinite(currentPrice)) return output;
  for (const role of ['support', 'resistance']) {
    const sure = matchingLevels(frames, analyses, role).map(l => ({ ...l, label: 'Sure TFSR' }));
    const groups = SR_GROUPS.flatMap(group => matchingLevels(group.frames, analyses, role)
      .filter(l => !sure.some(s => Math.abs(s.price - l.price) <= s.tolerance))
      .map(l => ({ ...l, label: group.label })));
    output[role] = [...sure, ...groups].sort((a, b) => a.price - b.price);
  }
  return output;
}
