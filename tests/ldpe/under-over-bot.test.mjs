import test from "node:test";
import assert from "node:assert/strict";
import { Executor } from "../../src/ldpe/exec.js";
import { UnderOverBot, decide, UNDER, OVER } from "../../src/ldpe/under-over-bot.js";

function setup({ tp = 0, sl = 0 } = {}) {
  const sent = [], pending = new Map(); let reqId = 0, seq = 0, epoch = 1000, now = 1_700_000_000_000, cid = 0;
  const host = {
    send: (m) => sent.push(m), nextReqId: () => ++reqId, await: (id, cb) => pending.set(id, cb),
    account: () => ({ authed: true, open: true, loginId: "VRTC1", isVirtual: true, currency: "USD" }), currentSeq: () => seq, now: () => now,
  };
  const ex = new Executor(host, { accountType: "demo" });
  let gaps = new Array(10).fill(0), hist = [];
  const base = 0.5, X = 2;
  const bot = new UnderOverBot(ex, {
    k: () => 1, threshold: () => 30, targetProfit: () => tp, stopLoss: () => sl, gaps: () => gaps,
    stake: (p) => {   // same projection as the page's multiplier: pending orders count as losses
      let last = hist.length ? hist[hist.length - 1] : null, s = last && !last.won ? last.stake * X : base;
      for (let i = 0; i < p; i++) s = s * X;
      return Math.round(s * 100) / 100;
    },
    resetStake: () => { hist = []; },
  });
  const h = {
    ex, bot, sent, setGaps(g) { gaps = g; },
    tick(digit = 5) { seq++; epoch++; now += 1000; return bot.onTick({ symbol: "S", seq, epoch, digit, active: true }); },
    orders: () => [...ex.orders.values()],
    open(o) {
      const prop = sent.filter(m => m.proposal !== undefined)[h.orders().indexOf(o)];
      pending.get(prop.req_id)({ id: "P" + prop.req_id, ask_price: o.stake }); pending.delete(prop.req_id);
      const buy = sent.filter(m => m.buy !== undefined).pop();
      pending.get(buy.req_id)({ contract_id: ++cid + 900, buy_price: o.stake, purchase_time: 1 }); pending.delete(buy.req_id);
    },
    settle(o, won) {
      ex.onContractUpdate({ contract_id: o.contractId, status: won ? "won" : "lost", is_sold: 1, profit: won ? o.stake * 3 : -o.stake });
      if (bot.countsForStake(o.contractId)) hist.push({ stake: o.stake, won });
    },
  };
  return h;
}
const G = (o) => { const g = new Array(10).fill(0); for (const [d, v] of Object.entries(o)) g[d] = v; return g; };

test("decide: totals of gap(0)+gap(1) and gap(9)+gap(8) must be strictly over the threshold", () => {
  assert.equal(decide(G({ 0: 15, 1: 15 }), 30).side, null);
  assert.equal(decide(G({ 0: 16, 1: 15 }), 30).side, UNDER);
  assert.equal(decide(G({ 8: 20, 9: 11 }), 30).side, OVER);
  assert.equal(decide(G({ 0: 20, 1: 20, 8: 25, 9: 25 }), 30).side, OVER);   // both: larger total wins
  assert.equal(decide(null, 30).side, null);
  const g = G({ 0: 40 }); g[1] = null; assert.equal(decide(g, 30).side, null); // unseen digit: no decision
});

test("armed: one order per tick while the rule holds, Under 2 barrier, nothing when it does not", () => {
  const h = setup(); h.bot.setArmed(true);
  h.setGaps(G({ 0: 10, 1: 10 })); h.tick();
  assert.equal(h.sent.filter(m => m.proposal).length, 0);
  h.setGaps(G({ 0: 20, 1: 15 })); h.tick(); h.tick(); h.tick();
  const props = h.sent.filter(m => m.proposal);
  assert.equal(props.length, 3);
  assert.ok(props.every(m => m.contract_type === "DIGITUNDER" && m.barrier === "2" && m.duration === 1));
  h.setGaps(G({ 8: 18, 9: 18 })); h.tick();
  const last = h.sent.filter(m => m.proposal).pop();
  assert.equal(last.contract_type, "DIGITOVER"); assert.equal(last.barrier, "7");
});

test("not armed: no orders; duplicate tick sequence ignored", () => {
  const h = setup(); h.setGaps(G({ 0: 40 }));
  h.tick(); assert.equal(h.sent.length, 0);
  h.bot.setArmed(true);
  const r = h.bot.onTick({ symbol: "S", seq: 1, epoch: 5, digit: 1, active: true });
  assert.match(r.ignored, /duplicate/);
});

test("martingale steps on overlapping orders and resets to base after a confirmed win", () => {
  const h = setup(); h.bot.setArmed(true); h.setGaps(G({ 0: 20, 1: 20 }));
  h.tick(); h.tick(); h.tick();   // nothing settles in between
  assert.deepEqual(h.orders().map(o => o.stake), [0.5, 1, 2]);
  const [a, b, c] = h.orders();
  h.open(a); h.open(b); h.open(c);
  h.settle(a, false); h.settle(b, true);   // win ends the run
  h.tick();
  assert.equal(h.orders()[3].stake, 0.5);
  h.settle(c, false);                      // late loss from the old run does not change the new stake
  h.tick(); assert.equal(h.orders()[4].stake, 1);
});

test("take profit stops the bot and reports it", () => {
  const h = setup({ tp: 1 }); h.bot.setArmed(true); h.setGaps(G({ 0: 20, 1: 20 }));
  h.tick(); const a = h.orders()[0]; h.open(a); h.settle(a, true);   // +1.5
  assert.equal(h.bot.armed, false);
  assert.equal(h.bot.stopKind, "tp");
  assert.match(h.bot.stopReason, /take profit/);
  h.tick(); assert.equal(h.orders().length, 1);
});

test("stop loss stops the bot and reports it", () => {
  const h = setup({ sl: 1 }); h.bot.setArmed(true); h.setGaps(G({ 8: 20, 9: 20 }));
  h.tick(); const a = h.orders()[0]; h.open(a); h.settle(a, false);   // -0.5
  assert.equal(h.bot.armed, true);
  h.tick(); const b = h.orders()[1]; h.open(b); h.settle(b, false);   // total -1.5
  assert.equal(h.bot.armed, false);
  assert.equal(h.bot.stopKind, "sl");
  assert.ok(h.bot.stopPnl <= -1);
});
