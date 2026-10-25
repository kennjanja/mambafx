// Under 2 / Over 7 bot (pure logic + a small DOM layer). Trades through the LDPE Executor ONLY (Executor.placeTick).
//
// Rule, evaluated on every accepted tick after the digit gaps were updated (a gap = ticks since the digit last appeared):
//   gap(0) + gap(1) > threshold  -> buy DIGITUNDER with barrier 2 (wins on last digit 0 or 1)
//   gap(8) + gap(9) > threshold  -> buy DIGITOVER  with barrier 7 (wins on last digit 8 or 9)
// While a rule holds the bot buys on EVERY tick (no skipping, no waiting for earlier contracts to settle). If both
// hold, the larger total wins. The stake follows the page's martingale; a confirmed win resets it to the base stake.
// Orders that were bought but not yet settled are projected as losses, so overlapping orders still step the stake.
// Target profit / stop loss are checked on the realised P/L of the armed session and stop the bot.

const keep = (arr, n) => { while (arr.length > n) arr.shift(); };
export const UNDER = { contractType: "DIGITUNDER", barrier: 2, digits: [0, 1], label: "Under 2" };
export const OVER = { contractType: "DIGITOVER", barrier: 7, digits: [8, 9], label: "Over 7" };

export function statusOf(o) {
  return { pricing: "submitted", buying: "submitted", open: "confirmed", settled: "confirmed", rejected: "failed", unknown: "unresolved" }[o.state] || "submitted";
}

// Decides which side (if any) is active for the given per-digit gaps.
export function decide(gaps, threshold) {
  if (!gaps) return { side: null, under: null, over: null };
  const sum = (ds) => (ds.every(d => gaps[d] != null) ? ds.reduce((a, d) => a + gaps[d], 0) : null);
  const under = sum(UNDER.digits), over = sum(OVER.digits);
  const u = under != null && under > threshold, o = over != null && over > threshold;
  let side = null;
  if (u && o) side = over > under ? OVER : UNDER;
  else if (u) side = UNDER; else if (o) side = OVER;
  return { side, under, over };
}

export class UnderOverBot {
  // opts: { k(), stake(pending), threshold(), targetProfit(), stopLoss(), resetStake(), gaps(symbol), onChange(), onLimit(kind, pnl) }
  constructor(executor, opts) {
    this.ex = executor; this.opts = opts;
    this.armed = false; this.pnl = 0; this.stopReason = null; this.stopKind = null; this.stopPnl = null;
    this.run = 0; this.seqBySymbol = new Map(); this.intentions = []; this.byKey = new Map(); this.waiting = false; this.last = null;
    executor.on((o, ev) => this._onOrder(o, ev));
  }
  _changed() { if (this.opts.onChange) { try { this.opts.onChange(); } catch (_) {} } }
  _reset() { if (this.opts.resetStake) { try { this.opts.resetStake(); } catch (_) {} } }

  setArmed(b) {
    const on = !!b;
    if (on && !this.armed) { this.pnl = 0; this.stopReason = null; this.stopKind = null; this.stopPnl = null; this.run++; this._reset(); }
    if (!on && this.armed) this.run++;
    this.armed = on;
    this._changed();
  }

  _checkLimits() {
    if (!this.armed) return;
    const tp = Number(this.opts.targetProfit && this.opts.targetProfit()) || 0, sl = Number(this.opts.stopLoss && this.opts.stopLoss()) || 0;
    let kind = null;
    if (tp > 0 && this.pnl >= tp) kind = "tp"; else if (sl > 0 && this.pnl <= -sl) kind = "sl";
    if (!kind) return;
    this.setArmed(false);
    this.stopKind = kind; this.stopPnl = this.pnl;
    this.stopReason = kind === "tp" ? `take profit reached (${this.pnl.toFixed(2)})` : `stop loss reached (${this.pnl.toFixed(2)})`;
    if (this.opts.onLimit) { try { this.opts.onLimit(kind, this.pnl); } catch (_) {} }
    this._changed();
  }

  _onOrder(o, ev) {
    const it = o.intent && this.byKey.get(o.intent.key); if (!it) return;
    if (ev === "settled" && !it.pnlSeen && o.pnl != null) { it.pnlSeen = true; this.pnl += Number(o.pnl) || 0; }
    it.status = statusOf(o); it.reason = o.reason || null; it.contractId = o.contractId || null;
    if (ev === "settled" && o.result === "won" && !it.winSeen) {
      it.winSeen = true;
      // A confirmed win ends ITS OWN run only: the stake returns to base for the next order.
      if (this.armed && o.intent.cycleId === this._runId()) { this.run++; this._reset(); }
    }
    this._checkLimits();
    this._changed();
  }

  _runId() { return "U:" + this.run; }

  // Orders of the current run already placed whose result is not in the stake progression yet.
  pending() {
    const id = this._runId(); let n = 0;
    for (const o of this.ex.orders.values()) {
      if (!o.intent || o.intent.cycleId !== id || o.state === "rejected" || o.uoRecorded) continue;
      n++;
    }
    return n;
  }

  // Stake progression only takes results of orders from the current run (late results of an ended run are ignored).
  countsForStake(contractId) {
    const o = this.ex.byContract.get(String(contractId));
    if (!o || !o.intent || typeof o.intent.cycleId !== "string" || !o.intent.cycleId.startsWith("U:")) return false;
    const ok = o.intent.cycleId === this._runId();
    if (ok) o.uoRecorded = true;
    return ok;
  }
  owns(contractId) {
    const o = this.ex.byContract.get(String(contractId));
    return !!(o && o.intent && typeof o.intent.cycleId === "string" && o.intent.cycleId.startsWith("U:"));
  }

  // One call per accepted tick, after the digit gaps were updated for that tick. t = { symbol, seq, epoch, digit, active }
  onTick(t) {
    const prev = this.seqBySymbol.has(t.symbol) ? this.seqBySymbol.get(t.symbol) : -1;
    if (t.seq <= prev) return { ignored: "duplicate or out-of-order tick" };
    this.seqBySymbol.set(t.symbol, t.seq);
    this.last = { symbol: t.symbol, seq: t.seq, epoch: t.epoch, digit: t.digit };
    if (!this.armed || !t.active) { this.waiting = false; this._changed(); return { idle: true }; }
    const thr = Math.max(1, Number(this.opts.threshold()) || 30);
    const d = decide(this.opts.gaps(t.symbol), thr);
    if (!d.side) { this.waiting = true; this._changed(); return { waiting: true, under: d.under, over: d.over }; }
    this.waiting = false;
    return this._place(t, d.side);
  }

  _place(t, side) {
    const cycleId = this._runId();
    const key = `U:${t.symbol}:${t.seq}:${t.epoch}`;
    const it = { key, cycleId, side: side.label, symbol: t.symbol, tickSeq: t.seq, tickEpoch: t.epoch, tickDigit: t.digit, at: Date.now(), status: "intended", reason: null, contractId: null };
    this.intentions.push(it); keep(this.intentions, 300); this.byKey.set(key, it);
    const r = this.ex.placeTick({ symbol: t.symbol, digit: side.barrier, k: Math.max(1, Number(this.opts.k()) || 1), contractType: side.contractType, stake: this.opts.stake(this.pending()), tickSeq: t.seq, tickEpoch: t.epoch, tickDigit: t.digit, cycleId, keyPrefix: "U:", forecast: null });
    if (!r.ok) { it.status = "failed"; it.reason = r.reason; } else if (it.status === "intended") it.status = "submitted";
    this._changed();
    return { ok: r.ok, side: side.label };
  }

  counts() {
    const c = { submitted: 0, confirmed: 0, failed: 0, unresolved: 0 };
    for (const it of this.intentions) if (c[it.status] !== undefined) c[it.status]++;
    c.total = this.intentions.length; return c;
  }
}

const LS_SET = "uobot_settings_v1";
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

if (typeof window !== "undefined" && typeof document !== "undefined") {
  const $ = (id) => document.getElementById(id);
  const H = () => window.__ldpeHost || {};
  const num = (id, def = 0) => { const v = parseFloat(($(id) || {}).value); return Number.isFinite(v) && v > 0 ? v : def; };
  let bot = null, current = null;

  const getBot = () => {
    if (bot || !window.LDPE || !window.LDPE.executor || !window.GAPRES) return bot;
    bot = new UnderOverBot(window.LDPE.executor, {
      k: () => num("uoDur", 1),
      stake: (pending) => (H().uoNextStake ? H().uoNextStake(pending) : num("uoStake", 0.5)),
      threshold: () => num("uoThreshold", 30),
      targetProfit: () => num("uoTP"), stopLoss: () => num("uoSL"),
      resetStake: () => { if (H().uoResetStake) H().uoResetStake(); },
      gaps: (sym) => window.GAPRES.research.current(sym),
      onChange: () => render(),
    });
    return bot;
  };

  const render = () => {
    const st = $("uoStatus"); if (!st) return;
    const tr = getBot();
    const banner = $("uoBanner");
    const cur = current && window.GAPRES ? window.GAPRES.research.current(current) : null;
    const thr = num("uoThreshold", 30), d = decide(cur, thr);
    const gapsEl = $("uoGaps");
    if (gapsEl) gapsEl.innerHTML = `<span class="${d.under != null && d.under > thr ? "uo-hit" : ""}">gap 0 + gap 1 = <b>${d.under ?? "—"}</b> → Under 2</span> &nbsp;·&nbsp; <span class="${d.over != null && d.over > thr ? "uo-hit" : ""}">gap 9 + gap 8 = <b>${d.over ?? "—"}</b> → Over 7</span> &nbsp;·&nbsp; trigger &gt; ${thr}`;
    const mx = $("uoMultX"); if (mx && H().uoMultX) mx.textContent = Number(H().uoMultX()).toFixed(1);
    if (!tr) { st.textContent = "Bot unavailable: LDPE executor not loaded."; return; }
    const box = $("uoArm"); if (box) box.checked = tr.armed;
    if (banner) {
      if (tr.stopKind === "tp") { banner.style.display = ""; banner.className = "uo-banner uo-tp"; banner.textContent = `TAKE PROFIT reached — total profit +${Math.abs(tr.stopPnl).toFixed(2)} (session now ${tr.pnl.toFixed(2)}). Bot stopped.`; }
      else if (tr.stopKind === "sl") { banner.style.display = ""; banner.className = "uo-banner uo-sl"; banner.textContent = `STOP LOSS reached — total loss −${Math.abs(tr.stopPnl).toFixed(2)} (session now ${tr.pnl.toFixed(2)}). Bot stopped.`; }
      else banner.style.display = "none";
    }
    const L = window.LDPE, acct = L ? (L.settings.accountType === "real" ? "Real" : "Demo") : "—", n = tr.counts();
    const last = tr.intentions[tr.intentions.length - 1];
    st.innerHTML = `Account: <b>${acct}</b> · ` + (tr.armed
      ? (tr.waiting ? "<b>waiting</b> for a gap total to pass the trigger" : "<b>trading</b> every tick") + ` · next stake ${H().uoNextStake ? H().uoNextStake(tr.pending()).toFixed(2) : "—"}`
      : "bot off" + (tr.stopReason ? ` — stopped: ${esc(tr.stopReason)}` : "")) +
      ` · session P/L ${tr.pnl.toFixed(2)} · orders ${n.total}: submitted ${n.submitted}, confirmed ${n.confirmed}, failed ${n.failed}, unresolved ${n.unresolved}` +
      (last && last.status === "failed" ? ` · last error: ${esc(last.reason)}` : "");
  };

  window.UOBOT = {
    afterTick(sym, digit, epoch) {
      current = sym;
      const tr = getBot(); if (!tr) return;
      const L = window.LDPE;
      tr.onTick({ symbol: sym, seq: L.engine.state(sym).seq, epoch: Number(epoch), digit: Number(digit), active: !L.executor.stopped });
      render();
    },
    arm(on) { const tr = getBot(); if (tr) tr.setArmed(on); const c = $("uoArm"); if (c) c.checked = !!(tr && tr.armed); render(); },
    disarm() { if (bot && bot.armed) this.arm(false); },
    // Results of this bot's orders feed its own stake progression only; returns true when the order is this bot's.
    recordResult(id, stk, won) {
      if (!bot || !bot.owns(id)) return false;
      if (bot.countsForStake(id) && H().uoRecord) H().uoRecord(stk, won);
      return true;
    },
    render,
  };

  // Persist the inputs (not the armed state).
  const IDS = ["uoStake", "uoStrat", "uoThreshold", "uoTP", "uoSL", "uoDur"];
  try {
    const s = JSON.parse(window.localStorage.getItem(LS_SET) || "{}");
    for (const id of IDS) if (s[id] != null && $(id)) $(id).value = s[id];
  } catch (_) {}
  for (const id of IDS) {
    const el = $(id);
    if (el) el.addEventListener("change", () => {
      try { const o = {}; for (const k of IDS) if ($(k)) o[k] = $(k).value; window.localStorage.setItem(LS_SET, JSON.stringify(o)); } catch (_) {}
      render();
    });
  }
  window.addEventListener("pagehide", () => { if (bot && bot.armed) bot.setArmed(false); });
}
