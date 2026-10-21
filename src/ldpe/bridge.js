// LDPE page bridge: connects the pure engine to the existing MambaFX Digits page,
// shared tick stream, Trading Grid execution path and DOM. It owns no WebSocket.
import { Ldpe, DEFAULTS, entropyBits } from "./engine.js";

const LS_CFG = "ldpe_settings_v1", LS_LOG = "ldpe_exec_log_v1", LS_ALIGN = "ldpe_alignment_v1";
const $ = (id) => document.getElementById(id);
const H = () => window.__ldpeHost || {};
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch (_) { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} };

const FIELDS = [
  ["minProbability", "Min probability (0-1)", 0.12, 0.01, 0.5, 0.005],
  ["k", "Contract duration k (ticks)", 5, 1, 10, 1],
  ["minTicks", "Warm-up ticks (minTicks)", 100, 10, 5000, 10],
  ["maxStake", "Max stake", 10, 0.35, 1000, 0.5],
  ["dailyLoss", "Daily loss limit", 20, 0, 100000, 1],
  ["maxConsec", "Max consecutive losses", 5, 1, 100, 1],
  ["maxOpen", "Max open contracts / symbol", 1, 1, 5, 1],
  ["alpha", "Dirichlet alpha", 1, 0.01, 50, 0.1],
  ["shortWindow", "Short window", 50, 10, 1000, 10],
  ["longWindow", "Long window", 1000, 100, 10000, 100],
  ["halfLife", "Count half-life (ticks)", 300, 20, 10000, 10],
  ["eta", "Weight learning rate eta (0.1-5)", 1, 0.1, 5, 0.1],
  ["lossWindow", "Rolling loss window", 500, 50, 5000, 50],
  ["floor", "Weight floor", 0.01, 0, 0.2, 0.005],
];

const saved = load(LS_CFG, {});
const settings = { triggerSource: "ensemble", ...Object.fromEntries(FIELDS.map(f => [f[0], f[2]])), ...saved };
const engineCfg = () => ({
  ...DEFAULTS,
  horizon: effectiveHorizon(),
  minProbability: settings.minProbability, minTicks: settings.minTicks, triggerSource: settings.triggerSource,
  alpha: settings.alpha, shortWindow: settings.shortWindow, longWindow: settings.longWindow,
  halfLife: settings.halfLife, eta: settings.eta, lossWindow: settings.lossWindow, floor: settings.floor,
});

// Alignment: horizon (ticks from forecast tick to settlement tick) learned from real contract responses.
const align = load(LS_ALIGN, {}); // { [k]: { obs:[offsets], verified:null|offset } }
function effectiveHorizon() {
  const a = align[settings.k];
  return a && a.verified ? a.verified : Math.min(10, Math.max(1, settings.k)); // unverified starting assumption
}

let engine = new Ldpe(engineCfg());
let paused = false, killed = false;
let latest = {};                 // symbol -> last forecast
let execLog = load(LS_LOG, []);  // execution records only (never used for learning)
let dayKey = new Date().toISOString().slice(0, 10), dayPnl = 0, consecLosses = 0;
let lastHalt = null;

function rebuild() {
  const old = engine; engine = new Ldpe(engineCfg());
  // keep per-symbol learned state across non-model setting changes
  engine.symbols = old.symbols;
  engine.cfg.horizon = effectiveHorizon();
}

function execAllowed() {
  if (killed) return { ok: false, reason: "kill switch engaged" };
  if (paused) return { ok: false, reason: lastHalt || "paused" };
  if (!H().gridAuthed || !H().gridWs || H().gridWs.readyState !== WebSocket.OPEN) return { ok: false, reason: "not connected on Trading Grid" };
  const a = align[settings.k];
  const verified = !!(a && a.verified);
  if (!verified && !H().gridIsVirtual) {
    return { ok: false, reason: `settlement alignment for k=${settings.k} unverified - run on Demo first (needs 3 consistent contracts)` };
  }
  return { ok: true, verified };
}

function openCount(sym) {
  return (H().digTrades || []).filter(t => t.source === "ldpe" && t.symbol === sym && /pricing|buying|open/.test(t.status)).length;
}

function riskCheck(sym) {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== dayKey) { dayKey = today; dayPnl = 0; consecLosses = 0; }
  if (settings.dailyLoss > 0 && dayPnl <= -settings.dailyLoss) return "daily loss limit reached";
  if (consecLosses >= settings.maxConsec) return "max consecutive losses reached";
  if (openCount(sym) >= settings.maxOpen) return "open contract limit";
  return null;
}

const api = {
  settings, FIELDS,
  get engine() { return engine; },
  latestFor: (s) => latest[s],

  // Called from the shared tick path with the raw quote literal.
  ingest(symbol, rawQuote, decimals, epoch) {
    const r = engine.ingest(symbol, { epoch, quote: rawQuote, decimals, recv: Date.now() });
    if (r.accepted && r.forecast) { latest[symbol] = r.forecast; api.maybeTrade(symbol, r.forecast); }
    api.render();
    return r;
  },
  discontinuity(symbol) { engine.markDiscontinuity(symbol); },

  maybeTrade(symbol, f) {
    if (!H().digAutoArmed || f.decision !== "TRADE") return;
    const ex = execAllowed();
    const status = $("ldpeExecStatus");
    if (!ex.ok) { if (status) status.textContent = "Not executing: " + ex.reason; return; }
    const risk = riskCheck(symbol);
    if (risk) { lastHalt = risk; paused = true; if (status) status.textContent = "Paused: " + risk; return; }
    const placed = H().placeTrade(f.predictedDigit, "ldpe", {
      contractType: "DIGITMATCH", duration: settings.k, forecast: f, maxStake: settings.maxStake,
      symbol,
    });
    if (placed && status) status.textContent = `Fired Matches on ${f.predictedDigit} (p=${(f.probability * 100).toFixed(1)}%, forecast ${f.id})`;
  },

  // Called by gridUpdateContract for any digit row with a forecast attached.
  onContract(row, c) {
    if (row.source !== "ldpe" || !row.forecastId) return;
    if (c.entry_tick_time != null) row.entryEpoch = Number(c.entry_tick_time);
    if (c.exit_tick_time != null) row.exitEpoch = Number(c.exit_tick_time);
    if (c.exit_tick != null) row.exitQuote = String(c.exit_tick_display_value ?? c.exit_tick);
    if (!(c.is_sold || c.is_expired) || row.alignment) return;
    const st = engine.state(row.symbol);
    const f = row.forecast;
    let exitSeq = null;
    if (row.exitEpoch != null) {
      for (let i = st.ticks.length - 1; i >= 0; i--) if (st.ticks[i].epoch === row.exitEpoch) { exitSeq = st.ticks[i].seq; break; }
    }
    if (exitSeq == null || !f) { row.alignment = "unknown"; }
    else {
      const offset = exitSeq - f.madeAtSeq;
      row.settleSeq = exitSeq; row.observedOffset = offset;
      row.alignment = offset === f.horizon ? "aligned" : "misaligned";
      const a = (align[row.k] = align[row.k] || { obs: [], verified: null });
      a.obs.push(offset); if (a.obs.length > 10) a.obs.shift();
      const last3 = a.obs.slice(-3);
      if (last3.length === 3 && last3.every(x => x === last3[0]) && a.verified !== last3[0]) {
        a.verified = last3[0];
        engine.cfg.horizon = effectiveHorizon();
      }
      save(LS_ALIGN, align);
    }
    const won = row.status === "won";
    if (won) consecLosses = 0; else consecLosses++;
    dayPnl += Number(row.pnl || 0);
    execLog.unshift({
      t: row.time, symbol: row.symbol, accountType: row.isVirtual ? "demo" : "real", account: row.accountId,
      stake: row.stake, contractId: row.id, digit: row.digit, forecastId: row.forecastId,
      probability: f && f.probability, vector: f && f.vectors.ensemble, targetSeq: f && f.targetSeq,
      entryEpoch: row.entryEpoch, exitEpoch: row.exitEpoch, alignment: row.alignment,
      result: row.status, pnl: row.pnl,
    });
    if (execLog.length > 300) execLog.length = 300;
    save(LS_LOG, execLog);
    api.render();
  },

  setSetting(key, val) {
    settings[key] = val; save(LS_CFG, settings);
    if (key === "k") { const d = $("digDuration"); if (d) d.value = settings.k; }
    rebuild(); api.render();
  },
  kill() { killed = true; paused = true; lastHalt = "kill switch"; if (H().disarm) H().disarm("LDPE kill switch"); api.render(); },
  resume() { killed = false; paused = false; lastHalt = null; consecLosses = 0; api.render(); },

  verification() { return align[settings.k] || { obs: [], verified: null }; },

  render() {
    const root = $("ldpeCard");
    if (!root || !root.offsetParent) return;
    const sym = H().symbol, f = latest[sym];
    const set = (id, h) => { const e = $(id); if (e) e.innerHTML = h; };
    const wu = engine.warmup(sym), m = engine.metrics(sym, engine.cfg.horizon);
    const st = engine.state(sym);
    set("ldpeFeed", `${sym} · ${st.seq} ticks · dup ${st.quality.duplicates} · out-of-order ${st.quality.outOfOrder} · precision ${st.quality.precisionMismatch} · gaps ${st.quality.gaps}`);
    if (!f) { set("ldpePred", "Waiting for ticks…"); }
    else {
      const cls = f.decision === "TRADE" ? "cell-pos" : "cell-mut";
      set("ldpePred", `<b style="font-size:22px">${f.predictedDigit}</b> &nbsp; p=${(f.probability * 100).toFixed(2)}% &nbsp; <span class="${cls}"><b>${f.decision}</b>${f.reason ? " (" + f.reason + ")" : ""}</span>` +
        `<div class="cell-mut">horizon ${f.horizon} ticks · target #${f.targetSeq} · threshold ${(f.minProbability * 100).toFixed(1)}% on ${f.triggerSource} · ${wu.isWarmingUp ? "warm-up: " + wu.remaining + " ticks left" : "warm-up complete"} · calibration: ${f.calibrationStatus} · ensemble uncertainty ${f.ensembleUncertainty} · state v${f.stateVersion}</div>` +
        `<div class="cell-mut">Crossing the trigger is an operational threshold, not evidence of predictive advantage.</div>`);
      const bars = f.vectors.ensemble.map((p, d) => `<div style="display:inline-block;width:9%;text-align:center;vertical-align:bottom"><div style="height:${Math.round(p * 600)}px;background:${d === f.predictedDigit ? "var(--accent)" : "var(--muted)"};opacity:.8;min-height:2px"></div><div style="font-size:11px">${d}<br>${(p * 100).toFixed(1)}</div></div>`).join("");
      set("ldpeDist", `<div style="position:relative;height:96px;border-bottom:1px solid var(--muted);display:flex;align-items:flex-end;gap:0">${bars}</div><div class="cell-mut">Bars: ensemble P(digit). Uniform reference = 10.0%. Entropy ${entropyBits(f.vectors.ensemble).toFixed(4)} / 3.3219 bits · module disagreement (JS) ${f.disagreement.toFixed(5)} · λ=${f.lambda.toFixed(2)}</div>`);
    }
    set("ldpeMetrics", m.n
      ? `Evaluated forecasts: <b>${m.n}</b> · log loss ${m.logLoss.toFixed(4)} vs uniform ${m.logLossUniform.toFixed(4)} (Δ ${(m.logLoss - m.logLossUniform).toFixed(4)}) · Brier ${m.brier.toFixed(4)} vs 0.9 · top-1 ${(m.top1 * 100).toFixed(1)}% [${(m.top1Ci95[0] * 100).toFixed(1)}, ${(m.top1Ci95[1] * 100).toFixed(1)}] vs 10%`
      : "No evaluated forecasts yet — insufficient data.");
    const sb = engine.scoreboard(sym, engine.cfg.horizon);
    set("ldpeBoard", sb.map(r => `<tr><td class="l">${r.module}</td><td>${(r.weight * 100).toFixed(1)}%</td><td>${r.evaluated}</td><td>${r.relScore.toFixed(3)}</td></tr>`).join(""));
    const v = api.verification();
    const ex = execAllowed();
    set("ldpeExec", `Account: <b>${H().gridIsVirtual ? "Demo" : (H().gridAuthed ? "REAL" : "—")}</b> ${H().gridLoginId || ""} · bot: <b>${killed ? "KILLED" : paused ? "paused (" + lastHalt + ")" : H().digAutoArmed ? "running" : "stopped"}</b> · day P/L (risk only) ${dayPnl.toFixed(2)} · consecutive losses ${consecLosses}` +
      `<br>Settlement alignment k=${settings.k}: ${v.verified ? "<b>verified</b> (offset " + v.verified + " ticks)" : "<b>unverified</b> — observed offsets [" + v.obs.join(", ") + "]; Real execution is blocked until 3 consistent Demo contracts"} · executing: ${ex.ok ? "allowed" : "blocked — " + ex.reason}`);
    const recent = st.forecasts.slice(-12).reverse();
    set("ldpeHist", recent.map(x => `<tr><td class="l">${x.id}</td><td>${x.predictedDigit}</td><td>${(x.probability * 100).toFixed(1)}%</td><td>${x.decision}</td><td>${x.targetSeq}</td><td>${x.realized ?? "—"}</td><td class="${x.hit ? "cell-pos" : "cell-mut"}">${x.status === "scored" ? (x.hit ? "hit" : "miss") : x.status}</td><td>${x.llEnsemble != null ? x.llEnsemble.toFixed(3) + " / " + x.llUniform.toFixed(3) : "—"}</td></tr>`).join("") || `<tr><td colspan="8" class="sig-empty">No scored forecasts yet.</td></tr>`);
    set("ldpeExecLog", execLog.slice(0, 12).map(x => `<tr><td class="l">${new Date(x.t * 1000).toLocaleTimeString()}</td><td>${x.accountType}</td><td>${x.digit}</td><td>${x.stake}</td><td>${x.contractId}</td><td>#${x.targetSeq}</td><td>${x.alignment}</td><td class="${x.result === "won" ? "cell-pos" : "cell-neg"}">${x.result}</td></tr>`).join("") || `<tr><td colspan="8" class="sig-empty">No LDPE contracts yet.</td></tr>`);
  },

  buildPanel() {
    const host = $("ldpeSettings");
    if (!host || host.dataset.built) return;
    host.dataset.built = "1";
    host.innerHTML = FIELDS.map(([k, label, , min, max, step]) =>
      `<div class="gc-field"><label for="ldpe_${k}">${label}</label><input type="number" id="ldpe_${k}" min="${min}" max="${max}" step="${step}" value="${settings[k]}"></div>`).join("") +
      `<div class="gc-field"><label for="ldpe_triggerSource">Trigger source</label><select id="ldpe_triggerSource"><option value="ensemble">ensemble (raw)</option><option value="shrunk">shrunk (needs demonstrated gain)</option></select></div>`;
    $("ldpe_triggerSource").value = settings.triggerSource;
    FIELDS.forEach(([k, , , min, max]) => {
      $("ldpe_" + k).addEventListener("change", (ev) => {
        let v = Number(ev.target.value); if (!Number.isFinite(v)) v = settings[k];
        v = Math.min(max, Math.max(min, v)); ev.target.value = v; api.setSetting(k, v);
      });
    });
    $("ldpe_triggerSource").addEventListener("change", (ev) => api.setSetting("triggerSource", ev.target.value));
    $("ldpeKill").addEventListener("click", () => api.kill());
    $("ldpeResume").addEventListener("click", () => api.resume());
  },
};

window.LDPE = api;
document.addEventListener("DOMContentLoaded", () => api.buildPanel());
if (document.readyState !== "loading") api.buildPanel();
