import test from "node:test";
import assert from "node:assert/strict";
import { ResearchExecution } from "../../src/super-mathes/execution.js";

function harness({ isVirtual = true } = {}) {
  const saved = new Map(), sent = [], predictions = [];
  let contractId = 0, currentResult = null, owns = true;
  const account = { id: isVirtual ? "VRTC1" : "CR1", isVirtual, connected: true, authorized: true, balance: 10000, currency: "USD" };
  const feed = { source: "source", segment: 1, continuous: true };
  const store = {
    async load(id) { return saved.has(id) ? structuredClone(saved.get(id)) : null; },
    async save(state) { saved.set(state.accountId, structuredClone(state)); },
  };
  const host = {
    ownsExecution: () => owns, account: () => account, feed: () => feed,
    async verifyAuthorization() {},
    async proposal(input) { sent.push({ proposal: input }); return { id: "proposal", askPrice: input.stake }; },
    async buy(id, stake) { sent.push({ buy: id, stake }); return { contractId: String(++contractId), buyPrice: stake }; },
    async contract(id) { return currentResult && { ...currentResult, contractId: id }; },
  };
  const research = { async getPrediction(id) { return predictions.find(row => row.id === id); },
    async createModelPrediction(_window, model) {
    assert.equal(model, "combined");
    const digit = predictions.length ? 6 : 3;
    const result = { id: `p${predictions.length}`, source: "source", prediction: { selectedDigit: digit, model: "combined-frequency-markov", evidence: { present: true } } };
    predictions.push(result);
    return result;
  } };
  const config = { baseStake: 100, maximumStake: 1000, maximumExposure: 3000, cycleLoss: 2000, sessionLoss: 5000,
    cycleTarget: 1000, sessionTarget: 2000, dailyTarget: 3000, maxAttempts: 0, martingale: true,
    multiplierNumerator: 2, multiplierDenominator: 1, timeZone: "America/New_York", windowSize: 100, frequencyWeight: 0.5, durationTicks: 1 };
  const bot = new ResearchExecution({ host, store, research, now: () => Date.parse("2026-03-08T06:00:00Z") });
  return { bot, host, store, research, config, account, feed, sent, predictions, saved,
    result: value => { currentResult = value; }, loseLock: () => { owns = false; } };
}

test("confirmed losses preserve the selected digit, while a win advances the cycle", async () => {
  const h = harness();
  await h.bot.start(h.config);
  await h.bot.onTick();
  await h.bot.onTick();
  assert.equal(h.sent.filter(x => x.buy).length, 1);
  h.result({ status: "lost", profit: -100, payout: 0, settledAt: Date.parse("2026-03-08T06:00:00Z") });
  assert.equal(await h.bot.reconcile(), true);
  assert.equal(await h.bot.reconcile(), false);
  await h.bot.onTick();
  assert.deepEqual(h.sent.filter(x => x.proposal).map(x => [x.proposal.digit, x.proposal.stake]), [[3, 100], [3, 200]]);
  h.result({ status: "won", profit: 300, payout: 500, settledAt: Date.parse("2026-03-08T06:00:01Z") });
  await h.bot.reconcile();
  assert.equal(h.bot.state.session.pnl, 200);
  await h.bot.onTick();
  assert.equal(h.sent.filter(x => x.proposal).at(-1).proposal.digit, 6);
  assert.equal(h.predictions.length, 2);
});

test("account types are separated and a changed account cannot buy after proposal", async () => {
  for (const isVirtual of [true, false]) {
    const h = harness({ isVirtual });
    h.host.proposal = async input => {
      h.account.id = isVirtual ? "CR2" : "VRTC2";
      return { id: "p", askPrice: input.stake };
    };
    await h.bot.start(h.config);
    await assert.rejects(h.bot.onTick(), /Account/);
    assert.equal(h.sent.filter(x => x.buy).length, 0);
  }
});

test("unconfirmed purchases stop without retry and remain visible after restart", async () => {
  const h = harness();
  let attempts = 0;
  h.host.buy = async () => { attempts++; throw new Error("disconnected"); };
  await h.bot.start(h.config);
  await assert.rejects(h.bot.onTick(), /unknown/);
  assert.equal(h.bot.running, false);
  assert.equal(h.bot.state.order, null);
  assert.equal(h.bot.state.history[0].phase, "unknown");
  assert.equal(h.bot.state.session.uncertainExposure, 100);
  await h.bot.onTick();
  assert.equal(attempts, 1);
  const restored = new ResearchExecution({ host: h.host, store: h.store, research: h.research,
    now: () => Date.parse("2026-03-08T06:00:00Z") });
  await restored.restore(h.account.id);
  assert.equal(restored.state.history[0].phase, "unknown");
  assert.equal(restored.state.session.uncertainExposure, 100);
  await restored.start(h.config);
  assert.equal(attempts, 1);
  assert.equal(restored.state.session.uncertainExposure, 100);
});

test("a purchase interrupted during buy is archived once on restore", async () => {
  const h = harness();
  let buying;
  const save = h.store.save;
  h.store.save = async state => {
    if (state.order?.phase === "buying") buying = structuredClone(state);
    await save(state);
  };
  h.host.buy = async () => { throw new Error("connection lost"); };
  await h.bot.start(h.config);
  await assert.rejects(h.bot.onTick(), /unknown/);
  await h.store.save(buying);
  const restored = new ResearchExecution({ host: h.host, store: h.store, research: h.research });
  await restored.restore(h.account.id);
  assert.equal(restored.state.order, null);
  assert.equal(restored.state.history.filter(row => row.phase === "unknown").length, 1);
  assert.equal(restored.state.session.uncertainExposure, 100);
  await restored.restore(h.account.id);
  assert.equal(restored.state.history.filter(row => row.phase === "unknown").length, 1);
  assert.equal(restored.state.session.uncertainExposure, 100);
});

test("unconfirmed exposure counts against the configured session stop loss", async () => {
  const h = harness();
  h.config.sessionLoss = 150;
  h.host.buy = async () => { throw new Error("connection lost"); };
  await h.bot.start(h.config);
  await assert.rejects(h.bot.onTick(), /unknown/);
  await assert.rejects(h.bot.start(h.config), /session stop loss/);
  assert.equal(h.bot.state.session.pnl, 0);
  assert.equal(h.bot.state.session.uncertainExposure, 100);
});

test("a known open contract is reconciled once after restart", async () => {
  const h = harness();
  await h.bot.start(h.config);
  await h.bot.onTick();
  const restored = new ResearchExecution({ host: h.host, store: h.store, research: h.research });
  await restored.restore(h.account.id);
  assert.equal(restored.state.order.phase, "open");
  await assert.rejects(restored.start(h.config), /reconciliation/);
  h.result({ status: "lost", profit: -100, payout: 0, settledAt: Date.parse("2026-03-08T06:00:00Z") });
  assert.equal(await restored.reconcile(), true);
  assert.equal(await restored.reconcile(), false);
  assert.equal(restored.state.session.pnl, -100);
  assert.equal(restored.state.cycle.digit, 3);
  assert.equal(h.sent.filter(x => x.buy).length, 1);
});

test("a confirmed buy transaction ID is stored with its order", async () => {
  const h = harness();
  h.host.buy = async (_id, stake) => ({ contractId: "123", transactionId: "456", buyPrice: stake });
  await h.bot.start(h.config);
  await h.bot.onTick();
  assert.equal((await h.store.load(h.account.id)).order.transactionId, "456");
});

test("disconnect, lost ownership, rejection, and stop prevent purchases", async () => {
  const h = harness();
  h.host.proposal = async input => { h.feed.continuous = false; return { id: "p", askPrice: input.stake }; };
  await h.bot.start(h.config);
  await assert.rejects(h.bot.onTick(), /continuity/);
  assert.equal(h.sent.filter(x => x.buy).length, 0);

  const l = harness();
  l.host.proposal = async input => { l.loseLock(); return { id: "p", askPrice: input.stake }; };
  await l.bot.start(l.config);
  await assert.rejects(l.bot.onTick(), /ownership/);
  assert.equal(l.sent.filter(x => x.buy).length, 0);
});

test("a failing final risk check cancels the unsent order", async () => {
  const h = harness();
  const save = h.store.save;
  h.store.save = async state => {
    await save(state);
    if (state.order?.phase === "buying") h.account.balance = null;
  };
  await h.bot.start(h.config);
  await assert.rejects(h.bot.onTick(), /account balance/);
  assert.equal(h.sent.filter(x => x.buy).length, 0);
  assert.equal((await h.store.load(h.account.id)).order.phase, "cancelled");
  assert.equal(h.bot.state.cycle.unresolved, false);
});

test("settlement requires actual profit, payout, timestamp and contract identity", async () => {
  const h = harness();
  await h.bot.start(h.config);
  await h.bot.onTick();
  h.result({ status: "won", profit: 100, payout: 999, settledAt: 1 });
  await assert.rejects(h.bot.reconcile(), /incomplete/);
  assert.equal(h.bot.state.order.phase, "open");
  assert.equal(h.bot.state.session.pnl, 0);
});

test("cycle take profit stops instead of opening a new cycle", async () => {
  const h = harness();
  h.config.cycleTarget = 100;
  await h.bot.start(h.config);
  await h.bot.onTick();
  h.result({ status: "won", profit: 100, payout: 200, settledAt: Date.parse("2026-03-08T06:00:00Z") });
  await h.bot.reconcile();
  assert.equal(h.bot.running, false);
  await h.bot.onTick();
  assert.equal(h.predictions.length, 1);
});

test("stopping while startup or a proposal is pending cannot arm or buy", async () => {
  const h = harness();
  let release;
  const load = h.store.load;
  h.store.load = id => new Promise(resolve => { release = () => load(id).then(resolve); });
  const starting = h.bot.start(h.config);
  await h.bot.stop("Stopped during startup");
  release();
  await assert.rejects(starting, /cancelled/);
  assert.equal(h.bot.running, false);

  const p = harness();
  let resolveProposal;
  p.host.proposal = () => new Promise(resolve => { resolveProposal = resolve; });
  await p.bot.start(p.config);
  const pending = p.bot.onTick();
  while (!resolveProposal) await new Promise(resolve => setTimeout(resolve, 0));
  await p.bot.stop();
  resolveProposal({ id: "p", askPrice: 100 });
  await pending;
  assert.equal(p.sent.filter(x => x.buy).length, 0);
});
