import test from "node:test";
import assert from "node:assert/strict";
import { Ldpe } from "../../src/ldpe/engine.js";
import { Executor } from "../../src/ldpe/exec.js";

function rng(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

function harness({ k = 5, accountType = "demo", stopped = false, acct = { authed: true, open: true, loginId: "VRTC1", isVirtual: true, currency: "USD" } } = {}) {
  const engine = new Ldpe({ horizon: k, minTicks: 10, minProbability: 0 });
  const r = rng(7); let epoch = 1000, now = 1_700_000_000_000;
  const sent = [], pending = new Map(); let reqId = 0;
  const host = {
    send: (m) => { sent.push(m); },
    nextReqId: () => ++reqId,
    await: (id, cb) => pending.set(id, cb),
    account: () => ({ ...h.acct }), currentSeq: (s) => engine.state(s).seq, now: () => now,
  };
  const ex = new Executor(host, { accountType, stopped });
  const h = {
    engine, ex, sent, acct: { ...acct },
    tick() { epoch++; return engine.ingest("S", { epoch, quote: "100.0" + Math.floor(r() * 10), decimals: 2 }); },
    ticks(n) { let f; for (let i = 0; i < n; i++) f = h.tick().forecast; return f; },
    respond(kind, resp, err) { const m = sent.filter(x => x[kind] !== undefined).pop(); const cb = pending.get(m.req_id); pending.delete(m.req_id); cb(resp, err); return m; },
    place(f, extra = {}) { return ex.place({ symbol: "S", digit: f.predictedDigit, k, contractType: "DIGITMATCH", stake: 1, forecast: f, ...extra }); },
  };
  h.ticks(60);
  return h;
}

test("Demo selected: order goes out on the Demo account", () => {
  const h = harness();
  const f = h.ticks(1);
  const r = h.place(f);
  assert.equal(r.ok, true); assert.equal(r.order.isVirtual, true); assert.equal(r.order.accountId, "VRTC1");
  assert.equal(h.sent.filter(m => m.proposal).length, 1);
});

test("Real selected: order goes out on the Real account with no gate or confirmation", () => {
  const h = harness({ accountType: "real", acct: { authed: true, open: true, loginId: "CR1", isVirtual: false, currency: "USD" } });
  const f = h.ticks(1);
  const r = h.place(f);
  assert.equal(r.ok, true); assert.equal(r.order.isVirtual, false); assert.equal(r.order.accountId, "CR1");
});

test("switch routing: selected Real but connected Demo is refused with the actual error, never falling back", () => {
  const h = harness({ accountType: "real" });
  const f = h.ticks(1);
  const r = h.place(f);
  assert.equal(r.ok, false); assert.match(r.reason, /Real account selected, but the connected account is Demo.*no fallback/);
  assert.equal(h.sent.length, 0);
  h.ex.setAccountType("demo");
  assert.equal(h.place(f).ok, true);
});

test("switch routing: selected Demo but connected Real is refused", () => {
  const h = harness({ accountType: "demo", acct: { authed: true, open: true, loginId: "CR1", isVirtual: false, currency: "USD" } });
  const r = h.place(h.ticks(1));
  assert.equal(r.ok, false); assert.match(r.reason, /Demo account selected, but the connected account is Real/);
});

test("an account change between proposal and purchase aborts the order (no buy, no fallback)", () => {
  const h = harness();
  const f = h.ticks(1);
  const { order } = h.place(f);
  h.acct = { authed: true, open: true, loginId: "CR1", isVirtual: false, currency: "USD" };
  h.respond("proposal", { id: "p", ask_price: 1 });
  assert.equal(order.state, "rejected"); assert.match(order.reason, /account changed/);
  assert.equal(h.sent.filter(m => m.buy).length, 0);
});

test("a proposal error is surfaced as the order reason", () => {
  const h = harness();
  const { order } = h.place(h.ticks(1));
  h.respond("proposal", null, { message: "Contract not offered" });
  assert.equal(order.state, "rejected"); assert.match(order.reason, /Contract not offered/);
});

test("Stop: no automatic order is placed while stopped; one toggle re-arms", () => {
  const h = harness({ stopped: true });
  const f = h.ticks(1);
  const r = h.place(f);
  assert.equal(r.ok, false); assert.equal(r.reason, "stopped");
  assert.equal(h.sent.length, 0);
  h.ex.setStopped(false);
  assert.equal(h.place(f).ok, true);
});

test("Stop pressed between proposal and purchase prevents the buy", () => {
  const h = harness();
  const { order } = h.place(h.ticks(1));
  h.ex.setStopped(true);
  h.respond("proposal", { id: "p", ask_price: 1 });
  assert.equal(order.state, "rejected"); assert.match(order.reason, /stopped before purchase/);
  assert.equal(h.sent.filter(m => m.buy).length, 0);
});

test("Stop: forecasts keep being generated and scored while stopped", () => {
  const h = harness({ stopped: true });
  const before = h.engine.state("S").forecasts.filter(f => f.status === "scored").length;
  h.ticks(30);
  const after = h.engine.state("S").forecasts.filter(f => f.status === "scored").length;
  assert.ok(after > before, "forecasts still scored");
  assert.equal(h.sent.length, 0);
  const ids = h.engine.state("S").forecasts.map(f => f.id);
  assert.equal(new Set(ids).size, ids.length, "each forecast exactly once");
});

test("duplicate forecast: a second order for the same forecast is refused", () => {
  const h = harness();
  const f = h.ticks(1);
  assert.equal(h.place(f).ok, true);
  const again = h.place(f);
  assert.equal(again.ok, false); assert.match(again.reason, /duplicate/);
});

test("stale forecast is refused; non-TRADE forecast is refused", () => {
  const h = harness();
  const f = h.ticks(1); h.ticks(1);
  assert.match(h.place(f).reason, /stale/);
  const g = h.ticks(1);
  assert.match(h.place({ ...g, decision: "NO_TRADE" }).reason, /not a TRADE/);
});

test("no open-contract limit: several symbols/orders are not capped by LDPE", () => {
  const h = harness();
  const f1 = h.ticks(1);
  assert.equal(h.place(f1).ok, true);
  const f2 = h.ticks(1);
  assert.equal(h.place(f2).ok, true);
});

test("settlement update is applied exactly once; duplicate events are ignored", () => {
  const h = harness();
  const { order } = h.place(h.ticks(1));
  h.respond("proposal", { id: "p", ask_price: 1 });
  h.respond("buy", { contract_id: "C1", buy_price: 1, purchase_time: 1 });
  assert.equal(order.state, "open");
  const c = { contract_id: "C1", is_sold: 1, profit: 0.9 };
  assert.equal(h.ex.onContractUpdate(c).settled, true);
  assert.equal(h.ex.onContractUpdate(c).duplicate, true);
  assert.equal(order.result, "won");
  assert.equal(h.ex.onContractUpdate({ contract_id: "other", is_sold: 1 }).handled, false);
});

test("disconnect: pricing order rejected, buying order unknown, never resent", () => {
  const h = harness();
  const a = h.place(h.ticks(1)).order;
  h.ex.onDisconnect();
  assert.equal(a.state, "rejected");
  const b = h.place(h.ticks(1)).order;
  h.respond("proposal", { id: "p", ask_price: 1 });
  h.ex.onDisconnect();
  assert.equal(b.state, "unknown");
  assert.equal(h.sent.filter(m => m.buy).length, 1);
});

test("serialize/restore keeps duplicate protection and passes old records through", () => {
  const h = harness();
  const f = h.ticks(1);
  h.place(f);
  const s = JSON.parse(JSON.stringify(h.ex.serialize()));
  s.alignment = { old: "record" };
  const ex2 = new Executor({ ...h.ex.host }, { accountType: "demo" });
  ex2.restore(s);
  assert.equal(ex2.orderedForecasts.has(f.id), true);
  assert.deepEqual(ex2.legacy, { alignment: { old: "record" } });
  assert.equal(ex2.serialize().legacy.alignment.old, "record");
});

test("placeTick: rate limit refuses excess orders without sending", () => {
  const h = harness({ k: 1 });
  const mk = (i) => h.ex.placeTick({ symbol: "S", digit: 5, k: 1, contractType: "DIGITMATCH", stake: 1, tickSeq: 9000 + i, tickEpoch: 9000 + i, tickDigit: 1, cycleId: 1, forecast: null });
  assert.equal(mk(1).ok, true); assert.equal(mk(2).ok, true);
  const r = mk(3); assert.equal(r.ok, false);
  assert.equal(h.sent.filter(m => m.proposal).length, 2);
});

test("placeTick: stake is rounded to 2 decimals and stopped executor refuses", () => {
  const h = harness({ k: 1 });
  const r = h.ex.placeTick({ symbol: "S", digit: 5, k: 1, contractType: "DIGITMATCH", stake: 5.832, tickSeq: 9001, tickEpoch: 9001, tickDigit: 1, cycleId: 1, forecast: null });
  assert.equal(r.ok, true);
  assert.equal(h.sent.filter(m => m.proposal).pop().amount, 5.83);
  h.ex.setStopped(true);
  assert.equal(h.ex.placeTick({ symbol: "S", digit: 5, k: 1, contractType: "DIGITMATCH", stake: 1, tickSeq: 9002, tickEpoch: 9002, tickDigit: 1, cycleId: 1, forecast: null }).ok, false);
});