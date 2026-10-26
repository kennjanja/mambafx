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
  broadenRatio: 1.25, // upper-lower gap at formation must be at least this multiple of the gap at the first pivot
  poleAtr: 3.5, poleMaxBars: 15, poleMinCloseShare: 0.6, // flag/pennant pole: impulse size (ATR), duration, share of bars closing with it
  flagMaxBars: 25, flagMaxRetrace: 0.5, flagParallelAtr: 0.03, pennantConverge: 0.7,
  abcdRetrace: [0.382, 0.886], abcdTol: 0.15, abcdTime: [0.5, 2], abcdMinAtr: 2, // AB=CD: BC retracement band, |CD/AB-1| tolerance, CD/AB bar ratio band, min AB size
  springLookback: 20, srEffortMult: 1.5,
});

// Pattern lifecycle. 'potential' = incomplete geometry still inside its window; 'developing' (older detectors use the
// synonym 'forming') = geometry complete, awaiting a close beyond the trigger line; then confirmed -> failed, or
// invalidated / expired without ever confirming.
export const PATTERN_STATES = Object.freeze(['potential', 'developing', 'forming', 'confirmed', 'failed', 'invalidated', 'expired']);
export const isOpenState = (s) => s === 'potential' || s === 'developing' || s === 'forming';

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
  const open = pat.openState || 'forming';
  pat.history = [...(pat.potentialIndex != null ? [{ status: 'potential', index: pat.potentialIndex }] : []), { status: open, index: pat.formedIndex }];
  pat.status = open;
  const maxAge = pat.maxAge ?? P.patternMaxAge;
  for (let i = startIdx; i < candles.length; i++) {
    const c = candles[i];
    const t = trigger(i), v = invalid(i);
    if (pat.status === open) {
      if (pat.dir === 1 ? c.close > t : c.close < t) { pat.status = 'confirmed'; pat.breakIndex = i; pat.history.push({ status: 'confirmed', index: i }); }
      else if (pat.dir === 1 ? c.close < v : c.close > v) { pat.status = 'invalidated'; pat.history.push({ status: 'invalidated', index: i }); break; }
      else if (i - pat.formedIndex > maxAge) { pat.status = 'expired'; pat.history.push({ status: 'expired', index: i }); break; }
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
        else if (gapEnd >= P.broadenRatio * gapStart) {
          // diverging lines: broadening formation (both lines moving away) or right-angled (one line flat)
          if (sH > 0 && sL < 0 && !flat(sH) && !flat(sL)) kind = 'broadening';
          else if ((flat(sH) && sL < 0 && !flat(sL)) || (flat(sL) && sH > 0 && !flat(sH))) kind = 'right-angled-broadening';
        }
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
  flagPatterns(candles, atr, confirmed, P, push, out);
  abcdPatterns(candles, atr, confirmed, P, push, out);
  return out;
}

const slopeOf = (p, q) => (q.price - p.price) / (q.index - p.index);

// Flags and pennants: an impulse (pole) of at least poleAtr x ATR within poleMaxBars, then a counter-trend or sideways
// consolidation bounded by two lines through the first confirmed pivots after the pole top/bottom. Flag = roughly
// parallel lines drifting against (or flat to) the pole; pennant = converging lines. Retracement beyond
// flagMaxRetrace of the pole, or a close beyond the pole extreme before formation, rejects the geometry.
// Direction is the pole direction (continuation hypothesis); it is a hypothesis, not a forecast.
function flagPatterns(candles, atr, confirmed, P, push, out) {
  const n = candles.length;
  for (let bi = 0; bi < confirmed.length; bi++) {
    const B = confirmed[bi], a0 = atr[B.confirmedIndex];
    if (a0 == null) continue;
    const dir = B.type === 'high' ? 1 : -1;
    let A = null;
    for (let k = bi - 1; k >= 0; k--) {
      const q = confirmed[k];
      if (B.index - q.index > P.poleMaxBars) break;
      if (q.type !== B.type && q.index < B.index && (!A || dir * (q.price - A.price) < 0)) A = q;
    }
    if (!A) continue;
    const pole = dir * (B.price - A.price);
    if (pole < P.poleAtr * a0) continue;
    let withPole = 0;
    for (let i = A.index + 1; i <= B.index; i++) if (dir * (candles[i].close - candles[i].open) > 0) withPole++;
    if (withPole / (B.index - A.index) < P.poleMinCloseShare) continue;
    const tol = P.patternTolAtr * a0, level = B.price - dir * P.flagMaxRetrace * pole;
    const rest = confirmed.slice(bi + 1).filter((q) => q.index > B.index && q.index <= B.index + P.flagMaxBars);
    const S = rest.filter((q) => q.type === B.type), C = rest.filter((q) => q.type !== B.type);
    let formed = false;
    if (S.length >= 1 && C.length >= 2) {
      const s0 = S[0], c0 = C[0], c1 = C[1];
      const f = Math.max(s0.confirmedIndex, c0.confirmedIndex, c1.confirmedIndex);
      const af = f < n ? atr[f] : null;
      let ok = af != null && dir * (s0.price - B.price) <= tol;
      const cExt = dir === 1 ? Math.min(c0.price, c1.price) : Math.max(c0.price, c1.price);
      ok = ok && dir * (B.price - cExt) / pole <= P.flagMaxRetrace;
      for (let i = B.index + 1; ok && i <= f; i++) if (dir * (candles[i].close - B.price) > tol) ok = false;
      if (ok) {
        const hi = dir === 1 ? [B, s0] : [c0, c1], lo = dir === 1 ? [c0, c1] : [B, s0];
        const sU = slopeOf(hi[0], hi[1]) / af, sL = slopeOf(lo[0], lo[1]) / af, flat = P.wedgeSlopeAtr;
        const x0 = Math.max(hi[0].index, lo[0].index);
        const upper = (i) => lineAt(hi[0], hi[1], i), lower = (i) => lineAt(lo[0], lo[1], i);
        const g0 = upper(x0) - lower(x0), g1 = upper(f) - lower(f);
        let kind = null;
        if (g0 > 0 && g1 > 0) {
          if (g1 < P.pennantConverge * g0 && sU <= flat && sL >= -flat) kind = 'pennant';
          else if (g1 >= P.pennantConverge * g0 && Math.abs(sU - sL) <= P.flagParallelAtr && dir * (sU + sL) / 2 <= flat) kind = 'flag';
        }
        if (kind) {
          formed = true;
          const pts = [A, B, s0, c0, c1].sort((x, y) => x.index - y.index || x.confirmedIndex - y.confirmedIndex);
          push({ kind, dir, pivots: pts, formedIndex: f, index: pts[pts.length - 1].index, upper: hi, lower: lo, pole: { from: A, to: B, atr: pole / a0 }, openState: 'developing', potentialIndex: B.confirmedIndex, maxAge: P.flagMaxBars * 2 },
            f + 1, dir === 1 ? upper : lower, () => level);
        }
      }
    }
    // potential: pole is valid and still inside its consolidation window, nothing resolved yet
    if (!formed && n - 1 >= B.confirmedIndex && n - 1 <= B.index + P.flagMaxBars) {
      let alive = true;
      for (let i = B.index + 1; alive && i < n; i++) {
        const cl = candles[i].close;
        if (dir * (cl - B.price) > tol || dir * (level - cl) > 0) alive = false;
      }
      if (alive && !(S.length >= 1 && C.length >= 2)) {
        const key = 'flag-pole' + A.index + '-' + B.index;
        out.push({ kind: 'flag-pole', id: key, dir, pivots: [A, B], formedIndex: B.confirmedIndex, confirmedIndex: B.confirmedIndex, index: B.index, status: 'potential', pole: { from: A, to: B, atr: pole / a0 }, invalidationLevel: level, history: [{ status: 'potential', index: B.confirmedIndex }] });
      }
    }
  }
}

// AB=CD: four alternating confirmed pivots where CD is about as long as AB (price and time), with BC retracing
// abcdRetrace of AB. The pivot D is only confirmed pivotWindow bars late, so the move from D has already begun when the
// pattern is stamped. 'potential' = A, B, C found and the projected D has not yet printed.
function abcdPatterns(candles, atr, confirmed, P, push, out) {
  const n = candles.length, [rLo, rHi] = P.abcdRetrace, [tLo, tHi] = P.abcdTime;
  const legs = (A, B, C) => {
    if (!(A.index < B.index && B.index < C.index) || A.type === B.type || B.type === C.type) return null;
    const dir = C.type === 'high' ? 1 : -1; // bullish AB=CD ends in a low (D), so C is a high
    const AB = Math.abs(A.price - B.price), BC = Math.abs(C.price - B.price);
    const oriented = dir === 1 ? A.price > B.price && C.price > B.price && C.price < A.price : A.price < B.price && C.price < B.price && C.price > A.price;
    if (!oriented || AB <= 0) return null;
    const r = BC / AB;
    return r >= rLo && r <= rHi ? { dir, AB } : null;
  };
  for (let i = 3; i < confirmed.length; i++) {
    const [A, B, C, D] = confirmed.slice(i - 3, i + 1);
    const L = legs(A, B, C), f = D.confirmedIndex, a = atr[f];
    if (!L || a == null || D.type === C.type || D.index <= C.index || L.AB < P.abcdMinAtr * a) continue;
    const CD = Math.abs(C.price - D.price), ratio = CD / L.AB, tr = (D.index - C.index) / (B.index - A.index);
    const beyond = L.dir === 1 ? D.price < C.price : D.price > C.price;
    if (!beyond || Math.abs(ratio - 1) > P.abcdTol || tr < tLo || tr > tHi) continue;
    push({ kind: 'abcd', dir: L.dir, pivots: [A, B, C, D], formedIndex: f, index: D.index, ratioCD: ratio, retraceBC: Math.abs(C.price - B.price) / L.AB, openState: 'developing', potentialIndex: C.confirmedIndex, maxAge: 50 },
      f + 1, () => D.price + 0.382 * (C.price - D.price), () => D.price - L.dir * P.patternTolAtr * a);
  }
  if (confirmed.length >= 3) {
    const [A, B, C] = confirmed.slice(-3), L = legs(A, B, C), a = atr[n - 1];
    if (L && a != null && L.AB >= P.abcdMinAtr * a && n - 1 <= C.index + tHi * (B.index - A.index) && n - 1 >= C.confirmedIndex) {
      out.push({ kind: 'abcd', id: 'abcd-potential' + A.index + '-' + C.index, dir: L.dir, pivots: [A, B, C], formedIndex: C.confirmedIndex, confirmedIndex: C.confirmedIndex, index: C.index, status: 'potential', projectedD: C.price - L.dir * L.AB, history: [{ status: 'potential', index: C.confirmedIndex }] });
    }
  }
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
