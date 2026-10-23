// LDPE execution layer: the order lifecycle and the ONLY path LDPE uses to place orders.
// Pure logic (no DOM, no sockets): the host supplies send/response/account/tick-position functions,
// so the exact code that places live orders is the code the tests exercise.
//
// Controls: a Demo/Real account selection (orders go to exactly that account type, never the other),
// and a Stop switch (no automatic orders while stopped). Orders are also refused when the forecast is
// not a TRADE decision, is stale, or already has an order (duplicate-order prevention).

export const MAX_ENTRY_DELAY_TICKS = 0;  // forecast must still be current when the buy is sent
export const MAX_TICK_ORDER_LAG = 2;    // tick-driven orders: ticks allowed between the intention and the buy
export const PROPOSAL_TIMEOUT_MS = 4000;  // no proposal reply by then: nothing was bought, so the order is failed cleanly
export const MAX_ORDERS_PER_SEC = 2;    // each order is two API calls (proposal + buy); no automatic retries
export const STALE_REQUEST_MS = 20000;
export const MIN_STAKE = 0.35;

const LIVE = new Set(["pricing", "buying", "open", "unknown"]);
const num = (x) => (x == null || x === "" || !Number.isFinite(Number(x)) ? null : Number(x));

export class Executor {
  // host: { send(msg), nextReqId(), await(reqId, cb(resp, err)), account(), currentSeq(symbol), now() }
  constructor(host, { accountType = "demo", stopped = false } = {}) {
    this.host = host;
    this.accountType = accountType === "real" ? "real" : "demo";
    this.stopped = !!stopped;
    this.orders = new Map();          // id -> order
    this.byContract = new Map();      // contractId -> order
    this.orderedForecasts = new Set();// one order per forecast, ever (persisted)
    this.settled = new Set();         // contract ids already settled (persisted)
    this.orderedTicks = new Set();    // tick keys that already have a tick-driven order (persisted)
    this.sentAt = [];                 // recent tick-order send times (rate limit)
    this.legacy = null;               // stored records from earlier versions, passed through untouched
    this.listeners = []; this.seq = 0; this.log = [];
  }

  on(fn) { this.listeners.push(fn); }
  _emit(order, ev) { for (const fn of this.listeners) { try { fn(order, ev); } catch (_) {} } }
  _note(msg) { this.log.push(msg); if (this.log.length > 200) this.log.shift(); }
  _now() { return this.host.now ? this.host.now() : Date.now(); }

  setAccountType(t) { this.accountType = t === "real" ? "real" : "demo"; }
  setStopped(b) { this.stopped = !!b; }

  // The error to show when the connected account is not the selected one (never falls back).
  accountMismatch(a = this.host.account()) {
    const want = this.accountType === "demo";
    if (!a.authed || !a.open) return "not connected on Trading Grid";
    if (!!a.isVirtual !== want) {
      return `${this.accountType === "demo" ? "Demo" : "Real"} account selected, but the connected account is ${a.isVirtual ? "Demo" : "Real"} (${a.loginId}); no fallback to the other account`;
    }
    return null;
  }

  // Everything that can refuse an order happens here, synchronously, BEFORE any message is sent.
  place(req) {
    const h = this.host, a = h.account();
    const refuse = (reason) => { this._note(`refused ${req.symbol}: ${reason}`); return { ok: false, reason }; };
    const f = req.forecast;
    if (this.stopped) return refuse("stopped");
    const mm = this.accountMismatch(a);
    if (mm) return refuse(mm);
    if (!f) return refuse("no forecast attached");
    if (f.decision !== "TRADE") return refuse("forecast is not a TRADE decision");
    if (h.currentSeq(req.symbol) !== f.madeAtSeq) return refuse("stale forecast (newer ticks have arrived)");
    if (this.orderedForecasts.has(f.id)) return refuse("duplicate: an order already exists for this forecast");
    const stake = Math.round(Number(req.stake) * 100) / 100; // Deriv allows at most 2 decimals
    if (!Number.isFinite(stake) || stake < MIN_STAKE) return refuse(`invalid stake (minimum ${MIN_STAKE})`);

    const order = {
      id: `o${++this.seq}-${this._now()}`, contractId: null, state: "pricing", reason: null,
      forecastId: f.id,
      forecast: { id: f.id, madeAtSeq: f.madeAtSeq, targetSeq: f.targetSeq, horizon: f.horizon, madeAtEpoch: f.madeAtEpoch, predictedDigit: f.predictedDigit, probability: f.probability, decision: f.decision },
      symbol: req.symbol, digit: req.digit, k: req.k, contractType: req.contractType, stake, mode: "auto",
      accountId: a.loginId, isVirtual: !!a.isVirtual, currency: a.currency,
      createdAt: this._now(), updatedAt: this._now(), result: null, pnl: null,
      entryEpoch: null, exitEpoch: null, purchaseTime: null,
    };
    // synchronous reservation: concurrent callers now see this order's forecast as taken
    this.orders.set(order.id, order);
    this.orderedForecasts.add(f.id);
    this._emit(order, "created");

    const reqId = h.nextReqId();
    const msg = { proposal: 1, req_id: reqId, amount: stake, basis: "stake", contract_type: req.contractType, currency: a.currency, duration: req.k, duration_unit: "t", underlying_symbol: req.symbol, barrier: String(req.digit) };
    h.await(reqId, (proposal, err) => this._onProposal(order, proposal, err));
    try { h.send(msg); } catch (e) { this._finish(order, "rejected", "send failed: " + (e && e.message)); return { ok: false, reason: order.reason, order }; }
    return { ok: true, order };
  }

  // Tick-driven order: one DIGITMATCH purchase intention for one incoming tick (see cycle.js). It is tied to
  // the tick, not to a forecast, so many orders may share one cycle target. Same account checks, same
  // proposal/buy workflow; never retried.
  placeTick(req) {
    const h = this.host, a = h.account();
    const refuse = (reason) => { this._note(`refused tick ${req.symbol}#${req.tickSeq}: ${reason}`); return { ok: false, reason }; };
    if (this.stopped && !req.manual) return refuse("stopped");
    const mm = this.accountMismatch(a);
    if (mm) return refuse(mm);
    const key = `${req.keyPrefix || ""}${req.symbol}:${req.tickSeq}:${req.tickEpoch}`;
    if (this.orderedTicks.has(key)) return refuse("duplicate: this tick already has a purchase intention");
    const stake = Math.round(Number(req.stake) * 100) / 100;
    if (!Number.isFinite(stake) || stake < MIN_STAKE) return refuse(`invalid stake (minimum ${MIN_STAKE})`);
    if (!(req.digit >= 0 && req.digit <= 9)) return refuse("invalid target digit");
    const t = this._now();
    this.sentAt = this.sentAt.filter(x => t - x < 1000);
    if (this.sentAt.length >= MAX_ORDERS_PER_SEC) return refuse("rate limit: purchase not sent (API call budget for this second used)");
    this.sentAt.push(t);
    this.orderedTicks.add(key);
    const f = req.forecast;
    const order = {
      id: `o${++this.seq}-${t}`, contractId: null, state: "pricing", reason: null, forecastId: f ? f.id : null,
      forecast: f ? { id: f.id, madeAtSeq: f.madeAtSeq, targetSeq: f.targetSeq, horizon: f.horizon, madeAtEpoch: f.madeAtEpoch, predictedDigit: f.predictedDigit, probability: f.probability, decision: f.decision } : { id: null, targetSeq: null },
      intent: { key, cycleId: req.cycleId, tickSeq: req.tickSeq, tickEpoch: req.tickEpoch, tickDigit: req.tickDigit },
      symbol: req.symbol, digit: req.digit, k: req.k, contractType: req.contractType, stake, mode: "cycle",
      accountId: a.loginId, isVirtual: !!a.isVirtual, currency: a.currency,
      createdAt: t, updatedAt: t, result: null, pnl: null, entryEpoch: null, exitEpoch: null, purchaseTime: null,
    };
    this.orders.set(order.id, order);
    this._emit(order, "created");
    const reqId = h.nextReqId();
    const msg = { proposal: 1, req_id: reqId, amount: stake, basis: "stake", contract_type: req.contractType, currency: a.currency, duration: req.k, duration_unit: "t", underlying_symbol: req.symbol, barrier: String(req.digit) };
    h.await(reqId, (proposal, err) => this._onProposal(order, proposal, err));
    try { h.send(msg); } catch (e) { this._finish(order, "rejected", "send failed: " + (e && e.message)); return { ok: false, reason: order.reason, order }; }
    // Only the pricing stage is timed out (no buy was sent). A later proposal reply is ignored by _onProposal.
    const timer = setTimeout(() => { if (order.state === "pricing") this._finish(order, "rejected", "proposal timed out (connection slow or lost); purchase not sent"); }, PROPOSAL_TIMEOUT_MS);
    if (timer && timer.unref) timer.unref();
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
    if (this.stopped) return this._finish(order, "rejected", "stopped before purchase");
    const lag = h.currentSeq(order.symbol) - (order.intent ? order.intent.tickSeq : order.forecast.madeAtSeq);
    if (lag > (order.intent ? MAX_TICK_ORDER_LAG : MAX_ENTRY_DELAY_TICKS)) return this._finish(order, "rejected", order.intent ? `late: ${lag} ticks passed since the intention, purchase not sent` : "stale before purchase: a newer tick arrived, entry would not follow the forecast");
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
    order.settledAt = this._now();
    this._set(order, "settled", null);
    this._emit(order, "settled");
    return { handled: true, settled: true, order };
  }

  // Socket dropped. Nothing has been confirmed for in-flight requests.
  onDisconnect() {
    for (const o of this.orders.values()) {
      if (o.state === "pricing") this._finish(o, "rejected", "connection lost before purchase");
      else if (o.state === "buying") { this._set(o, "unknown", "connection lost while buying; check the account"); this._emit(o, "unknown"); }
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
      else if (o.state === "buying") { this._set(o, "unknown", "no buy response (timeout)"); this._emit(o, "unknown"); }
    }
  }

  // ---- persistence (no credentials: only order/forecast ids and order records)
  serialize() {
    const live = [...this.orders.values()].filter(o => LIVE.has(o.state)).map(o => ({ ...o }));
    const recent = [...this.orders.values()].filter(o => !LIVE.has(o.state)).slice(-100).map(o => ({ ...o }));
    return {
      v: 1, orderedForecasts: [...this.orderedForecasts].slice(-1000), orderedTicks: [...this.orderedTicks].slice(-3000), settled: [...this.settled].slice(-1000),
      orders: [...live, ...recent], seq: this.seq, legacy: this.legacy,
    };
  }
  restore(s) {
    if (!s || s.v !== 1) return;
    this.orderedForecasts = new Set(s.orderedForecasts || []); this.settled = new Set(s.settled || []);
    this.orderedTicks = new Set(s.orderedTicks || []);
    this.seq = s.seq || 0;
    // Records written by earlier versions are kept as stored (never deleted), but nothing reads them.
    this.legacy = s.legacy || (s.alignment ? { alignment: s.alignment } : null);
    for (const o of s.orders || []) {
      const order = { ...o };
      // In-flight requests cannot survive a reload: unconfirmed purchases are held as unknown.
      if (order.state === "pricing") order.state = "rejected", order.reason = "page reloaded before purchase";
      if (order.state === "buying") { order.state = "unknown"; order.reason = "page reloaded while buying; confirm on account"; }
      this.orders.set(order.id, order);
      if (order.contractId) this.byContract.set(String(order.contractId), order);
    }
  }
}
