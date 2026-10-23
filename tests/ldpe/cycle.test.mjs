import test from "node:test";
import assert from "node:assert/strict";
import { Executor } from "../../src/ldpe/exec.js";
import { CycleManager } from "../../src/ldpe/cycle.js";

function setup({ accountType = "demo", acct = { authed: true, open: true, loginId: "VRTC1", isVirtual: true, currency: "USD" }, max = 0 } = {}) {
  const sent = [], pending = new Map(); let reqId = 0, seq = 0, now = 1_700_000_000_000, count = 0;
  const host = {
    send: (m) => sent.push(m), nextReqId: () => ++reqId, await: (id, cb) => pending.set(id, cb),
    account: () => ({ ...acct }), currentSeq: () => seq, now: () => now,
  };
  const ex = new Executor(host, { accountType });
  const cm = new CycleManager(ex, { k: () => 1, stake: () => 1, limits: () => ({ max, count }), noteOrder: () => { count++; } });
  let fid = 0, epoch = 1000;
  const h = {
    ex, cm, sent, pending,
    fc(digit, over = {}) { return { id: `f${++fid}`, symbol: "S", madeAtSeq: seq, targetSeq: seq + 1, predictedDigit: digit, decision: "TRADE", reconstructed: false, ...over }; },
    tick(digit, mk) {
      seq++; epoch++; now += 1000;
      const forecast = mk === undefined ? null : (typeof mk === "number" ? h.fc(mk) : mk);
      return h.cm.onTick({ symbol: "S", seq, epoch, digit, forecast, active: true });
    },
    respond(kind, resp, err) { const m = sent.filter(x => x[kind] !== undefined).pop(); const cb = pending.get(m.req_id); pending.delete(m.req_id); cb(resp, err); return m; },
    get seq() { return seq; },
  };
  return h;
}

test("one intention per non-target tick; none on the target tick; cycle ends", () => {
  const h = setup();
  assert.equal(h.tick(3, 5).started, 1);
  h.tick(1); h.tick(2); h.tick(4);
  assert.equal(h.cm.intentions.length, 3);
  assert.equal(h.sent.filter(m => m.proposal).length, 3);
  h.tick(5);
  assert.equal(h.cm.intentions.length, 3);
  assert.equal(h.cm.status("S").cycle, null);
  h.tick(1);
  assert.equal(h.cm.intentions.length, 3);
});

test("next cycle takes a fresh prediction; target stays fixed meanwhile", () => {
  const h = setup();
  h.tick(0, 5);
  h.tick(1, 9);
  assert.equal(h.cm.status("S").cycle.target, 5);
  h.tick(5, 9);
  assert.equal(h.cm.status("S").cycle.target, 9);
  h.tick(5);
  assert.equal(h.cm.intentions.length, 2);
  h.tick(2);
  assert.equal(h.cm.intentions.at(-1).target, 9);
  assert.equal(h.cm.status("S").cycle.id, 2);
});

test("hit tick without eligible prediction waits; stale and reconstructed forecasts are not used", () => {
  const h = setup();
  h.tick(0, 5);
  h.tick(5, h.fc(7, { madeAtSeq: 0 }));
  assert.equal(h.cm.status("S").cycle, null);
  assert.equal(h.cm.status("S").waiting, true);
  h.tick(1, h.fc(7, { reconstructed: true }));
  h.tick(1, h.fc(7, { decision: "SKIP" }));
  assert.equal(h.cm.status("S").cycle, null);
  assert.equal(h.sent.filter(m => m.proposal).length, 0);
});

test("duplicate and out-of-order ticks produce no second intention", () => {
  const h = setup();
  h.tick(0, 5); h.tick(1);
  const r = h.cm.onTick({ symbol: "S", seq: h.seq, epoch: 1001, digit: 1, forecast: null, active: true });
  assert.match(r.ignored, /duplicate/);
  assert.equal(h.cm.intentions.length, 1);
  assert.equal(h.cm.stats.duplicateTicks, 1);
  assert.equal(h.ex.placeTick({ symbol: "S", digit: 5, k: 1, contractType: "DIGITMATCH", stake: 1, tickSeq: h.seq, tickEpoch: 1002, tickDigit: 1, cycleId: 1, forecast: null }).ok, false);
});

test("orders are tracked independently: a delayed confirmation does not touch a newer cycle", () => {
  const h = setup();
  h.tick(0, 5); h.tick(1);
  const first = h.cm.intentions[0];
  h.tick(5, 9); h.tick(2);
  assert.equal(h.cm.intentions.length, 2);
  assert.equal(h.cm.intentions[1].target, 9);
  assert.equal(first.target, 5);
  assert.equal(h.cm.status("S").cycle.target, 9);
  assert.equal(h.sent.filter(m => m.proposal).length, 2);
});

test("failed and ambiguous requests are recorded, never retried, and processing is not blocked", () => {
  const h = setup();
  h.tick(0, 5); h.tick(1);
  h.respond("proposal", null, { message: "boom" });
  assert.equal(h.cm.intentions[0].status, "failed");
  h.tick(2); h.tick(3);
  assert.equal(h.cm.intentions.length, 3);
  assert.equal(h.sent.filter(m => m.proposal).length, 3);
  assert.equal(h.sent.filter(m => m.buy !== undefined).length, 0);
  assert.equal(h.cm.counts("S").failed, 1);
});

test("stop (inactive) ends the cycle; re-arming needs a fresh prediction", () => {
  const h = setup();
  h.tick(0, 5); h.tick(1);
  h.cm.onTick({ symbol: "S", seq: 99, epoch: 5000, digit: 1, forecast: null, active: false });
  assert.equal(h.cm.status("S").cycle, null);
  const before = h.cm.intentions.length;
  h.cm.onTick({ symbol: "S", seq: 100, epoch: 5001, digit: 1, forecast: null, active: true });
  assert.equal(h.cm.intentions.length, before);
});

test("stop-after-N never cuts a cycle short: it runs to its target, then no new cycle starts", () => {
  const h = setup({ max: 2 });
  h.tick(0, 5); h.tick(1); h.tick(2); h.tick(3); h.tick(4);
  assert.equal(h.cm.intentions.length, 4);
  assert.equal(h.cm.status("S").cycle.target, 5);
  h.tick(5, 7);
  assert.equal(h.cm.status("S").cycle, null);
  h.tick(6, 7); h.tick(7);
  assert.equal(h.cm.intentions.length, 4);
});

test("Demo/Real: orders go to the selected account only; mismatch is an error with no fallback", () => {
  const real = setup({ accountType: "real", acct: { authed: true, open: true, loginId: "CR1", isVirtual: false, currency: "USD" } });
  real.tick(0, 5); real.tick(1);
  assert.equal([...real.ex.orders.values()][0].accountId, "CR1");
  const mis = setup({ accountType: "real" });
  mis.tick(0, 5); mis.tick(1);
  assert.equal(mis.cm.intentions[0].status, "failed");
  assert.match(mis.cm.intentions[0].reason, /no fallback/);
  assert.equal(mis.sent.length, 0);
});

// ---- stake progression is cycle-scoped (martingale x1.8 from 0.50, mirrors makeMultiplier) ----
function stakeHarness() {
  const h = setup();
  let hist = [];
  const base = 0.5, X = 1.8;
  const nextStake = () => { const l = hist[hist.length - 1]; return Math.round((!l || l.won ? base : l.stake * X) * 100) / 100; };
  h.cm.opts.stake = nextStake;
  h.cm.opts.resetStake = () => { hist = []; };
  h.ex.on((o, ev) => { if (ev === "settled" && h.cm.countsForStake(o.contractId)) hist.push({ stake: o.stake, won: o.result === "won" }); });
  let cid = 0;
  h.openOrder = (o) => {
    const prop = h.sent.filter(m => m.proposal !== undefined)[[...h.ex.orders.values()].indexOf(o)];
    h.pending.get(prop.req_id)({ id: "P" + prop.req_id, ask_price: o.stake }); h.pending.delete(prop.req_id);
    const buy = h.sent.filter(m => m.buy !== undefined).pop();
    h.pending.get(buy.req_id)({ contract_id: ++cid + 500, buy_price: o.stake, purchase_time: 1 }); h.pending.delete(buy.req_id);
  };
  h.settle = (o, won) => h.ex.onContractUpdate({ contract_id: o.contractId, status: won ? "won" : "lost", is_sold: 1, profit: won ? o.stake * 8 : -o.stake });
  h.orders = () => [...h.ex.orders.values()];
  return h;
}

test("a confirmed win ends the cycle; the next cycle starts at the base stake even with the same target digit", () => {
  const h = stakeHarness();
  h.tick(0, 2);                        // cycle 1, target 2
  h.tick(3); const a1 = h.orders()[0]; h.openOrder(a1); h.settle(a1, false);
  h.tick(4); const a2 = h.orders()[1]; h.openOrder(a2); h.settle(a2, false);
  h.tick(6); const a3 = h.orders()[2]; h.openOrder(a3);
  assert.deepEqual([a1.stake, a2.stake, a3.stake], [0.5, 0.9, 1.62]);
  h.settle(a3, true);                  // win (13:28:30)
  assert.equal(h.cm.status("S").cycle, null);
  assert.equal(h.cm.cycles.at(-1).endReason, "win confirmed");
  h.tick(7, 2);                        // next cycle, SAME target digit
  const c2 = h.cm.status("S").cycle; assert.equal(c2.id, 2); assert.equal(c2.target, 2);
  h.tick(8); const b1 = h.orders()[3]; h.openOrder(b1);
  assert.equal(b1.stake, 0.5); assert.equal(b1.intent.cycleId, 2);
  h.settle(b1, true);                  // second win (13:28:42)
  assert.equal(h.cm.status("S").cycle, null);
  h.tick(9, 2); h.tick(1);
  assert.equal(h.orders()[4].stake, 0.5); assert.equal(h.orders()[4].intent.cycleId, 3);
});

test("losses inside a cycle keep following the recovery progression", () => {
  const h = stakeHarness();
  h.tick(0, 2);
  const st = [];
  for (const d of [3, 4, 6, 7]) { h.tick(d); const o = h.orders().at(-1); h.openOrder(o); h.settle(o, false); st.push(o.stake); }
  assert.deepEqual(st, [0.5, 0.9, 1.62, 2.92]);
  assert.equal(h.cm.status("S").cycle.id, 1);
});

test("late loss from an older cycle cannot restore its recovery stake in the new cycle", () => {
  const h = stakeHarness();
  h.tick(0, 2);
  h.tick(3); const a1 = h.orders()[0]; h.openOrder(a1);
  h.tick(4); const a2 = h.orders()[1]; h.openOrder(a2);
  h.settle(a2, true);                  // win ends cycle 1 while a1 is still open
  h.tick(5, 2);
  h.tick(6); const b1 = h.orders()[2]; h.openOrder(b1);
  h.settle(a1, false);                 // delayed loss from cycle 1
  h.tick(8); const b2 = h.orders()[3];
  assert.equal(b1.stake, 0.5); assert.equal(b2.stake, 0.5);
  assert.equal(b2.intent.cycleId, 2); assert.equal(h.cm.status("S").cycle.target, 2);
});

test("duplicate settlement events do not end another cycle or change the stake", () => {
  const h = stakeHarness();
  h.tick(0, 2); h.tick(3); const a1 = h.orders()[0]; h.openOrder(a1);
  h.settle(a1, true);
  h.tick(5, 2);
  const dup = h.settle(a1, true);
  assert.equal(dup.duplicate, true);
  assert.equal(h.cm.status("S").cycle.id, 2);
  h.tick(6); assert.equal(h.orders()[1].stake, 0.5);
});