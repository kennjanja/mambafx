// Page-bridge integration tests: the real bridge.js + exec.js + engine.js + persist.js against a fake page host.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (...a) => { const t = realSetInterval(...a); t.unref && t.unref(); return t; };
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (...a) => { const t = realSetTimeout(...a); t.unref && t.unref(); return t; };

function mulberry32(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

class Storage { constructor() { this.m = new Map(); } getItem(k) { return this.m.has(k) ? this.m.get(k) : null; } setItem(k, v) { this.m.set(k, String(v)); } removeItem(k) { this.m.delete(k); } }

let n = 0;
async function page({ storage = new Storage(), demo = true, armed = false } = {}) {
  const sent = [], pending = {};
  let reqId = 9000;
  globalThis.WebSocket = { OPEN: 1 };
  const ws = { readyState: 1, send: (s) => sent.push(JSON.parse(s)) };
  const hostObj = {
    gridAuthed: true, gridWs: ws, gridIsVirtual: demo, gridLoginId: demo ? "VRTC1" : "CR1", gridCurrency: "USD",
    digAutoArmed: armed, digTrades: [], openContracts: {}, symbol: "S",
    nextReqId: () => ++reqId, awaitReq: (id, cb) => { pending[id] = cb; }, renderTrades() {}, disarm() {},
    placeTrade: () => false,
  };
  const win = { __ldpeHost: hostObj, addEventListener() {} };
  globalThis.window = win; globalThis.localStorage = storage;
  globalThis.document = { getElementById: () => null, addEventListener() {}, readyState: "complete", visibilityState: "visible" };
  const mod = await import(`../../src/ldpe/bridge.js?inst=${++n}`);
  const L = win.LDPE;
  const rng = mulberry32(7 + n);
  let epoch = 1_700_000_000, seq = 0;
  const api = {
    L, host: hostObj, sent, pending, storage,
    tick(count = 1) {
      for (let i = 0; i < count; i++) { epoch++; const q = (1000 + Math.floor(rng() * 100000) / 100).toFixed(2); L.ingest("S", q, 2, epoch); }
    },
    epochNow: () => epoch,
    respond(kind, body) {
      const idx = [...sent].map((m, i) => [m, i]).reverse().find(([m]) => m[kind] !== undefined);
      assert.ok(idx, "no " + kind + " message sent");
      const m = idx[0]; const cb = pending[m.req_id]; assert.ok(cb); delete pending[m.req_id]; cb(body, null);
    },
  };
  return api;
}

async function warm(p) { p.tick(L_WARM); }
const L_WARM = 130;

test("bridge loads, ingests and exposes Tier 1 diagnostics from the live service", async () => {
  const p = await page();
  p.tick(L_WARM);
  const e = p.L.engine;
  assert.ok(e.state("S").seq >= L_WARM);
  assert.ok(e.mutualInfo("S").status);
  assert.ok(e.calibrationStatus("S").needed > 0);
  assert.ok("active" in e.breakStatus("S"));
  const cs = e.conditionalStats("S");
  assert.equal(cs.gaps.length, 10);
});

test("auto execution is blocked while settlement alignment is unresolved (no proposal is ever sent)", async () => {
  const p = await page({ armed: true });
  p.tick(L_WARM);
  // force TRADE decisions so only the alignment gate can stop the order
  p.L.engine.cfg.minProbability = 0.0001;
  p.tick(30);
  assert.equal(p.sent.filter(m => m.proposal).length, 0);
  assert.equal(p.L.alignmentStatus("S").state, "unresolved");
  assert.match(p.L.executor.log.join("|"), /alignment unresolved/);
});

test("probe is Demo-only: a Real account is refused before any message", async () => {
  const p = await page({ demo: false });
  p.tick(L_WARM);
  p.L.startProbe();
  p.tick(5);
  assert.equal(p.sent.filter(m => m.proposal).length, 0);
});

test("Demo probe: only the executor places orders, one open per symbol, and 5 clean aligned contracts verify the config", async () => {
  const p = await page();
  p.tick(L_WARM);
  const K = p.L.settings.k;
  p.L.settings.probeCount = 5; p.L.startProbe();
  const verifyOne = () => {
    p.tick(1);                                                    // fresh forecast
    const f = p.L.latestFor("S");
    const before = p.sent.filter(m => m.proposal).length;
    // the probe was sent synchronously on the tick; answer it before another tick arrives
    const props = p.sent.filter(m => m.proposal);
    assert.equal(props.length, before);
    return f;
  };
  let settled = 0;
  for (let attempt = 0; attempt < 40 && settled < 5; attempt++) {
    p.tick(1);
    const f = p.L.latestFor("S");
    const proposals = p.sent.filter(m => m.proposal);
    const last = proposals[proposals.length - 1];
    if (!last || p.L.executor.openCount("S") !== 1) continue;
    const order = [...p.L.executor.orders.values()].find(o => o.state === "pricing");
    if (!order) continue;
    assert.equal(order.isVirtual, true); assert.equal(order.mode, "probe");
    p.respond("proposal", { id: "p" + attempt, ask_price: 0.35 });
    p.respond("buy", { contract_id: "C" + attempt, buy_price: 0.35, purchase_time: p.epochNow() });
    // a second concurrent attempt on the same symbol must be refused by the executor
    const second = p.L.executor.place({ symbol: "S", digit: 1, k: K, contractType: "DIGITMATCH", stake: 0.35, forecast: { ...f, id: f.id + "x" }, mode: "probe" });
    assert.equal(second.ok, false);
    // contract: entry = next tick, exit = entry + (K-1) ticks (the hypothesis the ledger measures)
    const entryEpoch = p.epochNow() + 1, exitEpoch = entryEpoch + (K - 1);
    p.tick(K);
    p.L.onContractUpdate({ contract_id: "C" + attempt, purchase_time: p.epochNow() - K, entry_tick_time: entryEpoch, exit_tick_time: exitEpoch, is_sold: 1, profit: -0.35 });
    settled++;
  }
  assert.equal(settled, 5, p.L.executor.log.slice(-4).join(" | ") + " ids:" + [...p.L.executor.orderedForecasts].join(",") + " now:" + p.L.latestFor("S").id);
  const st = p.L.alignmentStatus("S");
  assert.equal(st.state, "verified", JSON.stringify(st));
  assert.equal(st.horizon, K);
});

test("a settlement update that arrives before the exit tick is deferred, then evaluated exactly once", async () => {
  const p = await page();
  p.tick(L_WARM);
  p.L.startProbe();
  let order;
  for (let i = 0; i < 20 && !order; i++) { p.tick(1); order = [...p.L.executor.orders.values()].find(o => o.state === "pricing"); }
  assert.ok(order);
  p.respond("proposal", { id: "p", ask_price: 0.35 });
  p.respond("buy", { contract_id: "D1", buy_price: 0.35, purchase_time: p.epochNow() });
  const K = p.L.settings.k, entry = p.epochNow() + 1, exit = entry + K - 1;
  p.tick(K - 1);                                                  // exit tick not here yet
  const upd = { contract_id: "D1", purchase_time: p.epochNow() - K + 1, entry_tick_time: entry, exit_tick_time: exit, is_sold: 1, profit: 1 };
  p.L.onContractUpdate(upd);
  assert.equal(order.alignment, null);
  p.tick(1);                                                      // exit tick arrives
  assert.ok(order.alignment && order.alignment.resolved, JSON.stringify(order.alignment));
  const cfg = p.L.alignment.cfgs[`DIGITMATCH|${K}|S`];
  p.L.onContractUpdate(upd);                                      // duplicate event
  p.tick(3);
  assert.equal(cfg.evidence.length, 1);
});

test("persistence: reload restores ticks, warm-up and pending forecasts and holds live ticks for backfill", async () => {
  const storage = new Storage();
  const a = await page({ storage });
  a.tick(L_WARM);
  a.L.saveState(true);
  const seqA = a.L.engine.state("S").seq, pendA = a.L.engine.state("S").pending.length;
  const b = await page({ storage });
  const st = b.L.engine.state("S");
  assert.equal(st.seq, seqA);
  assert.equal(st.pending.length, pendA);
  assert.equal(b.L.engine.warmup("S").complete, true);
  assert.equal(b.L.engine.isHolding("S"), true);
  const raw = [...storage.m.values()].join("");
  assert.ok(!/token|authorize|bearer/i.test(raw), "no credentials in browser storage");
});

test("backfill after reload scores pending forecasts on real intermediate ticks, exactly once, with overlap proof", async () => {
  const storage = new Storage();
  const a = await page({ storage });
  a.tick(L_WARM);
  a.L.saveState(true);
  const lastEpoch = a.L.engine.state("S").lastEpoch;
  const pend = a.L.engine.state("S").pending.map(f => f.id);
  assert.ok(pend.length > 0);
  const b = await page({ storage });
  const prices = [], times = [];
  const stA = a.L.engine.state("S");
  for (const t of stA.ticks.slice(-5)) { prices.push(Number(t.quote)); times.push(t.epoch); }
  for (let i = 1; i <= 10; i++) { prices.push(1000 + i * 1.11); times.push(lastEpoch + i); }
  const r = b.L.backfill("S", prices, times, 2);
  assert.equal(r.overlap, true); assert.equal(r.ingested, 10);
  const stB = b.L.engine.state("S");
  assert.equal(stB.pending.every(f => !pend.includes(f.id)), true);
  const ids = stB.forecasts.filter(f => pend.includes(f.id));
  assert.equal(ids.length, new Set(ids.map(f => f.id)).size);
  assert.ok(ids.every(f => f.status === "scored"));
  b.L.backfill("S", prices, times, 2);                           // duplicate history: nothing re-scored
  assert.equal(b.L.engine.state("S").forecasts.filter(f => pend.includes(f.id)).length, ids.length);
});

test("history with no overlap records a hole and marks pending forecasts unscorable", async () => {
  const storage = new Storage();
  const a = await page({ storage }); a.tick(L_WARM); a.L.saveState(true);
  const lastEpoch = a.L.engine.state("S").lastEpoch;
  const b = await page({ storage });
  const r = b.L.backfill("S", [1, 2, 3], [lastEpoch + 500, lastEpoch + 501, lastEpoch + 502], 2);
  assert.equal(r.overlap, false);
  assert.ok(b.L.engine.state("S").forecasts.some(f => f.status === "unscorable"));
});

test("reconnect: an order in flight is never silently resent; the kill switch engages for unconfirmed purchases", async () => {
  const p = await page();
  p.tick(L_WARM);
  p.L.startProbe();
  let order;
  for (let i = 0; i < 20 && !order; i++) { p.tick(1); order = [...p.L.executor.orders.values()].find(o => o.state === "pricing"); }
  p.respond("proposal", { id: "p", ask_price: 0.35 });
  assert.equal(order.state, "buying");
  const buys = p.sent.filter(m => m.buy).length;
  p.L.onDisconnect();
  assert.equal(order.state, "unknown");
  assert.equal(p.L.executor.killed, true);
  p.tick(5);
  assert.equal(p.sent.filter(m => m.buy).length, buys);
  assert.equal(p.sent.filter(m => m.proposal).length, 1);
});

test("page wiring: digPlaceTrade refuses LDPE orders and the host exposes no second order path", () => {
  const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  assert.match(html, /function digPlaceTrade\(digit, source, opts\)\{\s*opts = opts \|\| \{\};\s*\/\/ LDPE orders must go through exec\.js[\s\S]{0,200}source === "ldpe" \|\| opts\.forecast\)\{[\s\S]{0,200}return false;/);
  assert.match(html, /placeTrade: \(\) => false/);
  assert.ok(!/digPlaceTrade\([^)]*"ldpe"/.test(html.replace(/source === "ldpe"/g, "")), "nothing calls digPlaceTrade with source ldpe");
  const bridge = readFileSync(new URL("../../src/ldpe/bridge.js", import.meta.url), "utf8");
  assert.ok(!/placeTrade\(/.test(bridge), "bridge never calls the page's order function");
  assert.match(html, /window\.LDPE\.onContractUpdate\(c\)/);
  assert.match(html, /window\.LDPE\.onDisconnect\(\)/);
  assert.match(html, /window\.LDPE\.backfill\(/);
});
