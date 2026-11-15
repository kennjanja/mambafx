import test from "node:test";
import assert from "node:assert/strict";
import { Executor } from "../../src/ldpe/exec.js";
import { Ldpe } from "../../src/ldpe/engine.js";
import { PredictionDigitBot } from "../../src/ldpe/prediction-digit-bot.js";

function setup(overrides = {}) {
  let seq = 0, epoch = 1000, now = 100000, req = 0, contract = 0;
  const callbacks = new Map(), sent = [];
  const account = { authed: true, open: true, loginId: "VRTC1", isVirtual: true, currency: "USD" };
  const ex = new Executor({
    account: () => account, currentSeq: () => seq, now: () => now,
    nextReqId: () => ++req, await: (id, cb) => callbacks.set(id, cb), send: msg => sent.push(msg),
  });
  const bot = new PredictionDigitBot(ex);
  const config = { symbol: "S", stake: 0.5, multiplier: 2, targetProfit: 10, stopLoss: 10, duration: 1, ...overrides };
  const h = {
    ex, bot, sent, callbacks, config, account,
    arm: () => bot.arm(config),
    tick(digit, prediction = 7) {
      seq++; epoch++; now += 1000;
      const forecast = prediction == null ? null : { id: `f${seq}`, symbol: "S", horizon: 1, madeAtSeq: seq, predictedDigit: prediction, decision: "SKIP", reconstructed: false };
      return bot.onTick({ symbol: "S", seq, epoch, digit, forecast });
    },
    orders: () => [...ex.orders.values()],
    open(order) {
      const proposal = sent.find(m => m.proposal && m.amount === order.stake && callbacks.has(m.req_id));
      callbacks.get(proposal.req_id)({ id: `p${proposal.req_id}`, ask_price: order.stake });
      callbacks.delete(proposal.req_id);
      const buy = sent.filter(m => m.buy && callbacks.has(m.req_id)).at(-1);
      callbacks.get(buy.req_id)({ contract_id: ++contract, buy_price: order.stake, purchase_time: epoch });
      callbacks.delete(buy.req_id);
    },
    settle(order, pnl) { ex.onContractUpdate({ contract_id: order.contractId, status: pnl > 0 ? "won" : "lost", is_sold: 1, profit: pnl }); },
  };
  return h;
}

test("overlapping trades keep the forecast digit through observed target ticks and project pending losses", () => {
  const h = setup(); assert.equal(h.arm().ok, true);
  h.tick(4, 7); h.tick(7, 2); h.tick(3, 5);
  const orders = h.orders();
  assert.deepEqual(orders.map(o => o.digit), [7, 7, 7]);
  assert.deepEqual(orders.map(o => o.stake), [0.5, 1, 2]);
  assert.ok(h.sent.every(m => m.contract_type === "DIGITMATCH" && m.duration === 1));
  h.open(orders[0]); h.open(orders[1]); h.open(orders[2]);
  h.settle(orders[0], -0.5);
  h.tick(3, 4);
  assert.equal(h.orders()[3].stake, 4);
});

test("confirmed win cancels old proposals and next tick chooses a fresh forecast; late results affect P/L only", () => {
  const h = setup(); h.arm(); h.tick(1, 7); h.tick(2, 4); h.tick(3, 3);
  const [a, b, c] = h.orders();
  h.open(a); h.open(b);
  const pendingProposal = h.sent.find(m => m.proposal && m.amount === c.stake);
  h.settle(a, 2);
  assert.equal(c.state, "rejected");
  h.callbacks.get(pendingProposal.req_id)({ id: "late", ask_price: c.stake });
  assert.equal(h.sent.filter(m => m.buy).length, 2);
  h.tick(5, 4);
  assert.equal(h.orders()[3].digit, 4);
  assert.equal(h.orders()[3].stake, 0.5);
  h.settle(b, -1);
  h.tick(7, 9);
  assert.equal(h.orders()[4].digit, 4);
  assert.equal(h.orders()[4].stake, 1);
  assert.equal(h.bot.pnl, 1);
});

test("realized limits stop new orders and cancel pricing but still count open settlements", () => {
  const h = setup({ stopLoss: 0.5 }); h.arm(); h.tick(1); h.tick(2); h.tick(3);
  const [a, b, c] = h.orders();
  h.open(a); h.open(b); h.settle(a, -0.5);
  assert.equal(h.bot.armed, false);
  assert.match(h.bot.reason, /Stop loss/);
  assert.equal(c.state, "rejected");
  h.tick(4); assert.equal(h.orders().length, 3);
  assert.match(h.arm().reason, /still open/);
  h.settle(b, -1);
  assert.equal(h.bot.pnl, -1.5);
  assert.equal(h.arm().ok, true);
});

test("take profit stops and duplicate settlements do not count twice", () => {
  const h = setup({ targetProfit: 1 }); h.arm(); h.tick(1); const o = h.orders()[0]; h.open(o);
  h.settle(o, 1.5); h.settle(o, 1.5);
  assert.equal(h.bot.pnl, 1.5);
  assert.equal(h.bot.armed, false);
  assert.match(h.bot.reason, /Target profit/);
});

test("feed interruptions pause new purchases and resume the same cycle after orders settle", () => {
  const h = setup(); h.arm(); h.tick(1, 7); h.tick(2, 4);
  const [open, pricing] = h.orders();
  h.open(open);
  const pending = h.sent.find(m => m.proposal && m.amount === pricing.stake);
  h.bot.pauseFeed("OTHER");
  assert.equal(h.bot.feedPaused, false);
  h.bot.pauseFeed("S"); h.bot.pauseFeed("S");
  assert.equal(h.bot.armed, true);
  assert.equal(h.bot.feedPaused, true);
  assert.equal(pricing.state, "rejected");
  h.callbacks.get(pending.req_id)({ id: "late", ask_price: pricing.stake });
  assert.equal(h.sent.filter(m => m.buy).length, 1);
  h.tick(3, 5);
  assert.equal(h.orders().length, 2);
  h.settle(open, -0.5);
  h.tick(4, 6);
  assert.equal(h.bot.feedPaused, false);
  assert.equal(h.bot.pnl, -0.5);
  assert.equal(h.orders()[2].digit, 7);
  assert.equal(h.orders()[2].stake, 1);
});

test("a win or profit limit reached while feed is paused is honored before resuming", () => {
  const h = setup(); h.arm(); h.tick(1, 7);
  const order = h.orders()[0]; h.open(order); h.bot.pauseFeed("S");
  h.settle(order, 2); h.tick(2, 4);
  assert.equal(h.bot.pnl, 2);
  assert.equal(h.orders()[1].digit, 4);
  assert.equal(h.orders()[1].stake, 0.5);

  const limited = setup({ targetProfit: 1 }); limited.arm(); limited.tick(1);
  const winner = limited.orders()[0]; limited.open(winner); limited.bot.pauseFeed("S");
  limited.settle(winner, 1.5); limited.tick(2);
  assert.equal(limited.bot.armed, false);
  assert.match(limited.bot.reason, /Target profit/);
  assert.equal(limited.orders().length, 1);
});

test("unknown purchases and manual stops do not resume after a feed interruption", () => {
  const h = setup(); h.arm(); h.tick(1);
  const proposal = h.sent[0];
  h.callbacks.get(proposal.req_id)({ id: "p", ask_price: 0.5 });
  h.bot.pauseFeed("S");
  h.ex.onDisconnect();
  assert.equal(h.bot.armed, false);
  assert.match(h.bot.reason, /unknown/i);
  h.tick(2);
  assert.equal(h.orders().length, 1);

  const stopped = setup(); stopped.arm(); stopped.bot.pauseFeed("S");
  stopped.bot.stop("Manually stopped"); stopped.tick(1);
  assert.equal(stopped.orders().length, 0);
});

test("arming requires positive limits and refuses unresolved orders after reload", () => {
  const h = setup({ targetProfit: 0 });
  assert.equal(h.arm().ok, false);
  h.config.targetProfit = 10; h.arm(); h.tick(1); const order = h.orders()[0];
  h.open(order);
  const saved = h.ex.serialize();
  const restored = new Executor(h.ex.host); restored.restore(saved);
  const b = new PredictionDigitBot(restored);
  assert.match(b.arm(h.config).reason, /still open/);
});

test("refusal or unknown purchase stops safely; duplicate ticks do not place orders", () => {
  const h = setup(); h.arm(); h.tick(1);
  h.bot.onTick({ symbol: "S", seq: 1, epoch: 1001, digit: 1, forecast: null });
  assert.equal(h.orders().length, 1);
  const o = h.orders()[0], p = h.sent[0];
  h.callbacks.get(p.req_id)({ id: "p", ask_price: o.stake });
  h.ex.onDisconnect();
  assert.equal(o.state, "unknown"); assert.equal(h.bot.armed, false);
  assert.match(h.arm().reason, /unresolved/);
});

test("waits for a fresh live forecast and stops on market or account changes", () => {
  const h = setup(); h.arm(); h.tick(1, null);
  assert.equal(h.orders().length, 0);
  h.tick(2, 3); h.account.loginId = "VRTC2"; h.tick(3, 5);
  assert.equal(h.bot.armed, false); assert.match(h.bot.reason, /Account changed/);
  assert.equal(h.orders()[0].state, "rejected");
});

test("missing buy identity and missing final profit stay unresolved until reconciled", () => {
  const h = setup(); h.arm(); h.tick(1);
  const o = h.orders()[0], p = h.sent[0];
  h.callbacks.get(p.req_id)({ id: "p", ask_price: o.stake });
  const buy = h.sent.at(-1);
  h.callbacks.get(buy.req_id)({});
  assert.equal(o.state, "unknown");
  assert.equal(h.bot.armed, false);
  assert.match(h.arm().reason, /unresolved/);
  h.ex.resolveUnknown(o.id, "123");
  h.ex.onContractUpdate({ contract_id: "123", status: "lost", is_sold: 1 });
  assert.equal(o.state, "unknown");
  assert.match(h.arm().reason, /unresolved/);
  h.ex.onContractUpdate({ contract_id: "123", status: "lost", is_sold: 1, profit: -0.5 });
  assert.equal(o.state, "settled");
  assert.equal(h.bot.pnl, -0.5);
  assert.equal(h.arm().ok, true);
});

test("refuses an unsafe computed stake instead of continuing the progression", () => {
  const h = setup({ stake: 100000, multiplier: 2 }); h.arm();
  h.tick(1); h.tick(2);
  assert.equal(h.orders().length, 1);
  assert.equal(h.orders()[0].state, "rejected");
  assert.equal(h.bot.armed, false);
  assert.match(h.bot.reason, /safety maximum/);
});

test("page adapter arms with LDPE settings and sends the live forecast through the executor", async () => {
  const elements = Object.fromEntries(Object.entries({ pdtStake: "0.5", pdtMultiplier: "2", pdtTP: "5", pdtSL: "5", pdtArm: "", pdtStatus: "" })
    .map(([id, value]) => [id, { value, checked: false, disabled: false, textContent: "", addEventListener() {} }]));
  const engine = new Ldpe({ horizon: 1 });
  let req = 0;
  const sent = [];
  const executor = new Executor({
    account: () => ({ authed: true, open: true, loginId: "VRTC1", isVirtual: true, currency: "USD" }),
    currentSeq: symbol => engine.state(symbol).seq, nextReqId: () => ++req, await() {}, send: msg => sent.push(msg),
  });
  const original = { window: globalThis.window, document: globalThis.document, localStorage: globalThis.localStorage };
  try {
    globalThis.document = { getElementById: id => elements[id] || null };
    globalThis.localStorage = { getItem: () => null, setItem() {} };
    globalThis.window = { LDPE: { executor, engine, settings: { k: 1 } }, __ldpeHost: { symbol: "S" }, addEventListener() {} };
    await import("../../src/ldpe/prediction-digit-bot.js?page-test");
    window.PDT.arm(true);
    assert.equal(elements.pdtArm.checked, true);
    const result = engine.ingest("S", { epoch: 1000, quote: "100.1", decimals: 1 });
    window.PDT.afterTick("S", result, 1000);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].contract_type, "DIGITMATCH");
    assert.equal(sent[0].barrier, String(result.forecast.predictedDigit));
    window.PDT.pauseFeed("S");
    assert.equal(elements.pdtArm.checked, true);
    assert.match(elements.pdtStatus.textContent, /PAUSED/);
    window.PDT.interrupt("Feed interrupted");
    assert.equal(elements.pdtArm.checked, false);
    assert.match(elements.pdtStatus.textContent, /Feed interrupted/);
  } finally {
    globalThis.window = original.window; globalThis.document = original.document; globalThis.localStorage = original.localStorage;
  }
});
