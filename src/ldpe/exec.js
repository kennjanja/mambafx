// LDPE execution layer: settlement-alignment evidence, and the order lifecycle with its safeguards.
// Pure logic (no DOM, no sockets): the host supplies send/response/account/tick-position functions,
// so the exact code that guards live orders is the code the tests exercise.

export const MIN_CLEAN_EVIDENCE = 5;     // distinct, clean, mutually identical contracts before a config is "verified"
export const MAX_ENTRY_DELAY_TICKS = 0;  // forecast must still be current when the buy is sent
export const STALE_REQUEST_MS = 20000;
export const ALIGN_WAIT_MS = 15000;

export const configKey = (contractType, k, symbol) => `${contractType}|${k}|${symbol}`;

// ---------------------------------------------------------------- alignment evidence
export class AlignmentLedger {
  constructor() { this.cfgs = {}; }

  _cfg(key) { return (this.cfgs[key] = this.cfgs[key] || { evidence: [], ids: [] }); }

  // Compare what the contract actually did with what the forecast assumed. Pure observation: never
  // alters the forecast's own targetSeq.
  evaluate(engine, order, c) {
    const f = order.forecast, sym = order.symbol;
    const key = configKey(order.contractType, order.k, sym);
    const cfg = this._cfg(key);
    const base = {
      contractId: String(order.contractId), forecastId: f.id, key, k: order.k, symbol: sym,
      accountType: order.isVirtual ? "demo" : "real",
      madeAtSeq: f.madeAtSeq, expectedTargetSeq: f.targetSeq, expectedHorizon: f.horizon,
      purchaseTime: num(c.purchase_time ?? c.date_start), entryEpoch: num(c.entry_tick_time), exitEpoch: num(c.exit_tick_time),
      entrySeq: null, exitSeq: null, entryDelayTicks: null, entryFirstAfterPurchase: null,
      ticksEntryToExit: null, observedOffset: null, resolved: false, status: "unresolved", reason: null,
    };
    if (cfg.ids.includes(base.contractId)) return { ...base, status: "duplicate", reason: "contract already evaluated", duplicate: true };
    const done = (patch) => {
      const rec = { ...base, ...patch };
      cfg.evidence.push(rec); cfg.ids.push(base.contractId);
      if (cfg.evidence.length > 100) { cfg.evidence.shift(); cfg.ids.shift(); }
      return rec;
    };
    if (base.entryEpoch == null || base.exitEpoch == null) return done({ reason: "contract response lacks entry/exit tick time" });
    const entrySeq = engine.seqOfEpoch(sym, base.entryEpoch), exitSeq = engine.seqOfEpoch(sym, base.exitEpoch);
    if (entrySeq == null || exitSeq == null) {
      return done({ entrySeq, exitSeq, reason: `missing tick data (${entrySeq == null ? "entry" : "exit"} tick not in local feed)` });
    }
    if (!engine.contiguous(sym, Math.min(f.madeAtSeq, entrySeq - 1), exitSeq)) {
      return done({ entrySeq, exitSeq, reason: "feed hole between forecast and settlement; positions unreliable" });
    }
    const delay = entrySeq - (f.madeAtSeq + 1);
    let first = null;
    if (base.purchaseTime != null) {
      const prev = engine.state(sym).ticks.find(t => t.seq === entrySeq - 1);
      first = base.entryEpoch > base.purchaseTime && (!prev || prev.epoch <= base.purchaseTime);
    }
    const offset = exitSeq - f.madeAtSeq;
    let status;
    if (delay < 0) status = "inconsistent";                 // entry before the tick that followed the forecast
    else if (delay > 0) status = "misaligned_delay";        // bought late: contract settles after the forecast target
    else status = exitSeq === f.targetSeq ? "aligned" : "misaligned_offset";
    return done({
      entrySeq, exitSeq, entryDelayTicks: delay, entryFirstAfterPurchase: first,
      ticksEntryToExit: exitSeq - entrySeq, observedOffset: offset, resolved: true, status,
      reason: status === "aligned" ? null
        : status === "misaligned_delay" ? `entry was ${delay} tick(s) after the tick following the forecast`
        : status === "misaligned_offset" ? `settled ${offset} ticks after the forecast, forecast assumed ${f.horizon}`
        : "entry preceded the forecast",
    });
  }

  // Verified only when enough clean, identical, independent observations establish a fixed relationship.
  status(key, maxHorizon = 10) {
    const ev = this._cfg(key).evidence;
    const resolved = ev.filter(e => e.resolved);
    const clean = resolved.filter(e => e.entryDelayTicks === 0 && e.entryFirstAfterPurchase === true);
    const offsets = [...new Set(clean.map(e => e.observedOffset))];
    const spans = [...new Set(resolved.map(e => e.ticksEntryToExit))];
    const out = { key, observed: ev.length, resolved: resolved.length, clean: clean.length, needed: MIN_CLEAN_EVIDENCE, offsets, spans };
    if (ev.some(e => e.status === "inconsistent")) return { ...out, state: "contradicted", reason: "an observed contract entered before its forecast" };
    if (offsets.length > 1 || spans.length > 1) return { ...out, state: "contradicted", reason: `observations disagree (offsets ${offsets.join("/")}, entry-to-exit spans ${spans.join("/")})` };
    if (clean.length >= MIN_CLEAN_EVIDENCE) {
      const horizon = offsets[0];
      if (horizon > maxHorizon || horizon < 1) return { ...out, state: "unsupported", horizon, reason: `settlement ${horizon} ticks ahead is outside the supported horizon range` };
      const k = Number(key.split("|")[1]);
      const span = spans[0];
      return {
        ...out, state: "verified", horizon, span, matchesConfiguredTicks: horizon === k,
        relation: `settlement tick = forecast tick + ${horizon}; entry-to-exit span = ${span} ticks (configured duration ${k})`,
        reason: null,
      };
    }
    return { ...out, state: "unresolved", reason: `${clean.length}/${MIN_CLEAN_EVIDENCE} clean Demo observations` };
  }

  serialize() { return JSON.parse(JSON.stringify(this.cfgs)); }
  restore(o) { this.cfgs = o && typeof o === "object" ? o : {}; for (const c of Object.values(this.cfgs)) { c.evidence = c.evidence || []; c.ids = c.ids || []; } }
}
const num = (x) => (x == null || x === "" || !Number.isFinite(Number(x)) ? null : Number(x));

// ---------------------------------------------------------------- executor
const LIVE = new Set(["pricing", "buying", "open", "unknown"]);

export class Executor {
  // host: { send(msg), nextReqId(), await(reqId, cb(resp, err)), account(), currentSeq(symbol), now() }
  constructor(host, { alignment, getEngine, limits } = {}) {
    this.host = host; this.alignment = alignment || new AlignmentLedger(); this.getEngine = getEngine || (() => null);
    this.limits = { maxOpen: 1, maxStake: 10, dailyLoss: 20, maxConsec: 5, ...(limits || {}) };
    this.orders = new Map();          // id -> order
    this.byContract = new Map();      // contractId -> order
    this.orderedForecasts = new Set();// one order per forecast, ever (persisted)
    this.settled = new Set();         // contract ids already settled (persisted)
    this.risk = {};                   // accountId -> {day, pnl, consec}
    this.lock = null; this.killed = false; this.pausedReason = null;
    this.listeners = []; this.seq = 0; this.log = [];
  }

  on(fn) { this.listeners.push(fn); }
  _emit(order, ev) { for (const fn of this.listeners) { try { fn(order, ev); } catch (_) {} } }
  _note(msg) { this.log.push(msg); if (this.log.length > 200) this.log.shift(); }
  _now() { return this.host.now ? this.host.now() : Date.now(); }

  limitsUpdate(l) { Object.assign(this.limits, l); }
  kill(reason = "kill switch") { this.killed = true; this.pausedReason = reason; }
  resume() { this.killed = false; this.pausedReason = null; for (const r of Object.values(this.risk)) r.consec = 0; }
  lockAccount(acct) { this.lock = { loginId: acct.loginId, isVirtual: !!acct.isVirtual }; }
  unlockAccount() { this.lock = null; }

  openCount(symbol) { let n = 0; for (const o of this.orders.values()) if (o.symbol === symbol && LIVE.has(o.state)) n++; return n; }
  _riskFor(acct) {
    const day = new Date(this._now()).toISOString().slice(0, 10);
    const r = (this.risk[acct] = this.risk[acct] || { day, pnl: 0, consec: 0 });
    if (r.day !== day) { r.day = day; r.pnl = 0; r.consec = 0; }
    return r;
  }

  // Everything that can refuse an order happens here, synchronously, BEFORE any message is sent.
  place(req) {
    const h = this.host, a = h.account(), L = this.limits;
    const refuse = (reason) => { this._note(`refused ${req.symbol}: ${reason}`); return { ok: false, reason }; };
    const f = req.forecast, mode = req.mode || "auto";
    if (this.killed) return refuse(this.pausedReason || "kill switch engaged");
    if (!a.authed || !a.open) return refuse("not connected on Trading Grid");
    if (!f) return refuse("no forecast attached");
    if (this.lock && (this.lock.loginId !== a.loginId || this.lock.isVirtual !== !!a.isVirtual)) {
      return refuse(`account changed (armed on ${this.lock.loginId}, now ${a.loginId}); disarm and re-arm to confirm`);
    }
    const key = configKey(req.contractType, req.k, req.symbol);
    const st = this.alignment.status(key);
    if (mode === "probe") {
      if (!a.isVirtual) return refuse("alignment probes are Demo-only");
    } else {
      if (st.state !== "verified") return refuse(`settlement alignment ${st.state} for ${key}: ${st.reason}`);
      if (f.decision !== "TRADE") return refuse("forecast is not a TRADE decision");
    }
    if (h.currentSeq(req.symbol) !== f.madeAtSeq) return refuse("stale forecast (newer ticks have arrived)");
    if (this.orderedForecasts.has(f.id)) return refuse("duplicate: an order already exists for this forecast");
    if (this.openCount(req.symbol) >= Math.min(L.maxOpen, 1)) return refuse("open contract limit (max one per symbol)");
    const risk = this._riskFor(a.loginId);
    if (L.dailyLoss > 0 && risk.pnl <= -L.dailyLoss) return refuse("daily loss limit reached");
    if (risk.consec >= L.maxConsec) return refuse("max consecutive losses reached");
    const stake = Math.min(Math.max(0.35, Number(req.stake) || 0), L.maxStake);
    if (!(stake >= 0.35)) return refuse("invalid stake");

    const order = {
      id: `o${++this.seq}-${this._now()}`, contractId: null, state: "pricing", reason: null,
      forecastId: f.id,
      forecast: { id: f.id, madeAtSeq: f.madeAtSeq, targetSeq: f.targetSeq, horizon: f.horizon, madeAtEpoch: f.madeAtEpoch, predictedDigit: f.predictedDigit, probability: f.probability, decision: f.decision },
      symbol: req.symbol, digit: req.digit, k: req.k, contractType: req.contractType, stake, mode,
      accountId: a.loginId, isVirtual: !!a.isVirtual, currency: a.currency,
      createdAt: this._now(), updatedAt: this._now(), alignment: null, result: null, pnl: null,
      entryEpoch: null, exitEpoch: null, purchaseTime: null,
    };
    // synchronous reservation: concurrent callers now see this order
    this.orders.set(order.id, order);
    this.orderedForecasts.add(f.id);
    this._emit(order, "created");

    const reqId = h.nextReqId();
    const msg = { proposal: 1, req_id: reqId, amount: stake, basis: "stake", contract_type: req.contractType, currency: a.currency, duration: req.k, duration_unit: "t", underlying_symbol: req.symbol, barrier: String(req.digit) };
    h.await(reqId, (proposal, err) => this._onProposal(order, proposal, err));
    try { h.send(msg); } catch (e) { this._finish(order, "rejected", "send failed: " + (e && e.message)); return { ok: false, reason: order.reason, order }; }
    return { ok: true, order };
  }

  _set(order, state, reason) { order.state = state; if (reason !== undefined) order.reason = reason; order.updatedAt = this._now(); }
  _finish(order, state, reason) { this._set(order, state, reason); this._emit(order, state); }

  _onProposal(order, proposal, err) {
    if (order.state !== "pricing") { this._note(`ignored late/duplicate proposal for ${order.id}`); return; }
    if (err) return this._finish(order, "rejected", "proposal rejected: " + (err.message || "error"));
    if (!proposal || !proposal.id || proposal.ask_price == null) return this._finish(order, "rejected", "proposal missing id/ask_price");
    const h = this.host, a = h.account();
    if (!a.authed || !a.open) return this._finish(order, "rejected", "connection lost before purchase");
    if (a.loginId !== order.accountId || !!a.isVirtual !== order.isVirtual) return this._finish(order, "rejected", "account changed before purchase");
    if (this.killed) return this._finish(order, "rejected", "kill switch engaged before purchase");
    if (h.currentSeq(order.symbol) - order.forecast.madeAtSeq > MAX_ENTRY_DELAY_TICKS) return this._finish(order, "rejected", "stale before purchase: a newer tick arrived, entry would not follow the forecast");
    if (Number(proposal.ask_price) > this.limits.maxStake + 1e-9) return this._finish(order, "rejected", "ask price exceeds max stake");
    const reqId = h.nextReqId();
    this._set(order, "buying");
    this._emit(order, "buying");
    h.await(reqId, (buy, buyErr) => this._onBuy(order, buy, buyErr));
    try { h.send({ buy: proposal.id, price: proposal.ask_price, req_id: reqId }); } catch (e) { this._set(order, "unknown", "buy send failed; outcome unknown"); this._emit(order, "unknown"); }
  }

  _onBuy(order, buy, err) {
    if (order.state !== "buying" && order.state !== "unknown") { this._note(`ignored duplicate buy response for ${order.id}`); return; }
    if (err) return this._finish(order, "rejected", "buy rejected: " + (err.message || "error"));
    const id = buy && buy.contract_id != null ? String(buy.contract_id) : null;
    if (!id) return this._finish(order, "rejected", "buy response missing contract id");
    if (this.byContract.has(id) && this.byContract.get(id) !== order) { this._note(`contract ${id} already mapped to another order`); return; }
    order.contractId = id; order.buyPrice = Number(buy.buy_price);
    order.purchaseTime = num(buy.purchase_time);
    this.byContract.set(id, order);
    this._set(order, "open", null);
    this._emit(order, "open");
  }

  // proposal_open_contract updates: may repeat, arrive out of order, or concern foreign contracts.
  onContractUpdate(c) {
    const id = String(c.contract_id), order = this.byContract.get(id);
    if (!order) return { handled: false, reason: "not an LDPE order" };
    if (order.state === "settled") return { handled: true, duplicate: true, order };
    if (order.state === "rejected") return { handled: false, reason: "order was rejected" };
    if (c.purchase_time != null) order.purchaseTime = num(c.purchase_time);
    if (c.entry_tick_time != null) order.entryEpoch = num(c.entry_tick_time);
    if (c.exit_tick_time != null) order.exitEpoch = num(c.exit_tick_time);
    const final = c.is_sold || c.is_expired || c.status === "won" || c.status === "lost";
    if (!final) { if (order.state === "unknown") this._set(order, "open"); this._emit(order, "update"); return { handled: true, order }; }
    if (this.settled.has(id)) { this._set(order, "settled"); return { handled: true, duplicate: true, order }; }
    this.settled.add(id);
    const pnl = c.profit != null ? Number(c.profit) : null;
    order.pnl = pnl; order.result = pnl != null && pnl >= 0 ? "won" : "lost";
    this._set(order, "settled", null);
    const risk = this._riskFor(order.accountId);
    if (pnl != null) risk.pnl += pnl;
    risk.consec = order.result === "lost" ? risk.consec + 1 : 0;
    order.settledAt = this._now();
    order.finalC = { purchase_time: c.purchase_time, date_start: c.date_start, entry_tick_time: c.entry_tick_time, exit_tick_time: c.exit_tick_time };
    this._tryAlign(order, false);
    this._emit(order, "settled");
    return { handled: true, settled: true, order };
  }

  // The public tick feed is a separate socket from the trading socket, so the settlement tick may not
  // have reached the engine yet. Evaluation waits for both ticks (up to ALIGN_WAIT_MS), then records
  // whatever is available, so missing data is recorded as such rather than guessed.
  _tryAlign(order, force) {
    const eng = this.getEngine();
    if (!eng || order.alignment || !order.finalC) return;
    const c = order.finalC, sym = order.symbol;
    const have = c.entry_tick_time != null && c.exit_tick_time != null
      && eng.seqOfEpoch(sym, Number(c.entry_tick_time)) != null && eng.seqOfEpoch(sym, Number(c.exit_tick_time)) != null;
    const timesMissing = c.entry_tick_time == null || c.exit_tick_time == null;
    if (!have && !force && !timesMissing && this._now() - order.settledAt < ALIGN_WAIT_MS) return;
    try { order.alignment = this.alignment.evaluate(eng, order, c); } catch (e) { order.alignment = { status: "unresolved", reason: "evaluation error: " + e.message }; }
    this._emit(order, "aligned");
  }

  // Call on every tick and periodically: completes evaluations that were waiting for ticks.
  retryAlignment() {
    for (const o of this.orders.values()) if (o.state === "settled" && !o.alignment && o.finalC) this._tryAlign(o, false);
  }

  // Socket dropped. Nothing has been confirmed for in-flight requests.
  onDisconnect() {
    for (const o of this.orders.values()) {
      if (o.state === "pricing") this._finish(o, "rejected", "connection lost before purchase");
      else if (o.state === "buying") { this._set(o, "unknown", "connection lost while buying; check the account before resuming"); this._emit(o, "unknown"); this.kill("unconfirmed order after reconnect"); }
    }
  }

  // Operator/portfolio reconciliation of an unknown order: contractId if it exists on the account, else null.
  resolveUnknown(orderId, contractId) {
    const o = this.orders.get(orderId);
    if (!o || o.state !== "unknown") return false;
    if (contractId) { o.contractId = String(contractId); this.byContract.set(o.contractId, o); this._set(o, "open", null); this._emit(o, "open"); }
    else this._finish(o, "rejected", "confirmed absent on account");
    return true;
  }

  sweep() {
    const t = this._now();
    for (const o of this.orders.values()) {
      if (t - o.updatedAt < STALE_REQUEST_MS) continue;
      if (o.state === "pricing") this._finish(o, "rejected", "no proposal response (timeout)");
      else if (o.state === "buying") { this._set(o, "unknown", "no buy response (timeout)"); this._emit(o, "unknown"); this.kill("unconfirmed order"); }
    }
  }

  // ---- persistence (no credentials: only order/forecast ids, risk counters, alignment evidence)
  serialize() {
    const live = [...this.orders.values()].filter(o => LIVE.has(o.state)).map(o => ({ ...o }));
    const recent = [...this.orders.values()].filter(o => !LIVE.has(o.state)).slice(-100).map(o => ({ ...o }));
    return {
      v: 1, orderedForecasts: [...this.orderedForecasts].slice(-1000), settled: [...this.settled].slice(-1000),
      risk: this.risk, orders: [...live, ...recent], alignment: this.alignment.serialize(), seq: this.seq,
    };
  }
  restore(s) {
    if (!s || s.v !== 1) return;
    this.orderedForecasts = new Set(s.orderedForecasts || []); this.settled = new Set(s.settled || []);
    this.risk = s.risk || {}; this.seq = s.seq || 0;
    this.alignment.restore(s.alignment);
    for (const o of s.orders || []) {
      const order = { ...o };
      // In-flight requests cannot survive a reload: unconfirmed purchases are held as unknown.
      if (order.state === "pricing") order.state = "rejected", order.reason = "page reloaded before purchase";
      if (order.state === "buying") { order.state = "unknown"; order.reason = "page reloaded while buying; confirm on account"; }
      this.orders.set(order.id, order);
      if (order.contractId) this.byContract.set(String(order.contractId), order);
    }
    if ([...this.orders.values()].some(o => o.state === "unknown")) this.kill("unconfirmed order after reload");
  }
}
