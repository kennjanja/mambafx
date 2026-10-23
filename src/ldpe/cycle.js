// LDPE tick-driven cycles (pure logic: no DOM, no sockets). Sits between the engine's forecasts and the
// Executor, which remains the ONLY order path (Executor.placeTick).
//
// A cycle has one fixed target digit taken from a current LDPE prediction. For every incoming tick whose
// last digit is NOT the target, exactly one DIGITMATCH purchase intention is made. The tick on which the
// target digit appears ends the cycle and is never bought. The next cycle takes the next eligible, current
// prediction (it begins on the following tick); if none is eligible the manager waits. Purchases never wait
// for earlier contracts: every order is tracked independently by the Executor.

const CONTRACT = "DIGITMATCH";
const keep = (arr, n) => { while (arr.length > n) arr.shift(); };

export function intentionStatusFromOrder(o) {
  switch (o.state) {
    case "pricing": case "buying": return "submitted";
    case "open": case "settled": return "confirmed";
    case "rejected": return "failed";
    case "unknown": return "unresolved";
    default: return "submitted";
  }
}

export class CycleManager {
  // opts: { k(): ticks, stake(): number, limits(): {max,count}, noteOrder(): void, onChange(): void }
  constructor(executor, opts = {}) {
    this.ex = executor; this.opts = opts;
    this.sym = {};                // symbol -> { cycle, lastSeq, lastEpoch, waiting }
    this.intentions = [];         // newest last, capped
    this.byKey = new Map();
    this.cycles = [];             // finished cycles, capped
    this.cycleSeq = 0;
    this.usedForecasts = new Set();
    this.stats = { duplicateTicks: 0 };
    executor.on((order, ev) => this._onOrder(order, ev));
  }

  _changed() { if (this.opts.onChange) { try { this.opts.onChange(); } catch (_) {} } }
  _s(symbol) { return this.sym[symbol] || (this.sym[symbol] = { cycle: null, lastSeq: -1, lastEpoch: -1, waiting: false }); }

  _onOrder(order, ev) {
    if (!order.intent) return;
    const it = this.byKey.get(order.intent.key); if (!it) return;
    it.status = intentionStatusFromOrder(order); it.reason = order.reason || null;
    it.contractId = order.contractId || null;
    if (ev === "settled" && !it.settledSeen) {
      it.settledSeen = true;
      // A confirmed win ends ITS OWN cycle only; a late win from an older cycle never touches a newer one.
      if (order.result === "won") {
        const st = this._s(order.symbol), c = st.cycle;
        if (c && c.id === order.intent.cycleId) { this._end(st, "win confirmed", { seq: st.lastSeq }); st.waiting = true; }
      }
    }
    if (ev === "settled") {
      const p = order.provisional;
      if (p) order.reconciliation = { outcomeAgrees: p.win === (order.result === "won"), exitTickAgrees: order.exitEpoch != null ? order.exitEpoch === p.epoch : null };
    }
    this._changed();
  }

  // Provisional outcome of a confirmed one-tick contract: the first tick after purchase decides it, so the
  // next purchase does not wait for Deriv's settlement. It is labelled non-authoritative and reconciled with
  // Deriv's contract data when that arrives (order.reconciliation); Deriv's result always wins.
  _observe(t) {
    for (const o of this.ex.orders.values()) {
      if (o.symbol !== t.symbol || o.k !== 1 || o.provisional || !o.contractId || o.purchaseTime == null) continue;
      if (o.state !== "open") continue;
      if (t.epoch > o.purchaseTime) o.provisional = { digit: t.digit, win: t.digit === o.digit, epoch: t.epoch, authoritative: false };
    }
  }

  _end(st, reason, t) {
    const c = st.cycle; if (!c) return;
    c.endedAtSeq = t.seq; c.endReason = reason;
    this.cycles.push(c); keep(this.cycles, 100);
    st.cycle = null;
    this._resetStake();
  }

  _resetStake() { if (this.opts.resetStake) { try { this.opts.resetStake(); } catch (_) {} } }

  // Stake progression is scoped to the active cycle: a result only feeds it if its order belongs to that cycle.
  // Late confirmations/settlements from finished cycles are ignored, so they cannot restore an old stake.
  countsForStake(contractId) {
    const o = this.ex.byContract.get(String(contractId));
    if (!o || !o.intent || typeof o.intent.cycleId !== "number") return true;   // not an LDPE-cycle order
    const c = this._s(o.symbol).cycle;
    return !!c && c.id === o.intent.cycleId;
  }

  _eligible(f, t) {
    return !!f && f.decision === "TRADE" && !f.reconstructed && f.madeAtSeq === t.seq && f.symbol === t.symbol && !this.usedForecasts.has(f.id);
  }

  // t = { symbol, seq, epoch, digit, forecast, active }  (one call per ACCEPTED tick)
  onTick(t) {
    const st = this._s(t.symbol);
    if (t.seq <= st.lastSeq || t.epoch <= st.lastEpoch) { this.stats.duplicateTicks++; return { ignored: "duplicate or out-of-order tick" }; }
    st.lastSeq = t.seq; st.lastEpoch = t.epoch;
    this._observe(t);
    if (!t.active) { this._end(st, "automatic trading off or stopped", t); st.waiting = false; this._changed(); return { idle: true }; }

    if (st.cycle) {
      if (t.digit !== st.cycle.target) return this._intend(st, t);
      this._end(st, `target ${t.digit} appeared`, t);   // the target tick is never bought
    }
    const lim = this.opts.limits ? this.opts.limits() : { max: 0, count: 0 };
    if (lim.max && lim.count >= lim.max) {
      // Stop-after-N never cuts a running cycle short: it only prevents the NEXT cycle from starting.
      st.waiting = false; this._changed();
      if (this.opts.onLimit) { try { this.opts.onLimit(lim.max); } catch (_) {} }
      return { idle: true, limit: lim.max };
    }
    const f = t.forecast;
    if (this._eligible(f, t)) {
      this.usedForecasts.add(f.id);
      if (this.usedForecasts.size > 1000) this.usedForecasts.delete(this.usedForecasts.values().next().value);
      this._resetStake();
      st.cycle = { id: ++this.cycleSeq, symbol: t.symbol, target: f.predictedDigit, forecastId: f.id, forecast: f, startedAfterSeq: t.seq, intentions: 0 };
      st.waiting = false; this._changed();
      return { started: st.cycle.id, target: st.cycle.target };
    }
    st.waiting = true; this._changed();
    return { waiting: true };
  }

  _intend(st, t) {
    const c = st.cycle;
    const key = `${t.symbol}:${t.seq}:${t.epoch}`;
    const it = { key, cycleId: c.id, symbol: t.symbol, tickSeq: t.seq, tickEpoch: t.epoch, tickDigit: t.digit, target: c.target, at: Date.now(), status: "intended", reason: null, contractId: null };
    this.intentions.push(it); keep(this.intentions, 300); this.byKey.set(key, it);
    c.intentions++;
    const r = this.ex.placeTick({ symbol: t.symbol, digit: c.target, k: this.opts.k(), contractType: CONTRACT, stake: this.opts.stake(), tickSeq: t.seq, tickEpoch: t.epoch, tickDigit: t.digit, cycleId: c.id, forecast: c.forecast });
    if (!r.ok) { it.status = "failed"; it.reason = r.reason; }
    else { if (it.status === "intended") it.status = "submitted"; if (this.opts.noteOrder) this.opts.noteOrder(); }
    this._changed();
    return { intended: key, ok: r.ok };
  }

  counts(symbol) {
    const c = { intended: 0, submitted: 0, confirmed: 0, failed: 0, unresolved: 0 };
    for (const it of this.intentions) if (!symbol || it.symbol === symbol) c[it.status] = (c[it.status] || 0) + 1;
    c.total = this.intentions.filter(i => !symbol || i.symbol === symbol).length;
    return c;
  }
  status(symbol) {
    const st = this._s(symbol);
    return { cycle: st.cycle ? { id: st.cycle.id, target: st.cycle.target, forecastId: st.cycle.forecastId, intentions: st.cycle.intentions } : null, waiting: st.waiting, counts: this.counts(symbol) };
  }

  serialize() {
    return { v: 1, cycleSeq: this.cycleSeq, intentions: this.intentions.slice(-300), cycles: this.cycles.slice(-100).map(({ forecast, ...c }) => c), usedForecasts: [...this.usedForecasts].slice(-500) };
  }
  // Active cycles are never restored: after a reload a target would be stale, so the manager waits for a fresh prediction.
  restore(s) {
    if (!s || s.v !== 1) return;
    this.cycleSeq = s.cycleSeq || 0; this.cycles = s.cycles || []; this.usedForecasts = new Set(s.usedForecasts || []);
    this.intentions = (s.intentions || []).map(it => {
      const o = [...this.ex.orders.values()].find(x => x.intent && x.intent.key === it.key);
      if (o) { it.status = intentionStatusFromOrder(o); it.reason = o.reason || null; it.contractId = o.contractId || null; }
      else if (it.status === "intended" || it.status === "submitted") { it.status = "unresolved"; it.reason = "page reloaded; no order record"; }
      this.byKey.set(it.key, it);
      return it;
    });
  }
}
