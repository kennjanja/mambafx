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
  modules: { dirichlet: true, freqShort: true, freqLong: true, decayed: true, trans1: true, trans2: true },
});

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
    const remaining = Math.max(0, this.cfg.minTicks - st.seq);
    return { remaining, isWarmingUp: remaining > 0, complete: remaining === 0 };
  }

  // Call after a reconnect/resubscribe: pending forecasts become unscorable
  // because the tick sequence may have a hole.
  markDiscontinuity(sym) {
    const st = this.state(sym);
    for (const f of st.pending) { f.status = "unscorable"; f.reason = "feed discontinuity"; this._resolve(st, f); }
    st.pending = [];
    st.lastEpoch = null;
  }

  // Ingest one tick. tick = {epoch, quote (raw string), decimals, recv?}
  ingest(sym, tick) {
    const st = this.state(sym), cfg = this.cfg;
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
      }
    }
    st.lastEpoch = epoch;
    st.seq++;
    const rec = { seq: st.seq, epoch, quote: String(tick.quote), decimals: tick.decimals, digit, recv: tick.recv ?? null };
    st.ticks.push(rec);
    if (st.ticks.length > cfg.bufferMax) st.ticks.shift();

    this._scoreDue(st, rec);       // 1) score forecasts whose own target is this tick
    this._updateCounts(st, rec);   // 2) only then fold the outcome into the models
    st.stateVersion++;
    const forecast = this._forecast(sym, st, cfg.horizon); // 3) next forecast, prior info only
    return { accepted: true, digit, flags, forecast };
  }

  _updateCounts(st, rec) {
    const d = rec.digit, cfg = this.cfg, win = st.ticks, n = win.length;
    st.counts[d]++;
    const decay = Math.pow(0.5, 1 / cfg.halfLife);
    for (let i = 0; i < 10; i++) st.decayed[i] *= decay;
    st.decayed[d] += 1;
    for (let h = 1; h <= cfg.maxHorizon; h++) {
      if (n - 1 - h < 0) break;
      const from = win[n - 1 - h].digit;
      st.trans1[h][from][d]++;
      if (n - 2 - h >= 0) {
        const key = win[n - 2 - h].digit + "," + from;
        let row = st.trans2[h].get(key);
        if (!row) { row = new Array(10).fill(0); st.trans2[h].set(key, row); }
        row[d]++;
      }
    }
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
    for (const k of Object.keys(out)) if (!validVector(out[k], 1e-9)) delete out[k]; // invalid output excluded
    return out;
  }

  _hs(st, h) {
    if (!st.scores[h]) {
      st.scores[h] = { S: {}, evaluated: {}, ens: { n: 0, ll: 0, br: 0, top1: 0, llUni: 0 }, losses: [], uniLosses: [] };
    }
    return st.scores[h];
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
    const src = cfg.triggerSource === "shrunk" ? finalV : ensV;
    const ranked = [...src.keys()].sort((a, b) => src[b] - src[a] || a - b); // ties -> lowest digit
    const top = ranked[0];
    const wu = this.warmup(sym);
    const dq = { ok: true, gapRate: st.quality.gaps / Math.max(1, st.seq) };
    if (st.seq > 50 && dq.gapRate > 0.2) dq.ok = false;
    let decision = "SKIP", reason = null;
    if (!wu.complete) reason = "warming up";
    else if (!dq.ok) reason = "data quality";
    else if (src[top] < cfg.minProbability) reason = "below minProbability";
    else decision = "TRADE";
    const f = {
      id: `${sym}:${h}:${++st.forecastSeq}`,
      symbol: sym, horizon: h,
      madeAtSeq: st.seq, targetSeq: st.seq + h,
      madeAtEpoch: st.lastEpoch, stateVersion: st.stateVersion,
      predictedDigit: top, probability: src[top],
      alternatives: ranked.slice(1, 4).map(d => ({ digit: d, p: src[d] })),
      vectors: { uniform: mods.uniform, ensemble: ensV, final: finalV, modules: mods },
      weights: w, lambda, triggerSource: cfg.triggerSource, minProbability: cfg.minProbability,
      decision, reason, warmup: wu, dataQuality: dq, effectiveSamples: st.seq,
      calibrationStatus: "uncalibrated", ensembleUncertainty: "unavailable",
      disagreement: jsDivergence(names.map(m => mods[m])),
      status: "pending", realized: null, hit: null,
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
      f.status = "scored"; f.realized = d; f.hit = f.predictedDigit === d;
      f.targetEpoch = rec.epoch; f.targetQuote = rec.quote;
      f.llEnsemble = Le; f.llUniform = LN10;
      this._resolve(st, f);
    }
    st.pending = still;
  }

  _resolve(st, f) {
    st.forecasts.push({ ...f, vectors: { ensemble: f.vectors.ensemble, final: f.vectors.final, uniform: f.vectors.uniform } });
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
