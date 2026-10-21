// LDPE: Last-Digit Prediction Engine -- core (pure, no DOM, no network).
// Forecasts the last digit of the tick at a future horizon, scores every
// forecast exactly once against its own target tick, and adapts ensemble
// weights only from those scored outcomes (prequential, no look-ahead).

export const LN10 = Math.log(10);

export const DEFAULTS = Object.freeze({
  horizon: 5,              // ticks ahead of the last observed tick
  minTicks: 100,           // warm-up requirement (single source of truth)
  minProbability: 0.12,    // TRADE trigger on the selected source
  triggerSource: "ensemble", // "ensemble" | "shrunk"
  alpha: 1,                // Dirichlet prior
  shortWindow: 50,
  longWindow: 1000,
  halfLife: 300,           // decayed-count half-life in ticks
  eta: 1.0,                // weight learning rate (0.1..5)
  lossWindow: 500,         // rho = 1 - 1/lossWindow, also the shrinkage window
  floor: 0.01,
  cap: 0.6,
  shrinkMargin: 0.02,      // nats of uniform-relative gain for lambda = 1
  bufferMax: 10000,
  gapFactor: 3,            // gap flagged above gapFactor * median interval
  maxHorizon: 10,
  modules: { dirichlet: true, freqShort: true, freqLong: true, decayed: true, trans1: true, trans2: true, gap: true, streak: true },
  gapBuckets: 16,          // ticks-since-last-seen, capped
  runBuckets: 6,           // same-digit run length, capped
  gapPrior: 20,            // pseudo-observations pulling gap cells toward 0.1
  calMin: 300,             // scored forecasts required before calibration is used
  calRefit: 50,            // refit cadence (scored forecasts)
  calMax: 2000,
  breakWindow: 200,        // structural-break test: recent window vs the window before it
  breakRef: 800,
  breakP: 1e-4,            // per-test significance (many looks => conservative)
  breakClear: 1e-3,
  breakEvery: 10,
  breakCooldown: 100,      // ticks of trading ineligibility after a break is flagged
  miMinSamples: 500,       // mutual-information safeguard (5 observations per contingency cell)
});

// ---------- statistics ----------
// Regularized upper incomplete gamma Q(a,x) (Numerical Recipes), used for chi-square p-values.
export function chi2sf(x, df) {
  if (!(df > 0) || !(x >= 0)) return 1;
  const a = df / 2, xx = x / 2;
  if (xx === 0) return 1;
  const gln = lgamma(a);
  if (xx < a + 1) {
    let ap = a, sum = 1 / a, del = sum;
    for (let n = 0; n < 500; n++) { ap++; del *= xx / ap; sum += del; if (Math.abs(del) < Math.abs(sum) * 1e-14) break; }
    return Math.min(1, Math.max(0, 1 - sum * Math.exp(-xx + a * Math.log(xx) - gln)));
  }
  let b = xx + 1 - a, c = 1 / 1e-300, d = 1 / b, h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a); b += 2;
    d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d; const del = d * c; h *= del;
    if (Math.abs(del - 1) < 1e-14) break;
  }
  return Math.min(1, Math.max(0, Math.exp(-xx + a * Math.log(xx) - gln) * h));
}
function lgamma(z) {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = z, x = z, tmp = x + 5.5; tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015; for (const cj of c) ser += cj / ++y;
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}

// Two-sample chi-square homogeneity test of digit counts a vs b.
export function homogeneityTest(a, b) {
  const na = a.reduce((s, x) => s + x, 0), nb = b.reduce((s, x) => s + x, 0);
  if (!na || !nb) return { chi2: 0, df: 0, p: 1 };
  let chi2 = 0, cells = 0;
  for (let d = 0; d < a.length; d++) {
    const t = a[d] + b[d]; if (!t) continue;
    cells++;
    const ea = t * na / (na + nb), eb = t * nb / (na + nb);
    chi2 += (a[d] - ea) ** 2 / ea + (b[d] - eb) ** 2 / eb;
  }
  const df = cells - 1;
  return { chi2, df, p: df > 0 ? chi2sf(chi2, df) : 1 };
}

// Mutual information of a contingency table (nats->bits) with Miller-Madow bias correction
// and a G-test p-value. Refuses to report below minSamples.
export function mutualInformation(table, minSamples = 500) {
  const R = table.length, C = table[0].length;
  const rows = new Array(R).fill(0), cols = new Array(C).fill(0);
  let N = 0;
  for (let i = 0; i < R; i++) for (let j = 0; j < C; j++) { rows[i] += table[i][j]; cols[j] += table[i][j]; N += table[i][j]; }
  if (N < minSamples) return { status: "insufficient", n: N, needed: minSamples };
  let mi = 0;
  for (let i = 0; i < R; i++) for (let j = 0; j < C; j++) {
    const n = table[i][j]; if (n > 0) mi += (n / N) * Math.log((n * N) / (rows[i] * cols[j]));
  }
  const r = rows.filter(x => x > 0).length, c = cols.filter(x => x > 0).length, df = (r - 1) * (c - 1);
  const p = df > 0 ? chi2sf(2 * N * mi, df) : 1;
  const bits = (x) => x / Math.LN2;
  const corrected = Math.max(0, mi - df / (2 * N));
  return {
    status: "ok", n: N, miBits: bits(mi), miBitsCorrected: bits(corrected), df, pValue: p,
    interpretation: p < 0.01
      ? "dependence between origin digit and digit at the horizon is statistically detectable (single test, uncorrected across horizons); this is not evidence of tradable edge"
      : "no statistically detectable dependence; observed MI is consistent with sampling noise",
  };
}

// Isotonic (PAV) calibration of probabilities from (p, outcome) pairs. Pure: callers pass only
// forecasts whose outcomes were already known.
export function fitIsotonic(pairs) {
  const s = [...pairs].sort((a, b) => a[0] - b[0]);
  const blocks = [];
  for (const [p, y] of s) {
    blocks.push({ w: 1, sy: y, sp: p });
    while (blocks.length > 1) {
      const b = blocks[blocks.length - 1], a = blocks[blocks.length - 2];
      if (a.sy / a.w <= b.sy / b.w) break;
      a.w += b.w; a.sy += b.sy; a.sp += b.sp; blocks.pop();
    }
  }
  const xs = blocks.map(b => b.sp / b.w), ys = blocks.map(b => b.sy / b.w);
  return (p) => {
    if (!xs.length) return p;
    if (p <= xs[0]) return ys[0];
    if (p >= xs[xs.length - 1]) return ys[ys.length - 1];
    let lo = 0, hi = xs.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] <= p) lo = m; else hi = m; }
    const t = (p - xs[lo]) / (xs[hi] - xs[lo] || 1);
    return ys[lo] + t * (ys[hi] - ys[lo]);
  };
}

// ---------- exact digit extraction ----------
// quote must be the raw quoted string; decimals is the symbol's true precision.
export function extractDigit(quote, decimals) {
  if (quote === null || quote === undefined) return null;
  let s = String(quote).trim();
  if (!/^[+-]?\d+(\.\d+)?$/.test(s)) return null; // no sci-notation, no junk
  s = s.replace(/^[+-]/, "");
  const frac = s.includes(".") ? s.split(".")[1] : "";
  if (Number.isInteger(decimals) && decimals >= 0) {
    if (frac.length !== decimals) return null;     // precision mismatch: never invent a digit
    return Number(decimals === 0 ? s[s.length - 1] : frac[decimals - 1]);
  }
  return Number(s[s.length - 1]);
}

// ---------- math helpers ----------
export function normalize(v) {
  let s = 0;
  for (const x of v) { if (!Number.isFinite(x) || x < 0) return null; s += x; }
  if (!(s > 0)) return null;
  return v.map(x => x / s);
}
export function validVector(v, tol = 1e-9) {
  if (!Array.isArray(v) || v.length !== 10) return false;
  let s = 0;
  for (const x of v) { if (!Number.isFinite(x) || x < 0) return false; s += x; }
  return Math.abs(s - 1) <= tol;
}
export const logLoss = (v, d) => -Math.log(Math.max(v[d], 1e-12));
export const brier = (v, d) => v.reduce((a, p, i) => a + (p - (i === d ? 1 : 0)) ** 2, 0);
export function entropyBits(v) {
  let h = 0; for (const p of v) if (p > 0) h -= p * Math.log2(p); return h;
}
export function jsDivergence(vs) {
  const n = vs.length; if (n < 2) return 0;
  const m = new Array(10).fill(0);
  vs.forEach(v => v.forEach((p, i) => { m[i] += p / n; }));
  const kl = (p, q) => p.reduce((a, x, i) => (x > 0 ? a + x * Math.log(x / q[i]) : a), 0);
  return vs.reduce((a, v) => a + kl(v, m), 0) / n;
}

// Euclidean projection onto {floor <= w <= cap, sum w = 1} (water-filling).
export function projectWeights(w, floor, cap) {
  const n = w.length;
  if (n * floor > 1 + 1e-12 || n * cap < 1 - 1e-12) {
    throw new Error(`LDPE config error: infeasible weight bounds (n=${n}, floor=${floor}, cap=${cap})`);
  }
  const sum = (tau) => w.reduce((a, x) => a + Math.min(cap, Math.max(floor, x - tau)), 0);
  let lo = -2, hi = 2;
  for (let i = 0; i < 200; i++) { const mid = (lo + hi) / 2; if (sum(mid) > 1) lo = mid; else hi = mid; }
  const tau = (lo + hi) / 2;
  const out = w.map(x => Math.min(cap, Math.max(floor, x - tau)));
  const s = out.reduce((a, b) => a + b, 0);
  return out.map(x => x / s);
}

function median(a) {
  if (!a.length) return 0;
  const b = [...a].sort((x, y) => x - y); const m = b.length >> 1;
  return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
}

// ---------- per-symbol state ----------
function newSymbolState(cfg) {
  const H = cfg.maxHorizon;
  const mk2 = () => Array.from({ length: 10 }, () => new Array(10).fill(0));
  return {
    ticks: [],                       // bounded: {seq, epoch, quote, decimals, digit, recv}
    seq: 0,                          // accepted-tick sequence position
    lastEpoch: null,
    intervals: [],
    counts: new Array(10).fill(0),   // cumulative digit counts (all accepted ticks)
    decayed: new Array(10).fill(0),  // exponentially decayed counts
    trans1: Array.from({ length: H + 1 }, mk2),     // [h][from][to], lag-h conditional counts
    trans2: Array.from({ length: H + 1 }, () => new Map()), // [h]: "a,b" -> counts[10]
    stateVersion: 0,
    pending: [],                     // frozen forecasts awaiting their own target tick
    quality: { duplicates: 0, outOfOrder: 0, precisionMismatch: 0, gaps: 0, lastGapSeconds: 0 },
    scores: {},                      // per horizon
    forecasts: [],                   // bounded history of resolved forecasts
    forecastSeq: 0,
    modelTicks: 0,                   // ticks folded into the models (warm-up basis)
    lastSeen: new Array(10).fill(-1e9),
    runDigit: -1, runLen: 0,
    gapTab: Array.from({ length: H + 1 }, () => Array.from({ length: 10 }, () => ({ n: new Array(cfg.gapBuckets).fill(0), hit: new Array(cfg.gapBuckets).fill(0) }))),
    streakTab: Array.from({ length: H + 1 }, () => new Map()),
    discSeqs: [],                    // seq positions that follow a feed hole (gap/discontinuity)
    hold: null,                      // ticks queued while waiting for a history backfill
    brk: { active: false, atSeq: null, count: 0, until: 0, lastP: null, lastChecked: 0 },
  };
}

export class Ldpe {
  constructor(config = {}) {
    this.cfg = { ...DEFAULTS, ...config, modules: { ...DEFAULTS.modules, ...(config.modules || {}) } };
    this.symbols = new Map();
    this.historyMax = 2000;
  }

  state(sym) {
    if (!this.symbols.has(sym)) this.symbols.set(sym, newSymbolState(this.cfg));
    return this.symbols.get(sym);
  }

  moduleNames() {
    return ["uniform", ...Object.entries(this.cfg.modules).filter(([, on]) => on).map(([k]) => k)];
  }

  warmup(sym) {
    const st = this.state(sym);
    const remaining = Math.max(0, this.cfg.minTicks - st.modelTicks);
    return { remaining, isWarmingUp: remaining > 0, complete: remaining === 0 };
  }

  // Call after a reconnect/resubscribe: pending forecasts become unscorable
  // because the tick sequence may have a hole.
  markDiscontinuity(sym) {
    const st = this.state(sym);
    for (const f of st.pending) { f.status = "unscorable"; f.reason = "feed discontinuity"; this._resolve(st, f); }
    st.pending = [];
    st.discSeqs.push(st.seq + 1);
    if (st.discSeqs.length > 200) st.discSeqs.shift();
  }

  // True when no feed hole lies between the two sequence positions.
  contiguous(sym, fromSeq, toSeq) {
    return !this.state(sym).discSeqs.some(s => s > fromSeq && s <= toSeq);
  }

  seqOfEpoch(sym, epoch) {
    const t = this.state(sym).ticks;
    for (let i = t.length - 1; i >= 0; i--) { if (t[i].epoch === epoch) return t[i].seq; if (t[i].epoch < epoch) break; }
    return null;
  }

  // After a restart/reconnect: queue live ticks until history arrives, so pending forecasts
  // can be scored on the true intermediate ticks instead of being dropped.
  beginHold(sym) { const st = this.state(sym); if (!st.hold) st.hold = []; }
  isHolding(sym) { return !!this.state(sym).hold; }

  // history = [{epoch, quote, decimals}] ascending. Overlap with the last known tick proves
  // there is no hole; without overlap the hole is recorded and pending forecasts are unscorable.
  backfill(sym, history) {
    const st = this.state(sym);
    const held = st.hold || []; st.hold = null;
    const all = [...history, ...held].filter(t => Number.isFinite(Number(t.epoch))).sort((a, b) => Number(a.epoch) - Number(b.epoch));
    const seen = new Set(); const uniq = [];
    for (const t of all) { const e = Number(t.epoch); if (!seen.has(e)) { seen.add(e); uniq.push(t); } }
    const prev = st.lastEpoch;
    const overlap = prev === null || uniq.some(t => Number(t.epoch) === prev);
    if (!overlap) this.markDiscontinuity(sym);
    let ingested = 0;
    st.replay = true;
    try {
      for (const t of uniq) {
        if (prev !== null && Number(t.epoch) <= prev) continue;
        if (this.ingest(sym, t).accepted) ingested++;
      }
    } finally { st.replay = false; }
    return { ingested, overlap };
  }

  // Backfill never arrived: record the hole, then process what was held.
  releaseHold(sym) {
    const st = this.state(sym);
    if (!st.hold) return { ingested: 0, overlap: false };
    return this.backfill(sym, []);
  }

  // Ingest one tick. tick = {epoch, quote (raw string), decimals, recv?}
  ingest(sym, tick) {
    const st = this.state(sym), cfg = this.cfg;
    if (st.hold) { st.hold.push(tick); return { accepted: false, held: true, flags: {} }; }
    const epoch = Number(tick.epoch);
    const digit = extractDigit(tick.quote, tick.decimals);
    const flags = { duplicate: false, outOfOrder: false, precisionMismatch: false, gapSeconds: 0 };
    if (!Number.isFinite(epoch)) return { accepted: false, flags: { ...flags, invalid: true } };
    if (digit === null) {
      st.quality.precisionMismatch++; flags.precisionMismatch = true;
      return { accepted: false, flags };
    }
    if (st.lastEpoch !== null) {
      if (epoch === st.lastEpoch) { st.quality.duplicates++; flags.duplicate = true; return { accepted: false, flags }; }
      if (epoch < st.lastEpoch) { st.quality.outOfOrder++; flags.outOfOrder = true; return { accepted: false, flags }; }
      const gap = epoch - st.lastEpoch;
      st.intervals.push(gap); if (st.intervals.length > 200) st.intervals.shift();
      const med = median(st.intervals);
      if (med > 0 && gap > cfg.gapFactor * med && st.intervals.length >= 20) {
        flags.gapSeconds = gap; st.quality.gaps++; st.quality.lastGapSeconds = gap;
        st.discSeqs.push(st.seq + 1);
        if (st.discSeqs.length > 200) st.discSeqs.shift();
      }
    }
    st.lastEpoch = epoch;
    st.seq++;
    const rec = { seq: st.seq, epoch, quote: String(tick.quote), decimals: tick.decimals, digit, recv: tick.recv ?? null };
    st.ticks.push(rec);
    if (st.ticks.length > cfg.bufferMax) st.ticks.shift();

    this._scoreDue(st, rec);       // 1) score forecasts whose own target is this tick
    this._updateCounts(st, rec);   // 2) only then fold the outcome into the models
    this._breakCheck(st);
    st.stateVersion++;
    const forecast = this._forecast(sym, st, cfg.horizon); // 3) next forecast, prior info only
    return { accepted: true, digit, flags, forecast };
  }

  _updateCounts(st, rec) {
    const d = rec.digit, cfg = this.cfg, win = st.ticks, n = win.length;
    st.modelTicks++;
    st.counts[d]++;
    // gap / run state AFTER this tick (the tick's own digit has gap 0)
    st.lastSeen[d] = rec.seq;
    if (st.runDigit === d) st.runLen++; else { st.runDigit = d; st.runLen = 1; }
    rec.gaps = st.lastSeen.map(s => Math.min(cfg.gapBuckets - 1, rec.seq - s));
    rec.runB = Math.min(cfg.runBuckets, st.runLen) - 1;
    const decay = Math.pow(0.5, 1 / cfg.halfLife);
    for (let i = 0; i < 10; i++) st.decayed[i] *= decay;
    st.decayed[d] += 1;
    for (let h = 1; h <= cfg.maxHorizon; h++) {
      if (n - 1 - h < 0) break;
      const origin = win[n - 1 - h], from = origin.digit;
      st.trans1[h][from][d]++;
      if (origin.gaps) {
        for (let g = 0; g < 10; g++) { const c = st.gapTab[h][g], b = origin.gaps[g]; c.n[b]++; if (g === d) c.hit[b]++; }
        const key = from * cfg.runBuckets + origin.runB;
        let srow = st.streakTab[h].get(key);
        if (!srow) { srow = new Array(10).fill(0); st.streakTab[h].set(key, srow); }
        srow[d]++;
      }
      if (n - 2 - h >= 0) {
        const key = win[n - 2 - h].digit + "," + from;
        let row = st.trans2[h].get(key);
        if (!row) { row = new Array(10).fill(0); st.trans2[h].set(key, row); }
        row[d]++;
      }
    }
  }

  // Structural break: recent window vs the window immediately before it (chi-square homogeneity).
  _breakCheck(st) {
    const cfg = this.cfg, b = st.brk, n = st.ticks.length;
    if (st.seq - b.lastChecked < cfg.breakEvery || n < cfg.breakWindow + cfg.breakRef) return;
    b.lastChecked = st.seq;
    const cnt = (from, to) => { const c = new Array(10).fill(0); for (let i = from; i < to; i++) c[st.ticks[i].digit]++; return c; };
    const rec = cnt(n - cfg.breakWindow, n), ref = cnt(n - cfg.breakWindow - cfg.breakRef, n - cfg.breakWindow);
    const t = homogeneityTest(rec, ref);
    b.lastP = t.p;
    if (!b.active && t.p < cfg.breakP) {
      b.active = true; b.atSeq = st.seq; b.count++; b.until = st.seq + cfg.breakCooldown;
      // documented effect: forget half of the accumulated module evidence so weights re-adapt
      for (const hs of Object.values(st.scores)) for (const m of Object.keys(hs.S)) hs.S[m] *= 0.5;
    } else if (b.active && t.p >= cfg.breakClear && st.seq >= b.until) {
      b.active = false;
    } else if (b.active && t.p < cfg.breakP) {
      b.until = Math.max(b.until, st.seq + cfg.breakCooldown); // still drifting
    }
  }

  breakStatus(sym) {
    const b = this.state(sym).brk;
    return { active: b.active, atSeq: b.atSeq, count: b.count, lastP: b.lastP };
  }

  // Current gap/streak context and the empirical conditional frequencies it maps to (display only).
  conditionalStats(sym, h = this.cfg.horizon) {
    const st = this.state(sym), cfg = this.cfg, last = st.ticks[st.ticks.length - 1];
    if (!last || !st.gapTab[h]) return null;
    const gaps = [];
    for (let d = 0; d < 10; d++) {
      const c = st.gapTab[h][d], b = last.gaps ? last.gaps[d] : 0;
      gaps.push({ digit: d, sinceSeen: last.gaps ? last.gaps[d] : null, bucket: b, n: c.n[b], hitRate: c.n[b] ? c.hit[b] / c.n[b] : null });
    }
    const srow = st.streakTab[h].get(last.digit * cfg.runBuckets + last.runB) || new Array(10).fill(0);
    const sn = srow.reduce((a, b) => a + b, 0);
    return { horizon: h, lastDigit: last.digit, run: st.runLen, gaps, streak: { n: sn, freq: srow.map(c => (sn ? c / sn : null)) } };
  }

  mutualInfo(sym, h = this.cfg.horizon) {
    return { horizon: h, ...mutualInformation(this.state(sym).trans1[h], this.cfg.miMinSamples) };
  }

  calibrationStatus(sym, h = this.cfg.horizon) {
    const hs = this._hs(this.state(sym), h), cal = hs.cal;
    const e = cal.eval;
    return {
      ready: !!cal.map, scored: cal.data.length, needed: this.cfg.calMin,
      fittedOn: cal.fittedOn,
      outOfSample: e.n ? { n: e.n, logLossCalibrated: e.llCal / e.n, logLossRaw: e.llRaw / e.n } : null,
    };
  }

  _dirichlet(counts, alpha) {
    const n = counts.reduce((a, b) => a + b, 0);
    return counts.map(c => (c + alpha) / (n + 10 * alpha));
  }

  _moduleVectors(st, h) {
    const cfg = this.cfg, a = cfg.alpha, win = st.ticks, n = win.length;
    const out = { uniform: new Array(10).fill(0.1) };
    const freq = (arr) => { const c = new Array(10).fill(0); arr.forEach(t => c[t.digit]++); return c; };
    if (cfg.modules.dirichlet) out.dirichlet = this._dirichlet(st.counts, a);
    if (cfg.modules.freqShort && n >= 10) out.freqShort = this._dirichlet(freq(win.slice(-cfg.shortWindow)), a);
    if (cfg.modules.freqLong && n >= 10) {
      // unsmoothed so it is a genuinely different participant from the Dirichlet estimator
      out.freqLong = normalize(freq(win.slice(-cfg.longWindow)).map(x => x + 1e-6));
    }
    if (cfg.modules.decayed && n >= 10) out.decayed = this._dirichlet(st.decayed, a);
    if (cfg.modules.trans1 && n >= 1) out.trans1 = this._dirichlet(st.trans1[h][win[n - 1].digit], a);
    if (cfg.modules.trans2 && n >= 2) {
      const row = st.trans2[h].get(win[n - 2].digit + "," + win[n - 1].digit) || new Array(10).fill(0);
      out.trans2 = this._dirichlet(row, a);
    }
    if (cfg.modules.gap && n >= 10 && win[n - 1].gaps) {
      const last = win[n - 1];
      const raw = [];
      for (let d = 0; d < 10; d++) {
        const c = st.gapTab[h][d], b = last.gaps[d];
        raw.push((c.hit[b] + cfg.gapPrior * 0.1) / (c.n[b] + cfg.gapPrior));
      }
      out.gap = normalize(raw);
    }
    if (cfg.modules.streak && n >= 10 && win[n - 1].gaps) {
      const last = win[n - 1];
      out.streak = this._dirichlet(st.streakTab[h].get(last.digit * cfg.runBuckets + last.runB) || new Array(10).fill(0), a);
    }
    for (const k of Object.keys(out)) if (!validVector(out[k], 1e-9)) delete out[k]; // invalid output excluded
    return out;
  }

  _hs(st, h) {
    if (!st.scores[h]) {
      st.scores[h] = {
        S: {}, evaluated: {}, ens: { n: 0, ll: 0, br: 0, top1: 0, llUni: 0 }, losses: [], uniLosses: [],
        cal: { data: [], map: null, fittedOn: 0, sinceFit: 0, eval: { n: 0, llCal: 0, llRaw: 0 } },
      };
    }
    return st.scores[h];
  }

  // Calibration is fitted only from forecasts that have already been scored.
  _calibrate(hs, v) {
    const map = hs.cal.map; if (!map) return null;
    const c = normalize(v.map(p => Math.max(1e-6, map(p))));
    return c && validVector(c, 1e-9) ? c : null;
  }

  _maybeRefitCalibration(hs) {
    const cfg = this.cfg, cal = hs.cal;
    if (cal.data.length < cfg.calMin) return;
    if (cal.map && cal.sinceFit < cfg.calRefit) return;
    const pairs = [];
    for (const { v, d } of cal.data) for (let i = 0; i < 10; i++) pairs.push([v[i], i === d ? 1 : 0]);
    cal.map = fitIsotonic(pairs); cal.fittedOn = cal.data.length; cal.sinceFit = 0;
  }

  _weights(st, h, names) {
    const cfg = this.cfg, hs = this._hs(st, h);
    const logw = names.map(m => -cfg.eta * (hs.S[m] || 0));
    const mx = Math.max(...logw);
    const raw = logw.map(x => Math.exp(x - mx));
    const s = raw.reduce((a, b) => a + b, 0);
    const w = projectWeights(raw.map(x => x / s), cfg.floor, cfg.cap);
    const o = {}; names.forEach((m, i) => { o[m] = w[i]; });
    return o;
  }

  _forecast(sym, st, h) {
    const cfg = this.cfg;
    const mods = this._moduleVectors(st, h);
    const names = Object.keys(mods);
    const w = this._weights(st, h, names);
    const ens = new Array(10).fill(0);
    for (const m of names) for (let d = 0; d < 10; d++) ens[d] += w[m] * mods[m][d];
    const ensV = normalize(ens);
    if (!ensV || !validVector(ensV, 1e-9)) throw new Error("LDPE: ensemble produced an invalid distribution");
    const hs = this._hs(st, h);
    let lambda = 0; // shrinkage toward uniform from recent uniform-relative gain
    if (hs.losses.length >= 50) {
      const mL = hs.losses.reduce((a, b) => a + b, 0) / hs.losses.length;
      const mU = hs.uniLosses.reduce((a, b) => a + b, 0) / hs.uniLosses.length;
      lambda = Math.min(1, Math.max(0, (mU - mL) / cfg.shrinkMargin));
    }
    const finalV = ensV.map(p => lambda * p + (1 - lambda) * 0.1);
    const calV = this._calibrate(hs, ensV);
    const calStatus = calV ? `calibrated (fit on ${hs.cal.fittedOn} scored forecasts)` : `uncalibrated (${hs.cal.data.length}/${cfg.calMin} scored forecasts needed)`;
    const src = cfg.triggerSource === "shrunk" ? finalV : cfg.triggerSource === "calibrated" ? (calV || ensV) : ensV;
    const ranked = [...src.keys()].sort((a, b) => src[b] - src[a] || a - b); // ties -> lowest digit
    const top = ranked[0];
    const wu = this.warmup(sym);
    const dq = { ok: true, gapRate: st.quality.gaps / Math.max(1, st.seq) };
    if (st.seq > 50 && dq.gapRate > 0.2) dq.ok = false;
    let decision = "SKIP", reason = null;
    if (!wu.complete) reason = "warming up";
    else if (!dq.ok) reason = "data quality";
    else if (st.brk.active) reason = "structural break";
    else if (cfg.triggerSource === "calibrated" && !calV) reason = "calibration unavailable";
    else if (src[top] < cfg.minProbability) reason = "below minProbability";
    else decision = "TRADE";
    if (st.replay) { decision = "SKIP"; reason = "reconstructed from history (not a live forecast)"; }
    const f = {
      id: `${sym}:${h}:${++st.forecastSeq}`,
      symbol: sym, horizon: h,
      madeAtSeq: st.seq, targetSeq: st.seq + h,
      madeAtEpoch: st.lastEpoch, stateVersion: st.stateVersion,
      predictedDigit: top, probability: src[top],
      alternatives: ranked.slice(1, 4).map(d => ({ digit: d, p: src[d] })),
      vectors: { uniform: mods.uniform, ensemble: ensV, final: finalV, calibrated: calV, modules: mods },
      weights: w, lambda, triggerSource: cfg.triggerSource, minProbability: cfg.minProbability,
      decision, reason, warmup: wu, dataQuality: dq, effectiveSamples: st.modelTicks,
      structuralBreak: st.brk.active,
      calibrationStatus: calStatus, ensembleUncertainty: "unavailable",
      disagreement: jsDivergence(names.map(m => mods[m])),
      status: "pending", realized: null, hit: null, reconstructed: !!st.replay,
    };
    st.pending.push(f);
    return f;
  }

  _scoreDue(st, rec) {
    const cfg = this.cfg, rho = 1 - 1 / cfg.lossWindow;
    const still = [];
    for (const f of st.pending) {
      if (f.targetSeq !== rec.seq) { still.push(f); continue; }
      const d = rec.digit, hs = this._hs(st, f.horizon);
      for (const [m, v] of Object.entries(f.vectors.modules)) {
        hs.S[m] = rho * (hs.S[m] || 0) + (logLoss(v, d) - LN10);
        hs.evaluated[m] = (hs.evaluated[m] || 0) + 1;
      }
      const Le = logLoss(f.vectors.ensemble, d), e = hs.ens;
      e.n++; e.ll += Le; e.br += brier(f.vectors.ensemble, d);
      e.top1 += f.predictedDigit === d ? 1 : 0; e.llUni += LN10;
      hs.losses.push(Le); hs.uniLosses.push(LN10);
      if (hs.losses.length > cfg.lossWindow) { hs.losses.shift(); hs.uniLosses.shift(); }
      // calibration data and its out-of-sample check: the forecast's calibrated vector (if any) was
      // produced before this outcome existed; the outcome joins the fit set only now.
      if (f.vectors.calibrated) { hs.cal.eval.n++; hs.cal.eval.llCal += logLoss(f.vectors.calibrated, d); hs.cal.eval.llRaw += Le; }
      hs.cal.data.push({ v: f.vectors.ensemble, d }); hs.cal.sinceFit++;
      if (hs.cal.data.length > cfg.calMax) hs.cal.data.shift();
      this._maybeRefitCalibration(hs);
      f.status = "scored"; f.realized = d; f.hit = f.predictedDigit === d;
      f.targetEpoch = rec.epoch; f.targetQuote = rec.quote;
      f.llEnsemble = Le; f.llUniform = LN10;
      this._resolve(st, f);
    }
    st.pending = still;
  }

  _resolve(st, f) {
    st.forecasts.push({ ...f, vectors: { ensemble: f.vectors.ensemble, final: f.vectors.final, calibrated: f.vectors.calibrated, uniform: f.vectors.uniform } });
    if (st.forecasts.length > this.historyMax) st.forecasts.shift();
  }

  metrics(sym, h = this.cfg.horizon) {
    const e = this._hs(this.state(sym), h).ens;
    if (!e.n) return { n: 0 };
    const p = e.top1 / e.n, se = Math.sqrt(p * (1 - p) / e.n);
    return {
      n: e.n, top1: p, top1Ci95: [Math.max(0, p - 1.96 * se), Math.min(1, p + 1.96 * se)],
      logLoss: e.ll / e.n, logLossUniform: e.llUni / e.n, brier: e.br / e.n, brierUniform: 0.9,
    };
  }

  scoreboard(sym, h = this.cfg.horizon) {
    const st = this.state(sym), hs = this._hs(st, h);
    const names = Object.keys(this._moduleVectors(st, h));
    const w = this._weights(st, h, names);
    return names.map(m => ({ module: m, weight: w[m], evaluated: hs.evaluated[m] || 0, relScore: hs.S[m] || 0 }));
  }

  // Deterministic replay of recorded ticks through the same pipeline.
  static replay(config, sym, ticks) {
    const e = new Ldpe(config), forecasts = [];
    for (const t of ticks) { const r = e.ingest(sym, t); if (r.forecast) forecasts.push(r.forecast); }
    return { engine: e, forecasts };
  }
}
