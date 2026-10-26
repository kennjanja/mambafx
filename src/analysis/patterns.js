// Phase 4: candle patterns, volatility regimes, classical chart patterns, Wyckoff-style events.
// Pure and deterministic. Every output carries `index` and `confirmedIndex` (first bar at which it
// was knowable); nothing at bar i uses bars after i.
//
// Implemented chart patterns: double/triple top & bottom, head & shoulders (+inverse),
// rising/falling/symmetrical triangles, rising/falling wedges, rectangles, parallel channels.
// NOT implemented (no unambiguous rule): flags/pennants, broadening formations, AB=CD.
// Volume-based Wyckoff ideas (effort vs result) use range/body as a proxy; tick volume is not volume.
// These are descriptive detections, not forecasts. A "confirmed" pattern is a close beyond its
// trigger line, nothing more.

import { sanitize, atrSeries, anatomy, DEFAULTS } from './core.js';
import { detectPivots } from './pivots.js';

export const PATTERN_DEFAULTS = Object.freeze({
  pinWickRatio: 2, pinMaxBody: 0.35, nrWindows: [4, 7],
  atrPctWindow: 100, regimeLow: 0.2, regimeHigh: 0.8,
  bbPeriod: 20, bbMult: 2, kcMult: 1.5,
  pivotWindow: 3, patternTolAtr: 0.5, patternMaxBars: 120, patternMaxAge: 200,
  wedgeSlopeAtr: 0.02, // per-bar slope (ATR units) below which a line counts as flat
  springLookback: 20, srEffortMult: 1.5,
});

const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;

export function candlePatterns(candles, atr) {
  const out = [];
  const add = (index, kind, dir, extra = {}) => out.push({ index, confirmedIndex: index, kind, dir, ...extra });
  const P = PATTERN_DEFAULTS;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i], a = anatomy(c);
    if (a.range <= 0) continue;
    const prev = i > 0 ? candles[i - 1] : null, pa = prev ? anatomy(prev) : null;
    const atrPrev = i > 0 ? atr[i - 1] : null;
    // pin bar family: dominant wick, small body in the opposite third
    if (a.bodyRatio <= P.pinMaxBody && (atrPrev == null || a.range >= 0.5 * atrPrev)) {
      if (a.lowerWick >= P.pinWickRatio * a.body && a.lowerWick > 2 * a.upperWick) add(i, 'pin-bar', 1, { name: 'hammer' });
      if (a.upperWick >= P.pinWickRatio * a.body && a.upperWick > 2 * a.lowerWick) add(i, 'pin-bar', -1, { name: 'shooting-star' });
    }
    if (prev && pa.body > 0 && a.body > 0) {
      const pTop = Math.max(prev.open, prev.close), pBot = Math.min(prev.open, prev.close);
      const top = Math.max(c.open, c.close), bot = Math.min(c.open, c.close);
      if (a.dir === 1 && pa.dir === -1 && top >= pTop && bot <= pBot && a.body > pa.body) add(i, 'engulfing', 1);
      if (a.dir === -1 && pa.dir === 1 && top >= pTop && bot <= pBot && a.body > pa.body) add(i, 'engulfing', -1);
    }
    if (prev) {
      if (c.high <= prev.high && c.low >= prev.low) add(i, 'inside-bar', 0);
      else if (c.high > prev.high && c.low < prev.low) add(i, 'outside-bar', 0);
    }
    for (const n of P.nrWindows) {
      if (i >= n - 1) {
        let narrowest = true;
        for (let k = i - n + 1; k < i; k++) if (candles[k].high - candles[k].low <= a.range) { narrowest = false; break; }
        if (narrowest) add(i, 'NR' + n, 0);
      }
    }
    // three-bar reversal: strong move, small-body/failed continuation, then close beyond the first bar
    if (i >= 2) {
      const c0 = candles[i - 2], c1 = candles[i - 1], a0 = anatomy(c0);
      if (a0.dir === -1 && c1.low < c0.low && c.close > c0.high && a.dir === 1) add(i, 'three-bar-reversal', 1);
      if (a0.dir === 1 && c1.high > c0.high && c.close < c0.low && a.dir === -1) add(i, 'three-bar-reversal', -1);
    }
  }
  return out;
}

// Rolling-window ATR percentile (rank of atr[i] among the previous `window` values incl. itself).
export function volatilityRegimes(candles, atr, opts = {}) {
  const P = { ...PATTERN_DEFAULTS, ...opts };
  const n = candles.length, series = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (atr[i] == null) continue;
    const from = Math.max(0, i - P.atrPctWindow + 1);
    let below = 0, cnt = 0;
    for (let k = from; k <= i; k++) if (atr[k] != null) { cnt++; if (atr[k] <= atr[i]) below++; }
    const pct = cnt >= 20 ? below / cnt : null; // too few observations => unknown, not a guess
    // squeeze: Bollinger bands inside Keltner channel
    let squeeze = null;
    if (i >= P.bbPeriod - 1) {
      const cl = candles.slice(i - P.bbPeriod + 1, i + 1).map((c) => c.close);
      const m = mean(cl), sd = Math.sqrt(mean(cl.map((v) => (v - m) ** 2)));
      squeeze = m + P.bbMult * sd < m + P.kcMult * atr[i] && m - P.bbMult * sd > m - P.kcMult * atr[i];
    }
    const regime = pct == null ? 'unknown' : pct <= P.regimeLow ? 'low' : pct >= P.regimeHigh ? 'high' : 'normal';
    const rng = candles[i].high - candles[i].low;
    series[i] = { index: i, atrPercentile: pct, regime, squeeze, rangeVsAtr: rng / atr[i] };
  }
  const transitions = [];
  for (let i = 1; i < n; i++) {
    const a = series[i - 1], b = series[i];
    if (a && b && a.squeeze === true && b.squeeze === false) transitions.push({ index: i, confirmedIndex: i, kind: 'squeeze-release' });
    if (a && b && a.regime !== b.regime && a.regime !== 'unknown') transitions.push({ index: i, confirmedIndex: i, kind: 'regime-change', from: a.regime, to: b.regime });
  }
  return { series, transitions };
}

const lineAt = (p1, p2, x) => p1.price + ((p2.price - p1.price) / (p2.index - p1.index)) * (x - p1.index);

// Resolve a pattern after formation: first close beyond trigger => confirmed; first close back through
// the opposite invalidation level (or max age) => failed / expired. History is stamped per bar.
function resolve(candles, pat, startIdx, trigger, invalid, P) {
  pat.history = [{ status: 'forming', index: pat.formedIndex }];
  pat.status = 'forming';
  for (let i = startIdx; i < candles.length; i++) {
    const c = candles[i];
    const t = trigger(i), v = invalid(i);
    if (pat.status === 'forming') {
      if (pat.dir === 1 ? c.close > t : c.close < t) { pat.status = 'confirmed'; pat.breakIndex = i; pat.history.push({ status: 'confirmed', index: i }); }
      else if (pat.dir === 1 ? c.close < v : c.close > v) { pat.status = 'invalidated'; pat.history.push({ status: 'invalidated', index: i }); break; }
      else if (i - pat.formedIndex > P.patternMaxAge) { pat.status = 'expired'; pat.history.push({ status: 'expired', index: i }); break; }
    } else if (pat.status === 'confirmed') {
      if (pat.dir === 1 ? c.close < v : c.close > v) { pat.status = 'failed'; pat.failIndex = i; pat.history.push({ status: 'failed', index: i }); break; }
    }
  }
  pat.confirmedIndex = pat.formedIndex;
  return pat;
}

export function chartPatterns(candles, atr, opts = {}) {
  const P = { ...PATTERN_DEFAULTS, ...opts };
  const { confirmed } = detectPivots(candles, P.pivotWindow);
  const out = [];
  const seen = new Set();
  const push = (pat, start, trig, inv) => {
    const key = pat.kind + pat.pivots.map((p) => p.index).join('-');
    if (seen.has(key)) return;
    seen.add(key);
    pat.id = key;
    out.push(resolve(candles, pat, start, trig, inv, P));
  };
  const hist = [];
  // Pivots confirmed on the same bar (e.g. an outside bar gives a high and a low) join history together,
  // so results do not depend on their arbitrary order (mirror symmetry).
  for (let gi = 0; gi < confirmed.length; gi++) {
    const p = confirmed[gi];
    if (gi === 0 || confirmed[gi - 1].confirmedIndex !== p.confirmedIndex) {
      for (let k = gi; k < confirmed.length && confirmed[k].confirmedIndex === p.confirmedIndex; k++) hist.push(confirmed[k]);
    }
    const a = atr[p.confirmedIndex];
    if (a == null) continue;
    const tol = P.patternTolAtr * a;
    const f = p.confirmedIndex;
    const ofType = (t) => hist.filter((q) => q.type === t && p.index - q.index <= P.patternMaxBars);
    for (const [t, dir, opp] of [['high', -1, 'low'], ['low', 1, 'high']]) {
      if (p.type !== t) continue;
      const same = ofType(t), others = ofType(opp);
      // double / triple top or bottom
      for (const n of [2, 3]) {
        if (same.length < n) continue;
        const pts = same.slice(-n);
        if (pts[n - 1] !== p) continue;
        const px = pts.map((q) => q.price);
        if (Math.max(...px) - Math.min(...px) > tol) continue;
        const between = others.filter((q) => q.index > pts[0].index && q.index < p.index);
        if (between.length < n - 1) continue;
        const neck = dir === -1 ? Math.min(...between.map((q) => q.price)) : Math.max(...between.map((q) => q.price));
        const ext = dir === -1 ? Math.max(...px) : Math.min(...px);
        push({ kind: (n === 2 ? 'double-' : 'triple-') + (dir === -1 ? 'top' : 'bottom'), dir, pivots: pts, neckline: neck, formedIndex: f, index: p.index },
          f + 1, () => neck, () => (dir === -1 ? ext + tol : ext - tol));
        break;
      }
      // head & shoulders: three same-type pivots, middle most extreme, shoulders similar
      if (same.length >= 3) {
        const [l, h, r] = same.slice(-3);
        if (r === p) {
          const hx = dir === -1 ? h.price > Math.max(l.price, r.price) : h.price < Math.min(l.price, r.price);
          const sh = Math.abs(l.price - r.price) <= 1.5 * tol * 2;
          const nl = others.filter((q) => q.index > l.index && q.index < r.index);
          if (hx && sh && nl.length >= 2) {
            const n1 = nl[0], n2 = nl[nl.length - 1];
            if (n2.index > n1.index) {
              push({ kind: dir === -1 ? 'head-shoulders' : 'inverse-head-shoulders', dir, pivots: [l, h, r], neckline: n2.price, formedIndex: f, index: r.index, necklinePts: [n1, n2] },
                f + 1, (i) => lineAt(n1, n2, i), () => h.price);
            }
          }
        }
      }
    }
    // two-line patterns from the last two highs and two lows
    const hi = hist.filter((q) => q.type === 'high' && p.index - q.index <= P.patternMaxBars).slice(-2);
    const lo = hist.filter((q) => q.type === 'low' && p.index - q.index <= P.patternMaxBars).slice(-2);
    if (hi.length === 2 && lo.length === 2 && (p === hi[1] || p === lo[1])) {
      const sH = (hi[1].price - hi[0].price) / (hi[1].index - hi[0].index) / a;
      const sL = (lo[1].price - lo[0].price) / (lo[1].index - lo[0].index) / a;
      const flat = (s) => Math.abs(s) < P.wedgeSlopeAtr;
      const gapStart = lineAt(hi[0], hi[1], Math.max(hi[0].index, lo[0].index)) - lineAt(lo[0], lo[1], Math.max(hi[0].index, lo[0].index));
      const gapEnd = lineAt(hi[0], hi[1], f) - lineAt(lo[0], lo[1], f);
      let kind = null;
      if (gapEnd > 0 && gapStart > 0) {
        const conv = gapEnd < 0.8 * gapStart;
        if (flat(sH) && flat(sL)) kind = 'rectangle';
        else if (conv && flat(sH) && sL > 0) kind = 'ascending-triangle';
        else if (conv && flat(sL) && sH < 0) kind = 'descending-triangle';
        else if (conv && sH < 0 && sL > 0) kind = 'symmetrical-triangle';
        else if (conv && sH > 0 && sL > 0) kind = 'rising-wedge';
        else if (conv && sH < 0 && sL < 0) kind = 'falling-wedge';
        else if (!conv && gapEnd > 0.8 * gapStart && Math.abs(sH - sL) < P.wedgeSlopeAtr && !flat((sH + sL) / 2)) kind = 'channel';
      }
      if (kind) {
        const dir = kind === 'ascending-triangle' || kind === 'falling-wedge' ? 1 : kind === 'descending-triangle' || kind === 'rising-wedge' ? -1 : 0;
        const pts = [...hi, ...lo].sort((x, y) => x.index - y.index);
        const upper = (i) => lineAt(hi[0], hi[1], i), lower = (i) => lineAt(lo[0], lo[1], i);
        if (dir !== 0) {
          push({ kind, dir, pivots: pts, formedIndex: f, index: pts[pts.length - 1].index, upper: [hi[0], hi[1]], lower: [lo[0], lo[1]] },
            f + 1, dir === 1 ? upper : lower, dir === 1 ? lower : upper);
        } else {
          // neutral shape: confirmed by a close beyond either line; direction = the side that broke
          const pat = { kind, dir: 0, pivots: pts, formedIndex: f, index: pts[pts.length - 1].index, upper: [hi[0], hi[1]], lower: [lo[0], lo[1]], status: 'forming', history: [{ status: 'forming', index: f }], confirmedIndex: f };
          const key = kind + pts.map((q) => q.index).join('-');
          if (!seen.has(key)) {
            seen.add(key); pat.id = key;
            for (let i = f + 1; i < candles.length; i++) {
              const cl = candles[i].close;
              if (cl > upper(i)) { pat.status = 'confirmed'; pat.dir = 1; pat.breakIndex = i; pat.history.push({ status: 'confirmed', index: i }); break; }
              if (cl < lower(i)) { pat.status = 'confirmed'; pat.dir = -1; pat.breakIndex = i; pat.history.push({ status: 'confirmed', index: i }); break; }
              if (i - f > P.patternMaxAge) { pat.status = 'expired'; pat.history.push({ status: 'expired', index: i }); break; }
            }
            out.push(pat);
          }
        }
      }
    }
  }
  return out;
}

// Wyckoff-style events. Spring/upthrust: a wick pierces a prior range extreme and closes back inside.
// SOS/SOW: displacement-like close beyond the range. Effort vs result uses range as a volume PROXY.
export function wyckoffEvents(candles, atr, opts = {}) {
  const P = { ...PATTERN_DEFAULTS, ...opts };
  const out = [];
  for (let i = P.springLookback; i < candles.length; i++) {
    const w = candles.slice(i - P.springLookback, i);
    const hi = Math.max(...w.map((c) => c.high)), lo = Math.min(...w.map((c) => c.low));
    const c = candles[i], a = atr[i - 1];
    if (a == null) continue;
    if (c.low < lo && c.close > lo) out.push({ index: i, confirmedIndex: i, kind: 'spring', dir: 1, level: lo });
    if (c.high > hi && c.close < hi) out.push({ index: i, confirmedIndex: i, kind: 'upthrust', dir: -1, level: hi });
    const body = Math.abs(c.close - c.open);
    if (c.close > hi && body >= P.srEffortMult * a) out.push({ index: i, confirmedIndex: i, kind: 'SOS', dir: 1, level: hi });
    if (c.close < lo && body >= P.srEffortMult * a) out.push({ index: i, confirmedIndex: i, kind: 'SOW', dir: -1, level: lo });
    // effort (range proxy) high, result (net progress) small
    const rng = c.high - c.low;
    if (rng >= 1.5 * a && body <= 0.2 * rng) out.push({ index: i, confirmedIndex: i, kind: 'effort-no-result', dir: 0, proxy: 'range' });
  }
  return out;
}

export function analyzePatterns(input, opts = {}) {
  const { candles, dropped } = sanitize(input);
  const atr = atrSeries(candles, opts.atrPeriod || DEFAULTS.atrPeriod);
  return {
    candles, dropped, atr,
    candle: candlePatterns(candles, atr),
    volatility: volatilityRegimes(candles, atr, opts),
    chart: chartPatterns(candles, atr, opts),
    wyckoff: wyckoffEvents(candles, atr, opts),
  };
}
