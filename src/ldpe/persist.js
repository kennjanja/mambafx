// LDPE persistence: minimum state to resume correctly after a reload.
// Stored: recent ticks (symbol, seq, epoch, raw quote), frozen pending forecasts (written before
// their outcomes exist), a light ledger of resolved forecasts, and counters.
// Never stored: tokens, credentials, account secrets. Models are rebuilt by replaying the stored
// ticks through the same deterministic pipeline (prequentially valid; documented as reconstructed).
import { Ldpe } from "./engine.js";

export const SNAPSHOT_VERSION = 1;
const SECRET_KEYS = /token|secret|password|authorize|bearer|otp/i;

const slim = (f) => ({
  id: f.id, symbol: f.symbol, horizon: f.horizon, madeAtSeq: f.madeAtSeq, targetSeq: f.targetSeq,
  madeAtEpoch: f.madeAtEpoch, stateVersion: f.stateVersion, predictedDigit: f.predictedDigit,
  probability: f.probability, decision: f.decision, reason: f.reason, status: f.status,
  realized: f.realized, hit: f.hit, targetEpoch: f.targetEpoch ?? null, targetQuote: f.targetQuote ?? null,
  llEnsemble: f.llEnsemble ?? null, llUniform: f.llUniform ?? null, structuralBreak: !!f.structuralBreak,
});

export function snapshotEngine(engine, { maxTicks = 3000, maxLedger = 500, maxSymbols = 5 } = {}) {
  const symbols = {};
  const ranked = [...engine.symbols.entries()].filter(([, st]) => st.ticks.length).sort((a, b) => b[1].lastEpoch - a[1].lastEpoch).slice(0, maxSymbols);
  for (const [sym, st] of ranked) {
    const ticks = st.ticks.slice(-maxTicks);
    symbols[sym] = {
      decimals: ticks[ticks.length - 1].decimals,
      firstSeq: ticks[0].seq, lastSeq: st.seq, lastEpoch: st.lastEpoch,
      ticks: ticks.map(t => [t.epoch, t.quote]),
      forecastSeq: st.forecastSeq,
      pending: st.pending.map(f => ({
        ...slim(f), weights: f.weights, lambda: f.lambda, triggerSource: f.triggerSource, minProbability: f.minProbability,
        alternatives: f.alternatives, calibrationStatus: f.calibrationStatus,
        vectors: { uniform: f.vectors.uniform, ensemble: f.vectors.ensemble, final: f.vectors.final, calibrated: f.vectors.calibrated, modules: f.vectors.modules },
      })),
      ledger: st.forecasts.slice(-maxLedger).map(slim),
      discSeqs: st.discSeqs.slice(-50),
      breaks: { count: st.brk.count },
    };
  }
  return { v: SNAPSHOT_VERSION, savedAt: Date.now(), horizon: engine.cfg.horizon, symbols };
}

export function restoreEngine(cfg, snap) {
  const e = new Ldpe(cfg);
  const info = { restored: {}, rejected: null };
  if (!snap || snap.v !== SNAPSHOT_VERSION || typeof snap.symbols !== "object") { info.rejected = "no compatible snapshot"; return { engine: e, info }; }
  for (const [sym, s] of Object.entries(snap.symbols)) {
    if (!Array.isArray(s.ticks) || !s.ticks.length) continue;
    const st = e.state(sym);
    st.seq = s.firstSeq - 1;                          // keep absolute sequence identity
    let ok = 0;
    for (const [epoch, quote] of s.ticks) if (e.ingest(sym, { epoch, quote, decimals: s.decimals }).accepted) ok++;
    // Persisted pending forecasts are authoritative: they are what was shown/traded before the reload.
    const known = new Set(s.ledger.map(f => f.id));
    st.pending = (s.pending || []).filter(f => !known.has(f.id) && f.targetSeq > st.seq && f.madeAtSeq <= st.seq)
      .map(f => ({ ...f, status: "pending" }));
    st.forecasts = s.ledger.map(f => ({ ...f }));
    st.forecastSeq = Math.max(st.forecastSeq, s.forecastSeq || 0);
    st.discSeqs = (s.discSeqs || []).slice();
    st.brk.count = Math.max(st.brk.count, (s.breaks && s.breaks.count) || 0);
    info.restored[sym] = { ticks: ok, lastSeq: st.seq, pending: st.pending.length };
    // Pending forecasts can only be scored on true intermediate ticks: hold live ticks until
    // history is backfilled (the bridge supplies it, or releases the hold with a recorded hole).
    e.beginHold(sym);
  }
  return { engine: e, info };
}

export function assertNoSecrets(obj) {
  const bad = [];
  (function walk(o, path) {
    if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) {
      if (SECRET_KEYS.test(k)) bad.push(path + k);
      walk(v, path + k + ".");
    }
  })(obj, "");
  if (bad.length) throw new Error("refusing to persist secret-like fields: " + bad.join(", "));
}

export class StateStore {
  // storage: {getItem, setItem, removeItem} (localStorage-compatible)
  constructor(storage, key = "ldpe_state_v1") { this.s = storage; this.key = key; }
  save(snapshot) {
    assertNoSecrets(snapshot);
    try { this.s.setItem(this.key, JSON.stringify(snapshot)); return true; } catch (_) { return false; }
  }
  load() {
    try { const raw = this.s.getItem(this.key); return raw ? JSON.parse(raw) : null; } catch (_) { return null; }
  }
  clear() { try { this.s.removeItem(this.key); } catch (_) {} }
}
