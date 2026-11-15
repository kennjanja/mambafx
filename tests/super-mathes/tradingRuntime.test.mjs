import test from "node:test";
import assert from "node:assert/strict";
import { createTradingRuntime } from "../../src/super-mathes/tradingRuntime.js";
import { tradingConfig } from "../../src/super-mathes/tradingDashboard.js";

function harness() {
  const rows = new Map(), sent = [], predictions = [];
  const shared = { owner: null, settlement: null, holdBuy: false, holdProposal: false, held: null };
  const state = { connected: true, loggedIn: true, accountId: "VRTC1", currency: "USD",
    balance: 100, isVirtual: true, connectionGeneration: 1 };
  let token = "session", authorized = true, accountType, reqId = 0, contract = 0;
  const source = JSON.stringify(["deriv-public", "public", "R_100", 2]);
  const socket = new EventTarget();
  socket.readyState = 1;
  socket.send = json => {
    const request = JSON.parse(json);
    sent.push(request);
    const reply = (type, value) => queueMicrotask(() => socket.dispatchEvent(new MessageEvent("message", {
      data: JSON.stringify({ req_id: request.req_id, msg_type: type, [type]: value }),
    })));
    if (request.balance) reply("balance", { loginid: state.accountId, currency: state.currency, balance: state.balance });
    else if (request.active_symbols) reply("active_symbols", [{ underlying_symbol: "R_100", exchange_is_open: 1, is_trading_suspended: 0 }]);
    else if (request.proposal) {
      if (shared.holdProposal) shared.held = () => reply("proposal", { id: "quote", ask_price: request.amount });
      else reply("proposal", { id: "quote", ask_price: request.amount });
    } else if (request.buy) {
      contract++;
      if (!shared.holdBuy) reply("buy", { contract_id: contract, transaction_id: contract + 100, buy_price: request.price });
    } else if (request.time) reply("time", 1700000000);
    else if (request.proposal_open_contract) {
      const order = rows.get(state.accountId).order;
      const result = { contract_id: Number(order.contractId), contract_type: "DIGITMATCH", currency: "USD",
        underlying_symbol: "R_100", barrier: String(order.digit), buy_price: order.stake / 1e8,
        transaction_ids: { buy: Number(order.transactionId) } };
      if (shared.settlement) Object.assign(result, shared.settlement);
      else Object.assign(result, { is_sold: 0, status: "open" });
      reply("proposal_open_contract", result);
    }
  };
  const connection = { socket: () => socket, nextRequestId: () => ++reqId, account: () => state, timeoutMs: 30 };
  const research = { status: { state: "ready", role: "collector", activeSource: source,
    pendingUpdates: 0, segment: 1, lastObservationAt: 1700000000000 },
    async checkStale() {},
    async getPrediction(id) { return predictions.find(row => row.id === id); },
    async createModelPrediction(_window, model) {
      assert.equal(model, "combined");
      const row = { id: `prediction-${predictions.length}`, source,
        prediction: { selectedDigit: predictions.length ? 6 : 3, model: "combined-frequency-markov", evidence: { present: true } } };
      predictions.push(row);
      return row;
    },
  };
  function ownership() {
    const key = Symbol("owner");
    return {
      owns: () => shared.owner === key,
      async acquire() { if (shared.owner) throw new Error("Another tab owns Super Mathes execution"); shared.owner = key; },
      async release(drain) { await drain(); shared.owner = null; },
    };
  }
  const openStore = async () => ({
    async list() { return [...rows.values()].map(row => structuredClone(row)); },
    async load(id) { return rows.has(id) ? structuredClone(rows.get(id)) : undefined; },
    async save(row) { rows.set(row.accountId, structuredClone(row)); },
    close() {},
  });
  const newRuntime = () => createTradingRuntime({ connection, research, ownership: ownership(), openStore,
    fetchSession: async () => ({ ok: true, json: async () => ({ logged_in: true, trade_authorized: authorized }) }),
    fetchAccounts: async () => ({ ok: true, json: async () => ({ data: [
      { account_id: state.accountId, account_type: accountType ?? (state.isVirtual ? "demo" : "real") },
    ] }) }),
    sessionKey: () => token, wallTime: () => 1700000000000, monotonic: () => 1000 });
  const config = tradingConfig({ baseStake: "1", maximumStake: "8", maximumExposure: "20", stopLoss: "20",
    takeProfit: "50", multiplier: "2", maxSteps: "3", martingale: true, durationTicks: "1",
    windowSize: "100", frequencyWeight: "0.5", timeZone: "UTC" });
  return { rows, sent, predictions, shared, state, research, config, newRuntime,
    setAuthorized(value) { authorized = value; }, setToken(value) { token = value; },
    setAccountType(value) { accountType = value; } };
}

test("runtime connects prediction, authorized proposal, purchase, loss and win lifecycle", async () => {
  const h = harness(), runtime = h.newRuntime();
  await runtime.start(h.config);
  await runtime.pulse();
  assert.equal(h.sent.filter(r => r.buy).length, 1);
  assert.equal(runtime.snapshot().state.order.contractId, "1");
  h.shared.settlement = { is_sold: 1, status: "lost", profit: -1, sell_price: 0, date_settlement: 1700000000 };
  await runtime.pulse();
  assert.deepEqual(h.sent.filter(r => r.proposal).map(r => [r.barrier, r.amount]), [["3", 1], ["3", 2]]);
  h.shared.settlement = { is_sold: 1, status: "won", profit: 10, sell_price: 12, date_settlement: 1700000001 };
  await runtime.pulse();
  assert.deepEqual(h.sent.filter(r => r.proposal).map(r => r.barrier), ["3", "3", "6"]);
  assert.equal(runtime.snapshot().state.session.pnl, 900000000);
  await runtime.stop();
  await runtime.dispose();
});

test("ownership excludes another tab and recovery reconciles an open contract without another buy", async () => {
  const h = harness(), first = h.newRuntime(), second = h.newRuntime();
  await first.start(h.config);
  await first.pulse();
  await assert.rejects(second.start(h.config), /Another tab/);
  await first.dispose();
  h.shared.settlement = { is_sold: 1, status: "lost", profit: -1, sell_price: 0, date_settlement: 1700000000 };
  await second.pulse();
  assert.equal(second.snapshot().state.order.phase, "settled");
  assert.equal(second.snapshot().state.cycle.digit, 3);
  assert.equal(second.snapshot().running, false);
  assert.equal(h.sent.filter(r => r.buy).length, 1);
  await second.dispose();
});

test("a follower cannot take execution ownership away from the collector", async () => {
  const h = harness(), follower = h.newRuntime();
  h.research.status.role = "follower";
  await assert.rejects(follower.start(h.config), /active Super Mathes collector/);
  assert.equal(h.shared.owner, null);
  await assert.rejects(follower.stop(), /active collector/);
  await follower.dispose();
});

test("an uncertain purchase blocks recovery and is never retried", async () => {
  const h = harness(), first = h.newRuntime();
  h.shared.holdBuy = true;
  await first.start(h.config);
  await assert.rejects(first.pulse(), /unknown/);
  await first.dispose();
  const restored = h.newRuntime();
  await restored.pulse();
  assert.equal(restored.snapshot().state.order.phase, "unknown");
  await assert.rejects(restored.start(h.config), /reconciliation/);
  assert.equal(h.sent.filter(r => r.buy).length, 1);
  await restored.dispose();
});

test("stop during an outstanding quote fences the purchase", async () => {
  const h = harness(), runtime = h.newRuntime();
  h.shared.holdProposal = true;
  await runtime.start(h.config);
  const pending = runtime.pulse();
  while (!h.shared.held) await new Promise(resolve => setTimeout(resolve, 0));
  const stopping = runtime.stop();
  h.shared.held();
  await pending;
  await stopping;
  assert.equal(h.sent.filter(r => r.buy).length, 0);
  await runtime.dispose();
});

test("session changes during a quote fence the purchase", async () => {
  const h = harness(), runtime = h.newRuntime();
  h.shared.holdProposal = true;
  await runtime.start(h.config);
  const pending = runtime.pulse();
  while (!h.shared.held) await new Promise(resolve => setTimeout(resolve, 0));
  h.setToken("different-session");
  h.shared.held();
  await assert.rejects(pending, /Session changed/);
  assert.equal(h.sent.filter(r => r.buy).length, 0);
  await runtime.dispose();
});

test("revoked trade scope during a quote fences the purchase", async () => {
  const h = harness(), runtime = h.newRuntime();
  h.shared.holdProposal = true;
  await runtime.start(h.config);
  const pending = runtime.pulse();
  while (!h.shared.held) await new Promise(resolve => setTimeout(resolve, 0));
  h.setAuthorized(false);
  h.shared.held();
  await assert.rejects(pending, /authorization/);
  assert.equal(h.sent.filter(r => r.buy).length, 0);
  await runtime.dispose();
});

test("a feed discontinuity fences the old prediction and permits explicit cycle closure", async () => {
  const h = harness(), runtime = h.newRuntime();
  h.shared.holdProposal = true;
  await runtime.start(h.config);
  const pending = runtime.pulse();
  while (!h.shared.held) await new Promise(resolve => setTimeout(resolve, 0));
  h.research.status.segment = 2;
  h.shared.held();
  await assert.rejects(pending, /segment changed/);
  assert.equal(h.sent.filter(r => r.buy).length, 0);
  await runtime.closeCycle();
  assert.equal(runtime.snapshot().state.cycle, null);
  assert.equal(runtime.snapshot().state.history.at(-1).termination, "closed by user");
  await runtime.dispose();
});

test("a missing or altered original prediction prevents the next attempt", async () => {
  const h = harness(), runtime = h.newRuntime();
  await runtime.start(h.config);
  await runtime.pulse();
  h.predictions[0].prediction.selectedDigit = 9;
  h.shared.settlement = { is_sold: 1, status: "lost", profit: -1, sell_price: 0, date_settlement: 1700000000 };
  await assert.rejects(runtime.pulse(), /prediction is unavailable or changed/);
  assert.equal(h.sent.filter(r => r.buy).length, 1);
  await runtime.dispose();
});

test("an open order cannot be discarded by closing its cycle", async () => {
  const h = harness(), runtime = h.newRuntime();
  await runtime.start(h.config);
  await runtime.pulse();
  await runtime.stop();
  await assert.rejects(runtime.closeCycle(), /unresolved/);
  assert.equal(runtime.snapshot().state.order.phase, "open");
  await runtime.dispose();
});

test("a changed account cannot inherit the user's start confirmation", async () => {
  const h = harness(), runtime = h.newRuntime();
  const expected = { ...h.state };
  h.state.accountId = "CR1";
  h.state.isVirtual = false;
  h.state.connectionGeneration++;
  await assert.rejects(runtime.start(h.config, expected), /Account selection changed/);
  assert.equal(h.sent.filter(r => r.buy).length, 0);
  await runtime.dispose();
});

test("unknown or conflicting account metadata cannot authorize trading", async () => {
  const h = harness(), runtime = h.newRuntime();
  for (const type of ["unknown", "real"]) {
    h.setAccountType(type);
    await assert.rejects(runtime.start(h.config), /authorization/);
  }
  assert.equal(h.sent.filter(r => r.buy).length, 0);
  await runtime.dispose();
});

test("legacy sessions without proven trade scope cannot trade", async () => {
  const h = harness(), runtime = h.newRuntime();
  h.setAuthorized(undefined);
  await assert.rejects(runtime.start(h.config), /Trade authorization/);
  assert.equal(h.sent.filter(r => r.buy).length, 0);
  await runtime.dispose();
});

test("an immediate stop cancels queued startup before any purchase", async () => {
  const h = harness(), runtime = h.newRuntime();
  const starting = runtime.start(h.config);
  const stopping = runtime.stop();
  await assert.rejects(starting, /cancelled/);
  await stopping;
  await runtime.pulse();
  assert.equal(h.sent.filter(r => r.buy).length, 0);
  await runtime.dispose();
});

test("scope loss, account switching and interrupted feeds prevent purchases", async () => {
  const h = harness(), runtime = h.newRuntime();
  h.setAuthorized(false);
  await assert.rejects(runtime.start(h.config), /authorization/);
  h.setAuthorized(true);
  await runtime.start(h.config);
  h.research.status.activeSource = null;
  await assert.rejects(runtime.pulse(), /continuity/);
  assert.equal(h.sent.filter(r => r.buy).length, 0);
  h.state.accountId = "CR1";
  h.state.isVirtual = false;
  h.state.connectionGeneration++;
  await runtime.pulse();
  assert.equal(runtime.snapshot().running, false);
  await runtime.dispose();
});

test("older unscaled histories and unresolved orders on other accounts block execution", async () => {
  const h = harness(), runtime = h.newRuntime();
  h.rows.set("CR1", { accountId: "CR1", order: { phase: "open" }, accountingScale: 8 });
  await assert.rejects(runtime.start(h.config), /unresolved order/);
  h.rows.set("CR1", { accountId: "CR1" });
  await assert.rejects(runtime.start(h.config), /incompatible accounting scale/);
  assert.equal(h.sent.filter(r => r.buy).length, 0);
  await runtime.dispose();
});
