import test from "node:test";
import assert from "node:assert/strict";
import { ResearchExecution } from "../../src/super-mathes/execution.js";

function harness({ isVirtual = true } = {}) {
  const saved = new Map(), sent = [], predictions = [];
  let contractId = 0, currentResult = null, owns = true, sequence = 1;
  const account = { id: isVirtual ? "VRTC1" : "CR1", isVirtual, connected: true, authorized: true, balance: 10000, currency: "USD" };
  const feed = { source: "source", segment: 1, continuous: true, sequence, epoch: 1000 };
  const store = {
    async load(id) { return saved.has(id) ? structuredClone(saved.get(id)) : null; },
    async save(state) { saved.set(state.accountId, structuredClone(state)); },
  };
  const host = {
    ownsExecution: () => owns, account: () => account, feed: () => feed,
    async verifyAuthorization() {},
    async proposal(input) { sent.push({ proposal: input }); return { id: `proposal-${sent.length}`, askPrice: input.stake }; },
    async buy(id, stake) { sent.push({ buy: id, stake }); return { contractId: String(++contractId), buyPrice: stake }; },
    async contract(id) { return currentResult && { ...currentResult, contractId: id }; },
    async recover() { return { status: "not_found" }; },
  };
  const research = {
    async getPrediction(id) { return predictions.find(row => row.id === id); },
    async createModelPrediction(_window, model, _weight, expectedSequence) {
      assert.equal(model, "combined");
      const predictionSequence = expectedSequence;
      const digit = predictions.length ? 6 : 3;
      const result = { id: `p${predictions.length}`, source: "source", originSequence: predictionSequence,
        prediction: { timestamp: predictionSequence * 1000, selectedDigit: digit,
          model: "combined-frequency-markov", evidence: { present: true } } };
      predictions.push(result);
      return result;
    },
  };
  const config = { baseStake: 100, maximumStake: 1000, maximumExposure: 3000, cycleLoss: 2000, sessionLoss: 5000,
    cycleTarget: 1000, sessionTarget: 2000, dailyTarget: 3000, maxAttempts: 0, martingale: true,
    multiplierNumerator: 2, multiplierDenominator: 1, timeZone: "America/New_York", windowSize: 100, frequencyWeight: 0.5, durationTicks: 1 };
  const bot = new ResearchExecution({ host, store, research, now: () => Date.parse("2026-03-08T06:00:00Z") });
  function observation() {
    sequence++;
    feed.sequence = sequence;
    feed.epoch = sequence * 1000;
    return { source: feed.source, segment: feed.segment, sequence, epoch: feed.epoch, digit: 1 };
  }
  async function tick() { return bot.onTick(observation()); }
  return { bot, host, store, research, config, account, feed, sent, predictions, saved, tick, observation,
    result: value => { currentResult = value; }, loseLock: () => { owns = false; } };
}

test("accepted ticks burst two frozen-digit contracts, then roll over only after a confirmed win", async () => {
  const h = harness();
  await h.bot.start(h.config);
  await h.tick();
  await h.tick();
  const firstCycle = h.bot.state.cycle.id;
  assert.deepEqual(h.sent.filter(x => x.proposal).map(x => [x.proposal.digit, x.proposal.stake]), [[3, 100], [3, 200]]);
  assert.equal(h.bot.state.orders.length, 2);
  await h.tick();
  assert.equal(h.sent.filter(x => x.proposal).length, 2);
  assert.match(h.bot.state.reason, /Burst limit/);

  h.result({ status: "lost", profit: -100, payout: 0, settledAt: Date.parse("2026-03-08T06:00:00Z") });
  assert.equal(await h.bot.reconcile(h.bot.state.orders[0].id), true);
  assert.equal(h.bot.state.cycle.losses, 1);
  await h.tick();
  assert.deepEqual(h.sent.filter(x => x.proposal).map(x => [x.proposal.digit, x.proposal.stake]),
    [[3, 100], [3, 200], [3, 400]]);

  h.result({ status: "won", profit: 300, payout: 500, settledAt: Date.parse("2026-03-08T06:00:01Z") });
  const oldCycleOrder = h.bot.state.orders.find(order => order.cycleId === firstCycle);
  assert.equal(await h.bot.reconcile(oldCycleOrder.id), true);
  assert.equal(h.bot.state.cycle, null);
  await h.tick();
  assert.equal(h.bot.state.cycle.digit, 6);
  assert.notEqual(h.bot.state.cycle.id, firstCycle);

  h.result({ status: "lost", profit: -400, payout: 0, settledAt: Date.parse("2026-03-08T06:00:02Z") });
  const lateOrder = h.bot.state.orders.find(order => order.cycleId === firstCycle);
  await h.bot.reconcile(lateOrder.id);
  assert.equal(h.bot.state.cycle.digit, 6);
  assert.equal(h.bot.state.cycle.losses, 0);
  assert.equal(h.bot.state.session.pnl, -200);
});

test("sequence gaps stop trading before a purchase and duplicate observations are ignored", async () => {
  const h = harness();
  await h.bot.start(h.config);
  const skipped = h.observation();
  skipped.sequence++;
  h.feed.sequence = skipped.sequence;
  await assert.rejects(h.bot.onTick(skipped), /skipped or reordered/);
  assert.equal(h.bot.running, false);
  assert.equal(h.sent.filter(x => x.buy).length, 0);
});

test("uncertain buys remain durable until verified recovery and never trigger a blind retry", async () => {
  const h = harness();
  let attempts = 0;
  h.host.buy = async () => { attempts++; throw new Error("disconnected"); };
  await h.bot.start(h.config);
  await assert.rejects(h.tick(), /unknown/);
  assert.equal(h.bot.running, false);
  assert.equal(h.bot.state.orders.length, 1);
  assert.equal(h.bot.state.orders[0].phase, "unknown");
  assert.equal(h.bot.state.orders[0].purchaseStartedAt, Date.parse("2026-03-08T06:00:00Z"));
  const restored = new ResearchExecution({ host: h.host, store: h.store, research: h.research,
    now: () => Date.parse("2026-03-08T06:00:00Z") });
  await restored.restore(h.account.id);
  assert.equal(restored.state.orders[0].phase, "unknown");
  await assert.rejects(restored.start(h.config), /Open or uncertain contracts/);
  h.host.recover = async () => ({ status: "found", transactionId: "456",
    contract: { contractId: "456", status: "open", transactionId: "456" } });
  h.host.buy = async (_id, stake) => ({ contractId: "789", buyPrice: stake });
  assert.equal(await restored.recoverUnknown(restored.state.orders[0].id), true);
  assert.equal(restored.state.orders[0].phase, "open");
  assert.equal(restored.state.cycle.attempts, 1);
  assert.equal(restored.state.cycle.staked, 100);
  assert.equal(await restored.resumeRecovered(), true);
  assert.equal(restored.running, true);
  h.result({ status: "lost", profit: -100, payout: 0, settledAt: Date.parse("2026-03-08T06:00:00Z") });
  await restored.reconcile(restored.state.orders[0].id);
  await restored.onTick(h.observation());
  assert.deepEqual(h.sent.filter(x => x.proposal).map(x => [x.proposal.digit, x.proposal.stake]), [[3, 100], [3, 200]]);
  assert.equal(attempts, 1);
});

test("legacy single-order state migrates and open contracts reconcile independently", async () => {
  const h = harness();
  await h.bot.start(h.config);
  await h.tick();
  const state = await h.store.load(h.account.id);
  state.order = state.orders[0];
  delete state.orders;
  h.saved.set(h.account.id, state);

  const restored = new ResearchExecution({ host: h.host, store: h.store, research: h.research,
    now: () => Date.parse("2026-03-08T06:00:00Z") });
  await restored.restore(h.account.id);
  assert.equal(restored.state.orders.length, 1);
  assert.equal(restored.state.order, undefined);
  await assert.rejects(restored.start(h.config), /Open or uncertain contracts/);
  h.result({ status: "lost", profit: -100, payout: 0, settledAt: Date.parse("2026-03-08T06:00:00Z") });
  assert.equal(await restored.reconcile(restored.state.orders[0].id), true);
  assert.equal(restored.state.session.pnl, -100);
  assert.equal(h.sent.filter(x => x.buy).length, 1);
});

test("a confirmed cycle take-profit closes and stops before the next prediction", async () => {
  const h = harness();
  h.config.cycleTarget = 100;
  await h.bot.start(h.config);
  await h.tick();
  h.result({ status: "won", profit: 300, payout: 400, settledAt: Date.parse("2026-03-08T06:00:00Z") });
  const order = h.bot.state.orders[0];
  await h.bot.reconcile(order.id);
  assert.equal(h.bot.running, false);
  await h.tick();
  assert.equal(h.predictions.length, 1);
  assert.match(h.bot.state.reason, /limit reached/);
});

test("feed segment changes fence an existing cycle and account changes fence a proposal", async () => {
  const h = harness();
  await h.bot.start(h.config);
  const observation = h.observation();
  h.feed.segment = 2;
  await assert.rejects(h.bot.onTick(observation), /continuity unavailable/);
  assert.equal(h.sent.filter(x => x.buy).length, 0);

  const other = harness({ isVirtual: false });
  other.host.proposal = async input => {
    other.account.id = "CR2";
    return { id: "proposal", askPrice: input.stake };
  };
  await other.bot.start(other.config);
  await assert.rejects(other.tick(), /Account/);
  assert.equal(other.sent.filter(x => x.buy).length, 0);
});
