// LDPE page bridge: connects the pure modules (engine, persist, exec) to the MambaFX Digits page.
// It owns no WebSocket. ALL LDPE orders go through exec.js's Executor; the page's digPlaceTrade
// refuses source "ldpe", so no second execution path exists.
import { Ldpe, DEFAULTS, entropyBits } from "./engine.js";
import { Executor } from "./exec.js";
import { StateStore, snapshotEngine, restoreEngine } from "./persist.js";

const LS_CFG = "ldpe_settings_v1", LS_EXEC = "ldpe_exec_v1";
const $ = (id) => document.getElementById(id);
const H = () => window.__ldpeHost || {};
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch (_) { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} };
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const CONTRACT = "DIGITMATCH";

const FIELDS = [
  ["minProbability", "Min probability (0-1)", 0.12, 0.01, 0.5, 0.005],
  ["k", "Contract duration k (ticks)", 5, 1, 10, 1],
  ["minTicks", "Warm-up ticks (minTicks)", 100, 10, 5000, 10],
  ["stake", "Stake per trade", 1, 0.35, 100000, 0.5],
  ["alpha", "Dirichlet alpha", 1, 0.01, 50, 0.1],
  ["shortWindow", "Short window", 50, 10, 1000, 10],
  ["longWindow", "Long window", 1000, 100, 10000, 100],
  ["halfLife", "Count half-life (ticks)", 300, 20, 10000, 10],
  ["eta", "Weight learning rate eta (0.1-5)", 1, 0.1, 5, 0.1],
  ["lossWindow", "Rolling loss window", 500, 50, 5000, 50],
  ["floor", "Weight floor", 0.01, 0, 0.2, 0.005],
];

const saved = load(LS_CFG, {});
// Only the current settings are kept; the earlier stake field is carried over, nothing else is.
const settings = {
  triggerSource: "ensemble", accountType: "demo", stopped: false,
  ...Object.fromEntries(FIELDS.map(f => [f[0], f[2]])),
  ...(saved.maxStake != null && saved.stake == null ? { stake: saved.maxStake } : {}),
};
for (const k of [...FIELDS.map(f => f[0]), "triggerSource", "accountType", "stopped"]) if (saved[k] !== undefined) settings[k] = saved[k];
if (settings.accountType !== "real") settings.accountType = "demo";

const effectiveHorizon = () => Math.min(10, Math.max(1, settings.k));
const engineCfg = () => ({
  ...DEFAULTS,
  horizon: effectiveHorizon(),
  minProbability: settings.minProbability, minTicks: settings.minTicks, triggerSource: settings.triggerSource,
  alpha: settings.alpha, shortWindow: settings.shortWindow, longWindow: settings.longWindow,
  halfLife: settings.halfLife, eta: settings.eta, lossWindow: settings.lossWindow, floor: settings.floor,
});

const store = new StateStore(localStorage);
let restoreInfo = { rejected: "not attempted" };
let engine;
{
  const snap = store.load();
  const cfg = engineCfg();
  if (snap && snap.horizon === cfg.horizon) { const r = restoreEngine(cfg, snap); engine = r.engine; restoreInfo = r.info; }
  else { engine = new Ldpe(cfg); restoreInfo = { rejected: snap ? "snapshot horizon differs from current configuration" : "no saved state" }; }
}

let latest = {};          // symbol -> last forecast
let ticksSinceSave = 0, lastSave = 0;
const lastAutoSeq = {};   // symbol -> engine seq of the last automatic order (user cooldown)
let execMsg = "";
const rows = new Map();   // order id -> page trade row

// ---------------------------------------------------------------- executor (the only order path)
const host = {
  send: (m) => { const ws = H().gridWs; if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error("trading socket not open"); ws.send(JSON.stringify(m)); },
  nextReqId: () => H().nextReqId(),
  await: (id, cb) => H().awaitReq(id, cb),
  account: () => {
    const h = H(), ws = h.gridWs;
    return { authed: !!h.gridAuthed, open: !!ws && ws.readyState === WebSocket.OPEN, loginId: h.gridLoginId, isVirtual: h.gridIsVirtual === true, currency: h.gridCurrency || "USD" };
  },
  currentSeq: (sym) => engine.state(sym).seq,
  now: () => Date.now(),
};
const executor = new Executor(host, { accountType: settings.accountType, stopped: settings.stopped });
executor.restore(load(LS_EXEC, null));
const persistExec = () => save(LS_EXEC, executor.serialize());

const STATUS_TEXT = { created: "pricing…", pricing: "pricing…", buying: "buying…", open: "open", unknown: "unknown — confirm on account" };
executor.on((order, ev) => {
  let row = rows.get(order.id);
  if (ev === "created" && !row) {
    row = {
      id: "pending-" + order.id, orderId: order.id, digit: order.digit, source: "ldpe", stake: order.stake, contractType: order.contractType,
      symbol: order.symbol, k: order.k, forecast: order.forecast, forecastId: order.forecastId,
      accountId: order.accountId, isVirtual: order.isVirtual, currency: order.currency, time: Math.floor(order.createdAt / 1000),
      entry: null, exit: null, exitDigit: null, payout: null, pnl: null, status: "pricing…",
    };
    rows.set(order.id, row);
    const t = H().digTrades; if (t) { t.unshift(row); if (t.length > 100) t.pop(); }
  }
  if (row) {
    if (order.contractId && row.id !== order.contractId) row.id = order.contractId;
    if (order.state === "open") { row.buyPrice = order.buyPrice; if (H().openContracts) H().openContracts[row.id] = row; }
    if (order.state === "rejected") row.status = "rejected: " + (order.reason || "");
    else if (order.state === "settled") row.status = order.result;
    else row.status = STATUS_TEXT[order.state] || order.state;
  }
  if (order.state === "rejected" && ev === "rejected") execMsg = `Order rejected on ${order.isVirtual ? "Demo" : "Real"} ${order.accountId}: ${order.reason}`;
  if (H().renderTrades) H().renderTrades();
  persistExec();
  api.render();
});

function syncHorizon() {
  const h = effectiveHorizon();
  if (engine.cfg.horizon !== h) engine.cfg.horizon = h;
}

function rebuild() {
  const old = engine; engine = new Ldpe(engineCfg());
  engine.symbols = old.symbols;
  syncHorizon();
}

function saveState(force) {
  const now = Date.now();
  if (!force && now - lastSave < 5000) return;
  lastSave = now; ticksSinceSave = 0;
  try { store.save(snapshotEngine(engine)); } catch (_) {}
}
const releaseTimers = {};

const api = {
  settings, FIELDS, executor,
  get engine() { return engine; },
  latestFor: (s) => latest[s],

  // Shared tick path, raw quote literal.
  ingest(symbol, rawQuote, decimals, epoch) {
    const r = engine.ingest(symbol, { epoch, quote: rawQuote, decimals, recv: Date.now() });
    if (r.accepted) {
      syncHorizon();
      if (r.forecast) { latest[symbol] = r.forecast; api.maybeTrade(symbol, r.forecast); }
      if (++ticksSinceSave >= 20) saveState(false);
    }
    api.render();
    return r;
  },

  // Called whenever the page (re)subscribes to a symbol's ticks: hold live ticks until history arrives.
  beginHold(symbol, ms = 6000) {
    engine.beginHold(symbol);
    clearTimeout(releaseTimers[symbol]);
    releaseTimers[symbol] = setTimeout(() => { if (engine.isHolding(symbol)) { engine.releaseHold(symbol); api.render(); } }, ms);
  },
  // History response: reconcile pending forecasts against the true intermediate ticks.
  backfill(symbol, prices, times, decimals) {
    clearTimeout(releaseTimers[symbol]);
    const hist = [];
    for (let i = 0; i < prices.length; i++) hist.push({ epoch: Number(times[i]), quote: Number(prices[i]).toFixed(decimals), decimals });
    const r = engine.backfill(symbol, hist);
    api.lastBackfill = { symbol, received: hist.length, ...r, at: Date.now() };
    saveState(true); api.render();
    return r;
  },
  discontinuity(symbol) { engine.markDiscontinuity(symbol); },

  // Automatic trading: only through the executor, only on a TRADE decision, only while Auto is armed
  // and the Stop switch is off. Cooldown and stop-after-N are the user's own settings (Auto panel).
  maybeTrade(symbol, f) {
    if (!H().digAutoArmed || executor.stopped || f.decision !== "TRADE" || f.reconstructed) return;
    const u = H().autoSettings ? H().autoSettings() : { cooldown: 0, max: 0, count: 0 };
    const seq = engine.state(symbol).seq;
    if (u.max && u.count >= u.max) return;
    if (u.cooldown && lastAutoSeq[symbol] != null && seq - lastAutoSeq[symbol] < u.cooldown) return;
    const r = executor.place({ symbol, digit: f.predictedDigit, k: settings.k, contractType: CONTRACT, stake: settings.stake, forecast: f });
    if (r.ok) { lastAutoSeq[symbol] = seq; if (H().noteAutoOrder) H().noteAutoOrder(); }
    execMsg = r.ok ? `Order sent on ${executor.accountType === "demo" ? "Demo" : "Real"}: Matches ${f.predictedDigit} (p=${(f.probability * 100).toFixed(1)}%, ${f.id})` : "Not executing: " + r.reason;
  },

  // Trading socket events forwarded by the page.
  onContractUpdate(c) { return executor.onContractUpdate(c); },
  onDisconnect() { executor.onDisconnect(); },
  ownsOrder(orderId) { return executor.orders.has(orderId); },

  setSetting(key, val) {
    settings[key] = val; save(LS_CFG, settings);
    if (key === "k") { const d = $("digDuration"); if (d) d.value = settings.k; }
    if (key !== "stake") rebuild();
    api.render();
  },

  // Demo | Real: selects the account LDPE trades on, through the page's existing account flow.
  // Never falls back to the other account: a failure is shown as the actual error.
  async setAccountType(type) {
    const t = type === "real" ? "real" : "demo";
    settings.accountType = t; save(LS_CFG, settings);
    executor.setAccountType(t);
    execMsg = `${t === "demo" ? "Demo" : "Real"} account selected.`;
    api.render();
    try {
      const r = H().selectAccountType ? await H().selectAccountType(t) : { ok: false, error: "account selection is unavailable" };
      if (r && r.ok === false) execMsg = `Cannot use the ${t} account: ${r.error}`;
      else if (r && r.switching) execMsg = `Switching to the ${t} account ${r.accountId || ""}… re-arm Auto after it connects.`;
    } catch (e) { execMsg = `Cannot use the ${t} account: ${e && e.message ? e.message : e}`; }
    api.render();
  },

  // Stop switch: no automatic trades while stopped; forecasts keep being generated and scored.
  setStopped(b) {
    executor.setStopped(b); settings.stopped = !!b; save(LS_CFG, settings);
    execMsg = executor.stopped ? "Automatic trading stopped. Forecasts continue." : "Automatic trading re-armed.";
    api.render();
  },
  toggleStop() { api.setStopped(!executor.stopped); },
  saveState,

  // Last-resort operator action for an order whose purchase could not be confirmed.
  resolveUnknown(orderId, contractId) { const ok = executor.resolveUnknown(orderId, contractId); persistExec(); api.render(); return ok; },

  render() {
    const root = $("ldpeCard");
    if (!root || !root.offsetParent) return;
    const sym = H().symbol, f = latest[sym];
    const set = (id, h) => { const e = $(id); if (e) e.innerHTML = h; };
    const wu = engine.warmup(sym), m = engine.metrics(sym, engine.cfg.horizon);
    const st = engine.state(sym);
    const pct = (x) => (x * 100).toFixed(1) + "%";
    set("ldpeFeed", `${esc(sym)} · ${st.seq} ticks · dup ${st.quality.duplicates} · out-of-order ${st.quality.outOfOrder} · precision ${st.quality.precisionMismatch} · gaps ${st.quality.gaps}` +
      ` · state: ${engine.isHolding(sym) ? "<b>waiting for history backfill</b>" : "live"}` +
      (restoreInfo.restored && restoreInfo.restored[sym] ? ` · restored ${restoreInfo.restored[sym].ticks} ticks, ${restoreInfo.restored[sym].pending} pending forecasts (models reconstructed by replay)` : "") +
      (api.lastBackfill && api.lastBackfill.symbol === sym ? ` · last backfill ${api.lastBackfill.ingested} new ticks, ${api.lastBackfill.overlap ? "overlap confirmed" : "NO overlap (hole recorded)"}` : ""));
    if (!f) { set("ldpePred", "Waiting for ticks…"); }
    else {
      const cls = f.decision === "TRADE" ? "cell-pos" : "cell-mut";
      set("ldpePred", `<b style="font-size:22px">${f.predictedDigit}</b> &nbsp; p=${(f.probability * 100).toFixed(2)}% &nbsp; <span class="${cls}"><b>${f.decision}</b>${f.reason ? " (" + esc(f.reason) + ")" : ""}</span>` +
        `<div class="cell-mut">horizon ${f.horizon} ticks · target #${f.targetSeq} · threshold ${(f.minProbability * 100).toFixed(1)}% on ${f.triggerSource} · ${wu.isWarmingUp ? "warm-up: " + wu.remaining + " ticks left" : "warm-up complete"} · calibration: ${esc(f.calibrationStatus)} · structural break: ${f.structuralBreak ? "<b>ACTIVE</b>" : "none"} · state v${f.stateVersion}</div>` +
        `<div class="cell-mut">Crossing the trigger is an operational threshold, not evidence of predictive advantage.</div>`);
      const bars = f.vectors.ensemble.map((p, d) => `<div style="display:inline-block;width:9%;text-align:center;vertical-align:bottom"><div style="height:${Math.round(p * 600)}px;background:${d === f.predictedDigit ? "var(--accent)" : "var(--muted)"};opacity:.8;min-height:2px"></div><div style="font-size:11px">${d}<br>${(p * 100).toFixed(1)}</div></div>`).join("");
      const td = f.decision === "TRADE" ? f.predictedDigit : -1;
      window.__ldpeTradeDigit = td;
      for (let d = 0; d < 10; d++) { const c = document.getElementById("digCircle" + d); if (c) c.classList.toggle("ldpe-trade", d === td); }
      set("ldpeDist", `<div class="ldpe-fbox"><span>Forecast digit</span><b>${f.predictedDigit}</b><span>${(f.probability * 100).toFixed(1)}% · ${f.decision}</span></div>` +
        `<div style="position:relative;height:96px;border-bottom:1px solid var(--muted);display:flex;align-items:flex-end;gap:0">${bars}</div><div class="cell-mut">Bars: ensemble P(digit). Uniform reference = 10.0%. Entropy ${entropyBits(f.vectors.ensemble).toFixed(4)} / 3.3219 bits · module disagreement (JS) ${f.disagreement.toFixed(5)} · λ=${f.lambda.toFixed(2)}</div>`);
    }
    set("ldpeMetrics", m.n
      ? `Evaluated forecasts: <b>${m.n}</b> · log loss ${m.logLoss.toFixed(4)} vs uniform ${m.logLossUniform.toFixed(4)} (Δ ${(m.logLoss - m.logLossUniform).toFixed(4)}) · Brier ${m.brier.toFixed(4)} vs 0.9 · top-1 ${(m.top1 * 100).toFixed(1)}% [${(m.top1Ci95[0] * 100).toFixed(1)}, ${(m.top1Ci95[1] * 100).toFixed(1)}] vs 10%`
      : "No evaluated forecasts yet — insufficient data.");

    // Tier 1 diagnostics from the live service state
    const mi = engine.mutualInfo(sym), cal = engine.calibrationStatus(sym), brk = engine.breakStatus(sym), cs = engine.conditionalStats(sym);
    let d = "";
    d += `<div><b>Mutual information</b> (digit → digit +${mi.horizon}): ` + (mi.status === "ok"
      ? `${mi.miBitsCorrected.toFixed(5)} bits (bias-corrected; raw ${mi.miBits.toFixed(5)}), n=${mi.n}, p=${mi.pValue.toPrecision(3)} — ${esc(mi.interpretation)}`
      : `insufficient data (${mi.n}/${mi.needed} samples) — not reported`) + `</div>`;
    d += `<div><b>Calibration:</b> ` + (cal.ready
      ? `isotonic map fitted on ${cal.fittedOn} scored forecasts` + (cal.outOfSample ? `; out-of-sample on ${cal.outOfSample.n}: log loss ${cal.outOfSample.logLossCalibrated.toFixed(4)} calibrated vs ${cal.outOfSample.logLossRaw.toFixed(4)} raw (${cal.outOfSample.logLossCalibrated < cal.outOfSample.logLossRaw ? "calibration helps" : "calibration does not help"})` : "; no out-of-sample check yet")
      : `not ready: ${cal.scored}/${cal.needed} scored forecasts (no calibration applied)`) + `</div>`;
    d += `<div><b>Structural break:</b> ` + (brk.active ? `<span class="cell-neg"><b>ACTIVE</b></span> since #${brk.atSeq} (p=${brk.lastP != null ? Number(brk.lastP).toExponential(2) : "?"}) — trading suspended, module scores halved` : "none active") + ` · total detected: ${brk.count}</div>`;
    if (cs) {
      const gapRows = cs.gaps.map(g => `${g.digit}: ${g.sinceSeen}t${g.n >= 30 && g.hitRate != null ? " → " + pct(g.hitRate) + " (n=" + g.n + ")" : " (n=" + g.n + ", too few)"}`).join(" · ");
      d += `<div><b>Gap context</b> (ticks since each digit; conditional hit rate at +${cs.horizon}, uniform 10%): ${gapRows}</div>`;
      d += `<div><b>Streak context</b>: last digit ${cs.lastDigit}, run ${cs.run}; ` + (cs.streak.n >= 30 ? `next-digit frequencies after this state (n=${cs.streak.n}): ` + cs.streak.freq.map((x, i) => `${i}:${pct(x)}`).join(" ") : `too few matching states (n=${cs.streak.n}) to report frequencies`) + `</div>`;
    }
    set("ldpeDiag", d);

    const sb = engine.scoreboard(sym, engine.cfg.horizon);
    set("ldpeBoard", sb.map(r => `<tr><td class="l">${r.module}</td><td>${(r.weight * 100).toFixed(1)}%</td><td>${r.evaluated}</td><td>${r.relScore.toFixed(3)}</td></tr>`).join(""));

    // Execution: selected account, connected account, Stop state
    const a = host.account(), sel = executor.accountType === "demo" ? "Demo" : "REAL";
    const mm = executor.accountMismatch(a);
    set("ldpeExec", `Trading account: <b class="${executor.accountType === "real" ? "cell-neg" : "cell-pos"}">${sel}</b>` +
      ` · connected: <b>${a.authed ? (a.isVirtual ? "Demo" : "REAL") : "—"}</b> ${esc(a.loginId || "")}` +
      ` · automatic trading: <b>${executor.stopped ? "STOPPED" : H().digAutoArmed ? "running (Auto armed)" : "ready (arm Auto to trade)"}</b>` +
      (mm ? ` · <span class="cell-neg">${esc(mm)}</span>` : ""));
    const mark = (id, on) => { const e = $(id); if (e) { e.style.outline = on ? "2px solid var(--accent)" : "none"; e.style.fontWeight = on ? "800" : "400"; } };
    mark("ldpeAcctDemo", executor.accountType === "demo"); mark("ldpeAcctReal", executor.accountType === "real");
    const sw = $("ldpeStop");
    if (sw) { sw.textContent = executor.stopped ? "▶ Automatic trading: STOPPED (click to re-arm)" : "⏹ Stop automatic trading"; sw.style.background = executor.stopped ? "var(--down)" : ""; }

    const recent = st.forecasts.slice(-12).reverse();
    set("ldpeHist", recent.map(x => `<tr><td class="l">${x.id}</td><td>${x.predictedDigit}</td><td>${(x.probability * 100).toFixed(1)}%</td><td>${x.decision}</td><td>${x.targetSeq}</td><td>${x.realized ?? "—"}</td><td class="${x.hit ? "cell-pos" : "cell-mut"}">${x.status === "scored" ? (x.hit ? "hit" : "miss") : x.status}</td><td>${x.llEnsemble != null ? x.llEnsemble.toFixed(3) + " / " + x.llUniform.toFixed(3) : "—"}</td></tr>`).join("") || `<tr><td colspan="8" class="sig-empty">No scored forecasts yet.</td></tr>`);
    const orders = [...executor.orders.values()].sort((p, q) => q.createdAt - p.createdAt).slice(0, 12);
    set("ldpeExecLog", orders.map(o => `<tr><td class="l">${new Date(o.createdAt).toLocaleTimeString()}</td><td>${o.isVirtual ? "demo" : "real"}/${o.mode}</td><td>${o.digit}</td><td>${o.stake}</td><td>${esc(o.contractId || "—")}</td><td>#${o.forecast.targetSeq}</td><td class="${o.result === "won" ? "cell-pos" : o.result === "lost" ? "cell-neg" : "cell-mut"}">${o.result || esc(o.state + (o.reason ? ": " + o.reason : ""))}</td></tr>`).join("") || `<tr><td colspan="7" class="sig-empty">No LDPE contracts yet.</td></tr>`);
    set("ldpeExecStatus", esc(execMsg));
  },

  buildPanel() {
    const hostEl = $("ldpeSettings");
    if (!hostEl || hostEl.dataset.built) return;
    hostEl.dataset.built = "1";
    hostEl.innerHTML = FIELDS.map(([k, label, , min, max, step]) =>
      `<div class="gc-field"><label for="ldpe_${k}">${label}</label><input type="number" id="ldpe_${k}" min="${min}" max="${max}" step="${step}" value="${settings[k]}"></div>`).join("") +
      `<div class="gc-field"><label for="ldpe_triggerSource">Trigger source</label><select id="ldpe_triggerSource"><option value="ensemble">ensemble (raw)</option><option value="shrunk">shrunk (needs demonstrated gain)</option><option value="calibrated">calibrated (needs ≥ ${DEFAULTS.calMin} scored forecasts)</option></select></div>`;
    $("ldpe_triggerSource").value = settings.triggerSource;
    FIELDS.forEach(([k, , , min, max]) => {
      $("ldpe_" + k).addEventListener("change", (ev) => {
        let v = Number(ev.target.value); if (!Number.isFinite(v)) v = settings[k];
        v = Math.min(max, Math.max(min, v)); ev.target.value = v; api.setSetting(k, v);
      });
    });
    $("ldpe_triggerSource").addEventListener("change", (ev) => api.setSetting("triggerSource", ev.target.value));
    $("ldpeStop").addEventListener("click", () => api.toggleStop());
    $("ldpeAcctDemo").addEventListener("click", () => api.setAccountType("demo"));
    $("ldpeAcctReal").addEventListener("click", () => api.setAccountType("real"));
  },
};

// Restored state: hold live ticks until history arrives; release with a recorded hole if it never does.
for (const sym of engine.symbols.keys()) if (engine.isHolding(sym)) api.beginHold(sym, 8000);
setInterval(() => { executor.sweep(); }, 5000);
window.addEventListener("pagehide", () => { saveState(true); persistExec(); });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") saveState(true); });

window.LDPE = api;
document.addEventListener("DOMContentLoaded", () => api.buildPanel());
if (document.readyState !== "loading") api.buildPanel();
