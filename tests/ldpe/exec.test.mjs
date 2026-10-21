import test from "node:test";
import assert from "node:assert/strict";
import { Ldpe } from "../../src/ldpe/engine.js";
import { Executor, AlignmentLedger, configKey, MIN_CLEAN_EVIDENCE } from "../../src/ldpe/exec.js";

function rng(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

// Harness: a real engine + real Executor behind a scripted host/socket.
function harness({ k = 5, span = k - 1, acct = { authed: true, open: true, loginId: "VRTC1", isVirtual: true, currency: "USD" }, limits } = {}) {
  const engine = new Ldpe({ horizon: k, minTicks: 10, minProbability: 0 });
  const r = rng(7); let epoch = 1000, now = 1_700_000_000_000;
  const sent = [], pending = new Map(); let reqId = 0;
  const host = {
    send: (m) => { if (host.fail) throw new Error("closed"); sent.push(m); },
    nextReqId: () => ++reqId,
    await: (id, cb) => pending.set(id, cb),
    account: () => ({ ...acct }), currentSeq: (s) => engine.state(s).seq, now: () => now,
  };
  const alignment = new AlignmentLedger();
  const ex = new Executor(host, { alignment, getEngine: () => engine, limits });
  const h = {
    engine, ex, host, sent, acct, alignment, SYM: "S",
    tick() { epoch++; return engine.ingest("S", { epoch, quote: "100.0" + Math.floor(r() * 10), decimals: 2 }); },
    ticks(n) { let f; for (let i = 0; i < n; i++) f = h.tick().forecast; return f; },
    epochAtSeq: (seq) => engine.state("S").ticks.find(t => t.seq === seq).epoch,
    respond(msgType, resp, err) { const m = sent.filter(x => x[msgType] !== undefined).pop(); const cb = pending.get(m.req_id); pending.delete(m.req_id); cb(resp, err); return m; },
    advance(ms) { now += ms; },
    // full lifecycle for one contract; delay = ticks between the forecast and the buy
    run({ mode = "probe", delay = 0, deliver = true, contractId, entryDelay = 0, profit = 1 } = {}) {
      const f = h.ticks(1);
      const res = ex.place({ symbol: "S", digit: f.predictedDigit, k, contractType: "DIGITMATCH", stake: 1, forecast: f, mode });
      if (!res.ok) return { res };
      if (delay) h.ticks(delay);
      h.respond("proposal", { id: "p" + reqId, ask_price: 1 });
      const order = res.order;
      if (order.state !== "buying") return { res, order };
      const cid = contractId || String(5000 + reqId);
      h.respond("buy", { contract_id: cid, buy_price: 1, purchase_time: h.epochAtSeq(f.madeAtSeq) });
      const entrySeq = f.madeAtSeq + 1 + entryDelay, exitSeq = entrySeq + span;
      h.ticks(Math.max(0, exitSeq - engine.state("S").seq));
      const c = {
        contract_id: cid, purchase_time: h.epochAtSeq(f.madeAtSeq), entry_tick_time: deliver ? h.epochAtSeq(entrySeq) : undefined,
        exit_tick_time: deliver ? h.epochAtSeq(exitSeq) : undefined, is_sold: 1, profit,
      };
      return { res, order, f, c, cid, update: ex.onContractUpdate(c) };
    },
    verify(n = MIN_CLEAN_EVIDENCE) { for (let i = 0; i < n; i++) h.run(); },
  };
  h.ticks(60);
  return h;
}
const KEY = (k = 5) => configKey("DIGITMATCH", k, "S");

// ---------------------------------------------------------------- settlement alignment
test("alignment: duration k with exit = entry + (k-1) is verified at horizon k only after enough clean contracts", () => {
  const h = harness({ k: 5, span: 4 });
  for (let i = 1; i < MIN_CLEAN_EVIDENCE; i++) { h.run(); assert.equal(h.alignment.status(KEY()).state, "unresolved"); }
  const last = h.run();
  assert.equal(last.order.alignment.status, "aligned");
  assert.equal(last.order.alignment.entryDelayTicks, 0);
  assert.equal(last.order.alignment.entryFirstAfterPurchase, true);
  const s = h.alignment.status(KEY());
  assert.equal(s.state, "verified"); assert.equal(s.horizon, 5); assert.equal(s.matchesConfiguredTicks, true);
  assert.match(s.relation, /forecast tick \+ 5/);
});

test("alignment: off-by-one (exit = entry + k) is detected, never treated as aligned, and yields horizon k+1", () => {
  const h = harness({ k: 5, span: 5 });
  const r = h.run();
  assert.equal(r.order.alignment.status, "misaligned_offset");
  assert.equal(r.order.alignment.observedOffset, 6);
  assert.equal(r.order.alignment.expectedTargetSeq, r.f.targetSeq);          // forecast target untouched
  assert.notEqual(r.order.alignment.exitSeq, r.f.targetSeq);
  h.verify(MIN_CLEAN_EVIDENCE - 1);
  const s = h.alignment.status(KEY());
  assert.equal(s.state, "verified"); assert.equal(s.horizon, 6); assert.equal(s.matchesConfiguredTicks, false);
});

test("alignment: three agreeing contracts are not sufficient", () => {
  const h = harness({ k: 5, span: 4 });
  h.verify(3);
  assert.equal(h.alignment.status(KEY()).state, "unresolved");
});

test("alignment: delayed purchases are recorded as misaligned_delay and never count as clean evidence", () => {
  const h = harness({ k: 5, span: 4 });
  // manually construct delayed evidence bypassing the pre-purchase guard (late but accepted contracts)
  const eng = h.engine, f = { id: "S:5:x", madeAtSeq: eng.state("S").seq - 10, targetSeq: eng.state("S").seq - 5, horizon: 5 };
  const order = { contractId: "d1", forecast: f, symbol: "S", contractType: "DIGITMATCH", k: 5, isVirtual: true };
  const c = { purchase_time: h.epochAtSeq(f.madeAtSeq + 1), entry_tick_time: h.epochAtSeq(f.madeAtSeq + 2), exit_tick_time: h.epochAtSeq(f.madeAtSeq + 6) };
  const rec = h.alignment.evaluate(eng, order, c);
  assert.equal(rec.status, "misaligned_delay"); assert.equal(rec.entryDelayTicks, 1);
  assert.notEqual(rec.exitSeq, f.targetSeq);
  assert.equal(h.alignment.status(KEY()).clean, 0);
});

test("pre-purchase guard: a tick arriving between forecast and buy aborts the order without buying", () => {
  const h = harness();
  const f = h.ticks(1);
  const { order } = h.ex.place({ symbol: "S", digit: f.predictedDigit, k: 5, contractType: "DIGITMATCH", stake: 1, forecast: f, mode: "probe" });
  h.ticks(1);
  h.respond("proposal", { id: "p", ask_price: 1 });
  assert.equal(order.state, "rejected"); assert.match(order.reason, /stale before purchase/);
  assert.equal(h.sent.filter(m => m.buy).length, 0);
  assert.equal(h.ex.openCount("S"), 0);
});

test("alignment: missing tick data is unresolved with an explicit reason", () => {
  const h = harness();
  const noTimes = h.run({ deliver: false });
  assert.equal(noTimes.order.alignment.status, "unresolved"); assert.match(noTimes.order.alignment.reason, /lacks entry\/exit/);
  const f = { id: "S:5:z", madeAtSeq: 50, targetSeq: 55, horizon: 5 };
  const rec = h.alignment.evaluate(h.engine, { contractId: "m1", forecast: f, symbol: "S", contractType: "DIGITMATCH", k: 5, isVirtual: true },
    { entry_tick_time: 999999, exit_tick_time: 1000003 });
  assert.equal(rec.status, "unresolved"); assert.match(rec.reason, /missing tick data/);
  assert.equal(h.alignment.status(KEY()).clean, 0);
});

test("alignment: a feed hole between forecast and settlement makes the contract unresolved", () => {
  const h = harness();
  const f = h.ticks(1);
  const { order } = h.ex.place({ symbol: "S", digit: 1, k: 5, contractType: "DIGITMATCH", stake: 1, forecast: f, mode: "probe" });
  h.respond("proposal", { id: "p", ask_price: 1 }); h.respond("buy", { contract_id: "c1", buy_price: 1 });
  h.ticks(2); h.engine.markDiscontinuity("S"); h.ticks(4);
  h.ex.onContractUpdate({ contract_id: "c1", purchase_time: h.epochAtSeq(f.madeAtSeq), entry_tick_time: h.epochAtSeq(f.madeAtSeq + 1), exit_tick_time: h.epochAtSeq(f.madeAtSeq + 5), is_sold: 1, profit: -1 });
  assert.equal(order.alignment.status, "unresolved"); assert.match(order.alignment.reason, /feed hole/);
});

test("alignment: contradictory observations block verification", () => {
  const h = harness({ k: 5, span: 4 });
  h.verify(4);
  const odd = harness({ k: 5, span: 4 });
  // inject one clean observation with a different span into the same ledger
  const f = h.ticks(1);
  const { order } = h.ex.place({ symbol: "S", digit: 1, k: 5, contractType: "DIGITMATCH", stake: 1, forecast: f, mode: "probe" });
  h.respond("proposal", { id: "p", ask_price: 1 }); h.respond("buy", { contract_id: "weird", buy_price: 1 });
  h.ticks(8);
  h.ex.onContractUpdate({ contract_id: "weird", purchase_time: h.epochAtSeq(f.madeAtSeq), entry_tick_time: h.epochAtSeq(f.madeAtSeq + 1), exit_tick_time: h.epochAtSeq(f.madeAtSeq + 7), is_sold: 1, profit: 1 });
  const s = h.alignment.status(KEY());
  assert.equal(s.state, "contradicted"); assert.equal(order.alignment.observedOffset, 7);
  void odd;
});

// ---------------------------------------------------------------- execution safeguards
test("auto execution is refused while alignment is unresolved (Demo and Real); probes are Demo-only", () => {
  const h = harness();
  const f = h.ticks(1);
  const a = h.ex.place({ symbol: "S", digit: 1, k: 5, contractType: "DIGITMATCH", stake: 1, forecast: f, mode: "auto" });
  assert.equal(a.ok, false); assert.match(a.reason, /alignment unresolved/);
  h.acct.isVirtual = false; h.acct.loginId = "CR1";
  const p = h.ex.place({ symbol: "S", digit: 1, k: 5, contractType: "DIGITMATCH", stake: 1, forecast: f, mode: "probe" });
  assert.equal(p.ok, false); assert.match(p.reason, /Demo-only/);
  assert.equal(h.sent.length, 0);
});

test("once verified, auto orders are allowed and carry the account they were created on", () => {
  const h = harness({ k: 5, span: 4 }); h.verify();
  const f = h.ticks(1);
  const r = h.ex.place({ symbol: "S", digit: 1, k: 5, contractType: "DIGITMATCH", stake: 1, forecast: f, mode: "auto" });
  assert.equal(r.ok, true, r.reason); assert.equal(r.order.accountId, "VRTC1"); assert.equal(r.order.isVirtual, true);
});

test("at most one open contract per symbol: concurrent attempts, duplicate forecast, and open-until-settled", () => {
  const h = harness({ k: 5, span: 4 }); h.verify();
  const f = h.ticks(1);
  const mk = (fc) => h.ex.place({ symbol: "S", digit: 1, k: 5, contractType: "DIGITMATCH", stake: 1, forecast: fc, mode: "auto" });
  const proposalsBefore = h.sent.filter(m => m.proposal).length;
  const a = mk(f), b = mk(f), c = mk({ ...f, id: "S:5:other" });
  assert.equal(a.ok, true);
  assert.equal(b.ok, false); assert.match(b.reason, /duplicate/);
  assert.equal(c.ok, false); assert.match(c.reason, /open contract limit/);
  assert.equal(h.sent.filter(m => m.proposal).length - proposalsBefore, 1);
  h.respond("proposal", { id: "p", ask_price: 1 }); h.respond("buy", { contract_id: "c9", buy_price: 1 });
  h.ticks(1);
  const f2 = h.ticks(1);
  assert.equal(mk(f2).ok, false);                       // still open
  h.ticks(3);
  h.ex.onContractUpdate({ contract_id: "c9", is_sold: 1, profit: 1 });
  const f3 = h.ticks(1);
  assert.equal(mk(f3).ok, true);                        // slot freed only by settlement
  // other symbols are independent
  const other = h.ex.place({ symbol: "T", digit: 1, k: 5, contractType: "DIGITMATCH", stake: 1, forecast: { ...f3, id: "T:5:1", symbol: "T" }, mode: "probe" });
  assert.equal(other.reason, "stale forecast (newer ticks have arrived)"); // seq of T is 0 != madeAtSeq: guard still checks the right symbol
});

test("a rejected proposal or buy frees the slot; a forecast is still never ordered twice", () => {
  const h = harness({ k: 5, span: 4 }); h.verify();
  const f = h.ticks(1);
  const r = h.ex.place({ symbol: "S", digit: 1, k: 5, contractType: "DIGITMATCH", stake: 1, forecast: f, mode: "auto" });
  h.respond("proposal", null, { message: "nope" });
  assert.equal(r.order.state, "rejected"); assert.equal(h.ex.openCount("S"), 0);
  const again = h.ex.place({ symbol: "S", digit: 1, k: 5, contractType: "DIGITMATCH", stake: 1, forecast: f, mode: "auto" });
  assert.match(again.reason, /duplicate/);
});

test("duplicate and out-of-order contract events settle exactly once and never revive an order", () => {
  const h = harness({ k: 5, span: 4 }); h.verify(4);
  const r = h.run();
  assert.equal(r.update.settled, true);
  const alignBefore = h.alignment.status(KEY()).observed;
  const dup = h.ex.onContractUpdate(r.c);
  assert.equal(dup.duplicate, true);
  const late = h.ex.onContractUpdate({ contract_id: r.cid, is_sold: 0, profit: 5 });
  assert.equal(late.duplicate, true); assert.equal(r.order.state, "settled"); assert.equal(r.order.pnl, 1);
  assert.equal(h.alignment.status(KEY()).observed, alignBefore);
  assert.equal(h.ex.onContractUpdate({ contract_id: "foreign", is_sold: 1, profit: 1 }).handled, false);
  assert.equal(h.ex.risk.VRTC1.pnl, 5);                 // 5 settled wins, counted once each
  // duplicate buy response is ignored
  const h2 = harness({ k: 5, span: 4 });
  const f = h2.ticks(1);
  const { order } = h2.ex.place({ symbol: "S", digit: 1, k: 5, contractType: "DIGITMATCH", stake: 1, forecast: f, mode: "probe" });
  h2.respond("proposal", { id: "p", ask_price: 1 }); const buyMsg = h2.sent.filter(m => m.buy).pop();
  h2.respond("buy", { contract_id: "A", buy_price: 1 });
  h2.ex._onBuy(order, { contract_id: "B", buy_price: 1 }, null);
  assert.equal(order.contractId, "A");
  void buyMsg;
});

test("account integrity: lock blocks Demo<->Real and login changes; change before purchase cancels the buy", () => {
  const h = harness({ k: 5, span: 4 }); h.verify();
  h.ex.lockAccount(h.host.account());
  let f = h.ticks(1);
  const buysBefore = h.sent.filter(m => m.buy).length;
  const ok = h.ex.place({ symbol: "S", digit: 1, k: 5, contractType: "DIGITMATCH", stake: 1, forecast: f, mode: "auto" });
  assert.equal(ok.ok, true);
  h.acct.loginId = "CR9"; h.acct.isVirtual = false;                // user switched to Real mid-flight
  h.respond("proposal", { id: "p", ask_price: 1 });
  assert.equal(ok.order.state, "rejected"); assert.match(ok.order.reason, /account changed/);
  assert.equal(h.sent.filter(m => m.buy).length, buysBefore);
  f = h.ticks(1);
  const blocked = h.ex.place({ symbol: "S", digit: 1, k: 5, contractType: "DIGITMATCH", stake: 1, forecast: f, mode: "auto" });
  assert.equal(blocked.ok, false); assert.match(blocked.reason, /account changed \(armed on VRTC1, now CR9\)/);
  h.acct.loginId = "VRTC2"; h.acct.isVirtual = true;               // different demo login is also a change
  f = h.ticks(1);
  assert.match(h.ex.place({ symbol: "S", digit: 1, k: 5, contractType: "DIGITMATCH", stake: 1, forecast: f, mode: "auto" }).reason, /account changed/);
});

test("risk limits protect the real path: stake cap, daily loss, consecutive losses, kill switch", () => {
  const h = harness({ k: 5, span: 4, limits: { maxStake: 2, dailyLoss: 100, maxConsec: 3 } }); h.verify();
  let f = h.ticks(1);
  const big = h.ex.place({ symbol: "S", digit: 1, k: 5, contractType: "DIGITMATCH", stake: 50, forecast: f, mode: "auto" });
  assert.equal(h.sent.filter(m => m.proposal).pop().amount, 2);
  h.respond("proposal", { id: "p", ask_price: 5 });
  assert.match(big.order.reason, /ask price exceeds max stake/);
  for (let i = 0; i < 3; i++) h.run({ profit: -1 });
  f = h.ticks(1);
  assert.match(h.ex.place({ symbol: "S", digit: 1, k: 5, contractType: "DIGITMATCH", stake: 1, forecast: f, mode: "auto" }).reason, /consecutive losses/);
  h.ex.resume();
  f = h.ticks(1);
  assert.equal(h.ex.place({ symbol: "S", digit: 1, k: 5, contractType: "DIGITMATCH", stake: 1, forecast: f, mode: "auto" }).ok, true);
  h.ex.kill();
  f = h.ticks(1);
  assert.match(h.ex.place({ symbol: "S", digit: 1, k: 5, contractType: "DIGITMATCH", stake: 1, forecast: f, mode: "auto" }).reason, /kill switch/);
  const d = harness({ k: 5, span: 4, limits: { dailyLoss: 3, maxConsec: 99 } }); d.verify(5);
  for (let i = 0; i < 9; i++) d.run({ profit: -1 }); // 5 verification wins (+5) then net -4 <= -3
  f = d.ticks(1);
  assert.match(d.ex.place({ symbol: "S", digit: 1, k: 5, contractType: "DIGITMATCH", stake: 1, forecast: f, mode: "auto" }).reason, /daily loss limit/);
});

test("reconnect: pricing orders are cancelled; an unconfirmed purchase holds the slot, kills auto, and needs reconciliation", () => {
  const h = harness({ k: 5, span: 4 }); h.verify();
  let f = h.ticks(1);
  const a = h.ex.place({ symbol: "S", digit: 1, k: 5, contractType: "DIGITMATCH", stake: 1, forecast: f, mode: "auto" });
  h.ex.onDisconnect();
  assert.equal(a.order.state, "rejected");
  h.ex.resume();
  f = h.ticks(1);
  const b = h.ex.place({ symbol: "S", digit: 1, k: 5, contractType: "DIGITMATCH", stake: 1, forecast: f, mode: "auto" });
  const fB = f;
  h.respond("proposal", { id: "p", ask_price: 1 });
  assert.equal(b.order.state, "buying");
  h.ex.onDisconnect();
  assert.equal(b.order.state, "unknown");
  assert.equal(h.ex.killed, true);
  h.ex.resume(); f = h.ticks(1);
  const c = h.ex.place({ symbol: "S", digit: 1, k: 5, contractType: "DIGITMATCH", stake: 1, forecast: f, mode: "auto" });
  assert.match(c.reason, /open contract limit/);                  // unknown order still occupies the slot
  assert.equal(h.ex.resolveUnknown(b.order.id, null), true);
  assert.equal(h.ex.openCount("S"), 0);
  // the forecast that was ordered before the reconnect can never be ordered again
  h.ticks(0);
  assert.match(h.ex.place({ symbol: "S", digit: 1, k: 5, contractType: "DIGITMATCH", stake: 1, forecast: { ...fB, madeAtSeq: h.engine.state("S").seq }, mode: "auto" }).reason, /duplicate/);
});

test("persistence: ordered forecasts, settled contracts, alignment and unconfirmed orders survive a reload; no credentials", () => {
  const h = harness({ k: 5, span: 4 }); h.verify();
  const f = h.ticks(1);
  const r = h.ex.place({ symbol: "S", digit: 1, k: 5, contractType: "DIGITMATCH", stake: 1, forecast: f, mode: "auto" });
  h.respond("proposal", { id: "p", ask_price: 1 });                 // now 'buying'
  const snap = JSON.parse(JSON.stringify(h.ex.serialize()));
  assert.doesNotMatch(JSON.stringify(snap), /token|bearer|secret|authorize/i);
  const h2 = harness({ k: 5, span: 4 });
  h2.ex.restore(snap);
  assert.equal(h2.alignment.status(KEY()).state, "verified");
  const o = [...h2.ex.orders.values()].find(x => x.id === r.order.id);
  assert.equal(o.state, "unknown"); assert.equal(h2.ex.killed, true);
  assert.equal(h2.ex.orderedForecasts.has(f.id), true);
  h2.ex.resume();
  const f2 = { ...f, madeAtSeq: h2.engine.state("S").seq };
  assert.match(h2.ex.place({ symbol: "S", digit: 1, k: 5, contractType: "DIGITMATCH", stake: 1, forecast: f2, mode: "auto" }).reason, /duplicate/);
  // settled contract replayed after reload is not applied twice
  const done = harness({ k: 5, span: 4 }); done.verify(); const last = done.run({ mode: "probe" });
  const s2 = JSON.parse(JSON.stringify(done.ex.serialize()));
  const rl = harness({ k: 5, span: 4 }); rl.ex.restore(s2);
  const before = rl.ex.risk.VRTC1.pnl;
  assert.equal(rl.ex.onContractUpdate(last.c).duplicate, true);
  assert.equal(rl.ex.risk.VRTC1.pnl, before);
});
