import test from "node:test";
import assert from "node:assert/strict";
import { Executor } from "../../src/ldpe/exec.js";
import { GapTrader } from "../../src/ldpe/gap-trader.js";

function setup({ trigger = 5, accountType = "demo", acct = { authed: true, open: true, loginId: "VRTC1", isVirtual: true, currency: "USD" } } = {}) {
  const sent = [], pending = new Map(); let reqId = 0, seq = 0, now = 1_700_000_000_000, resets = 0, gaps = new Array(10).fill(null), cid = 500;
  const host = { send: (m) => sent.push(m), nextReqId: () => ++reqId, await: (id, cb) => pending.set(id, cb), account: () => ({ ...acct }), currentSeq: () => seq, now: () => now };
  const ex = new Executor(host, { accountType });
  const tr = new GapTrader(ex, { k: () => 1, stake: () => 1, trigger: () => trigger, resetStake: () => { resets++; }, gaps: () => gaps });
  tr.armed = true;
  const h = {
    ex, tr, sent, get resets() { return resets; }, setGaps(g) { gaps = g; },
    tick(digit, active = true) { seq++; now += 1000; return tr.onTick({ symbol: "S", seq, epoch: 1000 + seq, digit, active }); },
    orders: () => [...ex.orders.values()],
    open(o) {
      const p = sent.filter(m => m.proposal !== undefined)[h.orders().indexOf(o)];
      pending.get(p.req_id)({ id: "P" + p.req_id, ask_price: o.stake });
      const b = sent.filter(m => m.buy !== undefined).pop();
      pending.get(b.req_id)({ contract_id: ++cid, buy_price: o.stake, purchase_time: 1 });
    },
    settle: (o, won) => ex.onContractUpdate({ contract_id: o.contractId, status: won ? "won" : "lost", is_sold: 1, profit: won ? 8 : -1 }),
  };
  return h;
}
const G = (o) => { const g = new Array(10).fill(0); for (const [d, v] of Object.entries(o)) g[d] = v; return g; };

test("waits until a digit's gap reaches the trigger, then targets the highest gap", () => {
  const h = setup({ trigger: 5 });
  h.setGaps(G({ 3: 4, 7: 2 })); assert.equal(h.tick(1).waiting, true);
  assert.equal(h.sent.length, 0);
  h.setGaps(G({ 3: 6, 8: 9 }));
  const r = h.tick(1); assert.equal(r.target, 8);
  h.tick(2); assert.equal(h.orders().length, 1); assert.equal(h.orders()[0].digit, 8);
});

test("buys every non-target tick; the target tick is not bought; next cycle needs the trigger again", () => {
  const h = setup({ trigger: 5 });
  h.setGaps(G({ 8: 9 })); h.tick(1);
  h.tick(2); h.tick(3);
  assert.equal(h.orders().length, 2);
  h.setGaps(G({ 8: 0, 4: 3 }));
  const r = h.tick(8);
  assert.equal(h.orders().length, 2);
  assert.equal(r.waiting, true); assert.equal(h.tr.cycle, null);   // next highest (4 at 3) is below the trigger
  h.setGaps(G({ 8: 2, 4: 6 })); assert.equal(h.tick(1).target, 4);
  assert.equal(h.tr.cycle.n, 2);
});

test("a cycle's target stays fixed even if another digit's gap becomes larger", () => {
  const h = setup({ trigger: 5 });
  h.setGaps(G({ 8: 9 })); h.tick(1);
  h.setGaps(G({ 8: 10, 2: 40 })); h.tick(3);
  assert.equal(h.tr.cycle.target, 8); assert.equal(h.orders()[0].digit, 8);
});

test("a confirmed win ends the cycle and resets the progression; late result from an old cycle does nothing to the new one", () => {
  const h = setup({ trigger: 5 });
  h.setGaps(G({ 8: 9 })); h.tick(1);
  h.tick(2); const a = h.orders()[0]; h.open(a);
  h.tick(3); const b = h.orders()[1]; h.open(b);
  const before = h.resets;
  h.settle(a, true);
  assert.equal(h.tr.cycle, null); assert.ok(h.resets > before);
  assert.equal(h.tr.cycles.at(-1).endReason, "win confirmed");
  h.setGaps(G({ 8: 9 })); h.tick(1);
  const id2 = h.tr.cycle.id;
  assert.equal(h.tr.countsForStake(b.contractId), false);
  h.settle(b, false);
  assert.equal(h.tr.cycle.id, id2);
});

test("disarmed or stopped: no orders; disarming ends the cycle", () => {
  const h = setup({ trigger: 5 });
  h.tr.setArmed(false); h.setGaps(G({ 8: 9 })); h.tick(1); h.tick(2);
  assert.equal(h.sent.length, 0);
  h.tr.setArmed(true); h.tick(1); assert.ok(h.tr.cycle);
  h.tick(2, false); assert.equal(h.tr.cycle, null);
  assert.equal(h.orders().length, 0);
});

test("manual digit trade goes through the executor on the latest tick, ignoring Arm and Stop; duplicates refused", () => {
  const h = setup(); h.tr.setArmed(false); h.ex.setStopped(true);
  assert.equal(h.tr.manual(4).ok, false);              // no tick yet
  h.tick(1);
  const r = h.tr.manual(4); assert.equal(r.ok, true);
  assert.equal(h.orders()[0].digit, 4); assert.equal(h.sent.filter(m => m.proposal).length, 1);
  assert.equal(h.tr.manual(4).ok, false);              // same tick, same digit
  assert.equal(h.tr.manual(5).ok, true);
});

test("Demo/Real: selected account only, mismatch shows the error with no fallback", () => {
  const real = setup({ accountType: "real", acct: { authed: true, open: true, loginId: "CR1", isVirtual: false, currency: "USD" } });
  real.tr.setArmed(true); real.setGaps(G({ 8: 9 })); real.tick(1); real.tick(2);
  assert.equal(real.orders()[0].accountId, "CR1");
  const mis = setup({ accountType: "real" });
  mis.tr.setArmed(true); mis.setGaps(G({ 8: 9 })); mis.tick(1); mis.tick(2);
  assert.equal(mis.sent.length, 0);
  assert.match(mis.tr.intentions[0].reason, /no fallback/);
});

test("duplicate ticks produce no second intention", () => {
  const h = setup(); h.tr.setArmed(true); h.setGaps(G({ 8: 9 })); h.tick(1); h.tick(2);
  assert.match(h.tr.onTick({ symbol: "S", seq: 2, epoch: 1002, digit: 2, active: true }).ignored, /duplicate/);
  assert.equal(h.orders().length, 1);
});