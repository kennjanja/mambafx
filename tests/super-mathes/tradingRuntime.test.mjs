import test from "node:test";
import assert from "node:assert/strict";
import { createTradingRuntime } from "../../src/super-mathes/tradingRuntime.js";
import { tradingConfig } from "../../src/super-mathes/tradingDashboard.js";

function harness() {
  const rows = new Map(), sent = [], predictions = [], observers = new Set();
  const shared = { owner: null, settlement: null, holdBuy: false, holdProposal: false, held: null, purchase: null, recoveryVisible: false };
  const state = { connected: true, loggedIn: true, accountId: "VRTC1", currency: "USD",
    balance: 100, isVirtual: true, connectionGeneration: 1 };
  let token = "session", authorized = true, accountType, reqId = 0, contract = 0, sequence = 1, epoch = 1700000000, mono = 1000;
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
      if (shared.holdProposal) shared.held = () => reply("proposal", { id: `quote-${sent.length}`, ask_price: request.amount });
      else reply("proposal", { id: `quote-${sent.length}`, ask_price: request.amount });
    } else if (request.buy) {
      contract++;
      if (shared.holdBuy) shared.purchase = { contractId: String(contract), transactionId: String(contract + 100),
        purchaseTime: 1700000000, buyPrice: request.price };
      else reply("buy", { contract_id: contract, transaction_id: contract + 100, buy_price: request.price });
    } else if (request.time) reply("time", 1700000000 + Math.floor((mono - 1000) / 1000));
    else if (request.portfolio) reply("portfolio", { contracts: shared.recoveryVisible && shared.purchase ? [{
      contract_id: Number(shared.purchase.contractId), transaction_id: Number(shared.purchase.transactionId),
      contract_type: "DIGITMATCH", currency: state.currency, underlying_symbol: "R_100",
      buy_price: shared.purchase.buyPrice, purchase_time: shared.purchase.purchaseTime,
    }] : [] });
    else if (request.statement) reply("statement", { transactions: shared.recoveryVisible && shared.purchase ? [{
      action_type: "buy", contract_id: Number(shared.purchase.contractId), transaction_id: Number(shared.purchase.transactionId),
      transaction_time: shared.purchase.purchaseTime, amount: -shared.purchase.buyPrice,
    }] : [] });
    else if (request.proposal_open_contract) {
      const stateRow = rows.get(state.accountId);
      const order = stateRow?.orders?.find(item => item.contractId === String(request.contract_id)) ||
        (shared.purchase?.contractId === String(request.contract_id) ?
          stateRow?.orders?.find(item => item.phase === "unknown") : null);
      if (!order) throw new Error("Missing durable order for reconciliation");
      const result = { contract_id: Number(request.contract_id), contract_type: "DIGITMATCH", currency: "USD",
        underlying_symbol: "R_100", barrier: String(order.digit), buy_price: order.stake / 1e8,
        transaction_ids: { buy: Number(shared.purchase?.transactionId ?? order.transactionId) } };
      if (shared.settlement) Object.assign(result, typeof shared.settlement === "function" ? shared.settlement(order) : shared.settlement);
      else Object.assign(result, { is_sold: 0, status: "open" });
      reply("proposal_open_contract", result);
    }
  };
  const connection = { socket: () => socket, nextRequestId: () => ++reqId, account: () => state, timeoutMs: 30 };
  const research = { status: { state: "ready", role: "collector", activeSource: source,
    pendingUpdates: 0, segment: 1, lastSequence: sequence, lastEpoch: epoch, lastObservationAt: 1700000000000 },
    async checkStale() {},
    subscribeObservations(listener) { observers.add(listener); return () => observers.delete(listener); },
    async getPrediction(id) { return predictions.find(row => row.id === id); },
    async createModelPrediction(_window, model, _weight, expectedSequence) {
      assert.equal(model, "combined");
      const predictionEpoch = research.status.lastEpoch;
      const row = { id: `prediction-${predictions.length}`, source, originSequence: expectedSequence,
        prediction: { timestamp: predictionEpoch, selectedDigit: predictions.length ? 6 : 3,
          model: "combined-frequency-markov", evidence: { present: true } } };
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
    sessionKey: () => token, wallTime: () => 1700000000000 + (mono - 1000), monotonic: () => mono });
  const config = tradingConfig({ baseStake: "1", maximumStake: "8", maximumExposure: "20", stopLoss: "20",
    takeProfit: "50", multiplier: "2", maxSteps: "3", martingale: true, durationTicks: "1",
    windowSize: "100", frequencyWeight: "0.5", timeZone: "UTC" });
  async function emitTick(runtime, { sequenceGap = 0, pending = 0 } = {}) {
    sequence += 1 + sequenceGap;
    epoch += 1 + sequenceGap;
    Object.assign(research.status, { lastSequence: sequence, lastEpoch: epoch, lastObservationAt: 1700000000000, pendingUpdates: pending });
    const observation = { source, segment: research.status.segment, sequence, epoch, digit: 1 };
    await Promise.all([...observers].map(listener => listener(observation)));
    research.status.pendingUpdates = 0;
    return observation;
  }
  return { rows, sent, predictions, shared, state, research, config, newRuntime, emitTick,
    advanceTime(ms) { mono += ms; },
    setAuthorized(value) { authorized = value; }, setToken(value) { token = value; },
    setAccountType(value) { accountType = value; } };
}

test("runtime executes one authorized purchase per accepted tick, with a two-contract cap", async () => {
  const h = harness(), runtime = h.newRuntime();
  await runtime.start(h.config);
  await h.emitTick(runtime, { pending: 1 });
  assert.equal(h.sent.filter(r => r.buy).length, 1);
  assert.equal(runtime.snapshot().state.orders[0].contractId, "1");
  await h.emitTick(runtime);
  assert.equal(h.sent.filter(r => r.buy).length, 2);
  assert.deepEqual(h.sent.filter(r => r.proposal).map(r => [r.barrier, r.amount]), [["3", 1], ["3", 2]]);
  await h.emitTick(runtime);
  assert.equal(h.sent.filter(r => r.buy).length, 2);

  h.shared.settlement = order => ({ is_sold: 1, status: "lost", profit: -order.stake / 1e8,
    sell_price: 0, date_settlement: 1700000000 });
  await runtime.pulse();
  await h.emitTick(runtime);
  assert.equal(h.sent.filter(r => r.buy).length, 3);
  assert.deepEqual(h.sent.filter(r => r.proposal).map(r => [r.barrier, r.amount]), [["3", 1], ["3", 2], ["3", 4]]);
  await runtime.dispose();
});

test("settlement, refresh recovery, and independent order IDs do not duplicate purchases", async () => {
  const h = harness(), first = h.newRuntime();
  await first.start(h.config);
  await h.emitTick(first);
  await h.emitTick(first);
  const ids = first.snapshot().state.orders.map(order => order.contractId);
  await first.dispose();

  h.shared.settlement = order => ({ is_sold: 1, status: "lost", profit: -order.stake / 1e8,
    sell_price: 0, date_settlement: 1700000000 });
  const restored = h.newRuntime();
  await restored.pulse();
  assert.deepEqual(restored.snapshot().state.orders, []);
  assert.equal(restored.snapshot().state.session.pnl, -300000000);
  assert.equal(h.sent.filter(r => r.buy).length, 2);
  assert.deepEqual(ids, ["1", "2"]);
  await restored.dispose();
});

test("ownership excludes another tab and account identity changes cannot purchase", async () => {
  const h = harness(), first = h.newRuntime(), second = h.newRuntime();
  await first.start(h.config);
  await h.emitTick(first);
  await assert.rejects(second.start(h.config), /Another tab/);
  await first.dispose();
  h.state.accountId = "CR1";
  h.state.isVirtual = false;
  h.state.connectionGeneration++;
  await assert.rejects(second.start(h.config), /unresolved order/);
  assert.equal(h.sent.filter(r => r.buy).length, 1);
  await second.dispose();
});

test("uncertain purchase is retained, recovered from Deriv records, then resumes without a duplicate buy", async () => {
  const h = harness(), runtime = h.newRuntime();
  h.shared.holdBuy = true;
  await runtime.start(h.config);
  await h.emitTick(runtime);
  assert.equal(runtime.snapshot().running, false);
  assert.match(runtime.snapshot().error, /unknown/);
  assert.equal(runtime.snapshot().state.orders[0].phase, "unknown");
  await runtime.pulse();
  assert.equal(runtime.snapshot().state.orders[0].phase, "unknown");
  assert.match(runtime.snapshot().state.reason, /No matching purchase is visible/);
  assert.equal(h.sent.filter(r => r.buy).length, 1);
  h.shared.recoveryVisible = true;
  h.advanceTime(3001);
  await runtime.dispose();
  const restored = h.newRuntime();
  await restored.pulse();
  assert.equal(restored.snapshot().state.orders[0].phase, "open");
  assert.equal(restored.snapshot().running, true);
  assert.equal(h.sent.filter(r => r.buy).length, 1);
  assert.equal(h.sent.filter(r => r.proposal_open_contract).length, 1);
  await restored.dispose();
});

test("skipped accepted sequence stops execution before sending an order", async () => {
  const h = harness(), runtime = h.newRuntime();
  await runtime.start(h.config);
  await h.emitTick(runtime, { sequenceGap: 1 });
  assert.equal(runtime.snapshot().running, false);
  assert.equal(h.sent.filter(r => r.buy).length, 0);
  await runtime.dispose();
});

test("authorization and symbol proposal fences prevent purchases", async () => {
  const h = harness(), runtime = h.newRuntime();
  h.setAuthorized(false);
  await assert.rejects(runtime.start(h.config), /Trade authorization/);
  h.setAuthorized(true);
  await runtime.start(h.config);
  h.research.status.activeSource = null;
  await h.emitTick(runtime);
  assert.equal(runtime.snapshot().running, false);
  assert.equal(h.sent.filter(r => r.buy).length, 0);
  await runtime.dispose();
});
