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

test("stop-after-N ends the cycle", () => {
  const h = setup({ max: 2 });
  h.tick(0, 5); h.tick(1); h.tick(2); h.tick(3);
  assert.equal(h.cm.intentions.length, 2);
  assert.equal(h.cm.status("S").cycle, null);
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
