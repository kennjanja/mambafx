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
function warmThenArm(p){ p.host.digAutoArmed = false; p.tick(130); p.L.engine.cfg.minProbability = 0.0001; }
async function page({ storage = new Storage(), demo = true, armed = false, select, mode = "forecast" } = {}) {
  const sent = [], pending = {}, selected = [], noted = [];
  let reqId = 9000;
  globalThis.WebSocket = { OPEN: 1 };
  const ws = { readyState: 1, send: (s) => sent.push(JSON.parse(s)) };
  const hostObj = {
    gridAuthed: true, gridWs: ws, gridIsVirtual: demo, gridLoginId: demo ? "VRTC1" : "CR1", gridCurrency: "USD",
    digAutoArmed: armed, digTrades: [], openContracts: {}, symbol: "S",
    nextReqId: () => ++reqId, awaitReq: (id, cb) => { pending[id] = cb; }, renderTrades() {}, disarm() {},
    placeTrade: () => false,
    autoSettings: () => ({ cooldown: 0, max: 0, count: 0 }),
    noteAutoOrder: () => noted.push(1),
    selectAccountType: async (t) => { selected.push(t); return select ? select(t) : { ok: true }; },
  };
  const win = { __ldpeHost: hostObj, addEventListener() {} };
  globalThis.window = win; globalThis.localStorage = storage;
  globalThis.document = { getElementById: () => null, addEventListener() {}, readyState: "complete", visibilityState: "visible" };
  await import(`../../src/ldpe/bridge.js?inst=${++n}`);
  const L = win.LDPE; L.settings.executionMode = mode;
  const rng = mulberry32(7 + n);
  let epoch = 1_700_000_000;
  return {
    L, host: hostObj, sent, pending, storage, selected, noted,
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
}

const L_WARM = 130;

test("bridge loads, ingests and exposes Tier 1 diagnostics from the live service", async () => {
  const p = await page();
  p.tick(L_WARM);
  const e = p.L.engine;
  assert.ok(e.state("S").seq >= L_WARM);
  assert.ok(e.mutualInfo("S").status);
  assert.ok(e.calibrationStatus("S").needed > 0);
  assert.ok("active" in e.breakStatus("S"));
  assert.equal(e.conditionalStats("S").gaps.length, 10);
});

test("settings: only user trade controls remain; removed rule keys are not persisted", async () => {
  const storage = new Storage();
  storage.setItem("ldpe_settings_v1", JSON.stringify({ k: 5, dailyLoss: 5, maxConsec: 3, maxStake: 2, probeCount: 5 }));
  const p = await page({ storage });
  for (const key of ["dailyLoss", "maxConsec", "maxStake", "probeCount"]) assert.ok(!(key in p.L.settings), key);
  assert.equal(p.L.settings.stake, 2, "legacy maxStake migrates to the stake setting");
  p.L.setSetting("stake", 1.5);
  const saved = JSON.parse(storage.getItem("ldpe_settings_v1"));
  assert.equal(saved.stake, 1.5);
  assert.ok(!("dailyLoss" in saved) && !("maxConsec" in saved));
});

test("auto trading sends orders through the executor on the selected Demo account", async () => {
  const p = await page({ armed: true });
  p.tick(L_WARM);
  p.L.engine.cfg.minProbability = 0.0001;
  p.tick(30);
  assert.ok(p.sent.filter(m => m.proposal).length >= 1);
  assert.ok([...p.L.executor.orders.values()].every(o => o.isVirtual === true));
  assert.ok(p.noted.length >= 1);
});

test("Stop switch halts automatic orders while forecasts continue to be scored; toggle re-arms", async () => {
  const p = await page({ armed: true });
  warmThenArm(p); p.host.digAutoArmed = true;
  p.L.setStopped(true);
  const scoredBefore = p.L.engine.state("S").forecasts.filter(f => f.status === "scored").length;
  p.tick(40);
  assert.equal(p.sent.filter(m => m.proposal).length, 0);
  assert.ok(p.L.engine.state("S").forecasts.filter(f => f.status === "scored").length > scoredBefore);
  assert.equal(JSON.parse(p.storage.getItem("ldpe_settings_v1")).stopped, true);
  p.L.toggleStop();
  assert.equal(p.L.executor.stopped, false);
  p.tick(30);
  assert.ok(p.sent.filter(m => m.proposal).length >= 1);
});

test("user cooldown and stop-after-N are honoured as ordinary settings", async () => {
  const p = await page({ armed: true });
  warmThenArm(p); p.host.digAutoArmed = true;
  p.host.autoSettings = () => ({ cooldown: 0, max: 1, count: 1 });
  p.tick(20);
  assert.equal(p.sent.filter(m => m.proposal).length, 0);
});

test("Demo | Real switch: Real routes to the page's account flow; a failed switch never falls back", async () => {
  const p = await page({ demo: true, select: (t) => (t === "real" ? { ok: false, error: "no real account on this Deriv login" } : { ok: true }) });
  await p.L.setAccountType("real");
  assert.deepEqual(p.selected, ["real"]);
  assert.equal(p.L.executor.accountType, "real");
  assert.equal(p.L.settings.accountType, "real");
  p.host.digAutoArmed = true;
  p.tick(L_WARM);
  p.L.engine.cfg.minProbability = 0.0001;
  p.tick(30);
  assert.equal(p.sent.filter(m => m.proposal).length, 0, "still connected as Demo: no order on Demo");
  assert.match(p.L.executor.log.join("|"), /Real account selected, but the connected account is Demo/);
  await p.L.setAccountType("demo");
  assert.deepEqual(p.selected, ["real", "demo"]);
});

test("Demo | Real switch persists across reload; Real trades only when connected as Real", async () => {
  const storage = new Storage();
  const a = await page({ storage, demo: false });
  await a.L.setAccountType("real");
  const b = await page({ storage, demo: false, armed: true });
  assert.equal(b.L.executor.accountType, "real");
  b.tick(L_WARM); b.L.engine.cfg.minProbability = 0.0001; b.tick(30);
  const o = [...b.L.executor.orders.values()];
  assert.ok(o.length >= 1); assert.ok(o.every(x => x.isVirtual === false && x.accountId === "CR1"));
});

test("a settlement update is applied once; duplicates are ignored", async () => {
  const p = await page({ armed: true });
  p.tick(L_WARM); p.L.engine.cfg.minProbability = 0.0001;
  let order;
  for (let i = 0; i < 30 && !order; i++) { p.tick(1); order = [...p.L.executor.orders.values()].find(o => o.state === "pricing"); }
  assert.ok(order);
  p.respond("proposal", { id: "p", ask_price: 0.35 });
  p.respond("buy", { contract_id: "D1", buy_price: 0.35, purchase_time: p.epochNow() });
  const upd = { contract_id: "D1", is_sold: 1, profit: 1 };
  assert.equal(p.L.onContractUpdate(upd).settled, true);
  assert.equal(p.L.onContractUpdate(upd).duplicate, true);
});

test("transition statistics are still computed and persisted while the matrix panel is hidden", async () => {
  const storage = new Storage();
  const p = await page({ storage });
  p.tick(L_WARM);
  const st = p.L.engine.state("S");
  assert.ok(st.trans1 && st.trans2, "engine keeps first/second order transition counts");
  const total = (m) => JSON.stringify(m).match(/\d+(\.\d+)?/g).reduce((s, x) => s + Number(x), 0);
  assert.ok(total(st.trans1) > 0);
  p.L.saveState(true);
  assert.match([...storage.m.values()].join(""), /trans1/);
  const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  assert.match(html, /Transition matrix: hidden from the UI[\s\S]{0,200}display:none/);
  assert.match(html, /id="digTmBody"/);
  assert.match(html, /digTransitions\[/);
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
  b.L.backfill("S", prices, times, 2);
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

test("reconnect: an order in flight is never silently resent", async () => {
  const p = await page({ armed: true });
  warmThenArm(p); p.host.digAutoArmed = true;
  let order;
  for (let i = 0; i < 30 && !order; i++) { p.tick(1); order = [...p.L.executor.orders.values()].find(o => o.state === "pricing"); }
  p.respond("proposal", { id: "p", ask_price: 0.35 });
  assert.equal(order.state, "buying");
  const buys = p.sent.filter(m => m.buy).length;
  p.L.onDisconnect();
  assert.equal(order.state, "unknown");
  p.tick(5);
  assert.equal(p.sent.filter(m => m.buy).length, buys);
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

test("panel: Demo/Real and Stop controls exist; removed controls and rules do not appear in UI or bridge", () => {
  const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  const bridge = readFileSync(new URL("../../src/ldpe/bridge.js", import.meta.url), "utf8");
  for (const id of ["ldpeAcctDemo", "ldpeAcctReal", "ldpeStop"]) { assert.ok(html.includes(`id="${id}"`), id); assert.ok(bridge.includes(id), id); }
  const start = html.indexOf('id="ldpeCard"');
  const all = html.slice(start, start + 6000) + bridge;
  assert.ok(!/KILL SWITCH|ldpeKill|ldpeResume|ldpeProbe|ldpeAlign|Settlement alignment|settlement probe|provisional|unverified|daily loss|consecutive loss|open contracts/i.test(all));
});

test("panel hides LDPE explanatory and diagnostics text while retaining the forecast display and calculations", () => {
  const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  const bridge = readFileSync(new URL("../../src/ldpe/bridge.js", import.meta.url), "utf8");
  const card = html.slice(html.indexOf('id="ldpeCard"'), html.indexOf('id="ldpeCard"') + 6000);
  assert.match(card, /class="dig-sub" hidden aria-hidden="true"/);
  for (const id of ["ldpeFeed", "ldpePred", "ldpeDist", "ldpeMetrics", "ldpeDiag"]) {
    assert.match(card, new RegExp(`<div id="${id}"[^>]*(?:display:none|hidden)[^>]*>`), id);
  }
  assert.match(card, /<details hidden aria-hidden="true"><summary>Execution log/);
  assert.match(html, /<div class="dig-card" hidden aria-hidden="true">\s*<h2>Digit statistics<\/h2>/);
  assert.match(html, /id="digForecastBox"/);
  assert.match(html, /id="digCircleGrid"/);
  assert.match(bridge, /engine\.mutualInfo\(sym\)/);
  assert.match(bridge, /engine\.metrics\(sym, engine\.cfg\.horizon\)/);
  assert.match(bridge, /engine\.conditionalStats\(sym\)/);
});

test("auto orders use the Trade execution card's stake/multiplier progression when the host provides it", async () => {
  const p = await page({ armed: true });
  p.host.nextStake = () => 1.4;
  p.tick(L_WARM);
  p.L.engine.cfg.minProbability = 0.0001;
  p.tick(30);
  const props = p.sent.filter(m => m.proposal);
  assert.ok(props.length >= 1);
  assert.ok(props.every(m => m.amount === 1.4));
});

test("Digits page layout: distribution, then trade execution, then frequency table; extra stats hidden; new controls present", () => {
  const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  const page = html.slice(html.indexOf('id="page-digits"'));
  const iDist = page.indexOf("Digit Distribution"), iExec = page.indexOf("Trade execution"), iFreq = page.indexOf("Digit frequency table");
  assert.ok(iDist > 0 && iDist < iExec && iExec < iFreq);
  assert.ok(!page.includes("Frequency of each digit over the last 1,000 ticks"));
  for (const id of ["digChi", "digPval", "digEntropy"]) {
    assert.match(page, new RegExp(`<div class="dig-stat" hidden style="display:none"><div class="lab">[^<]*</div><div id="${id}"`), id);
  }
  for (const id of ["digStake", "digMultiplier", "digMultN", "digManualBtns", "digAutoThresh", "digAutoCooldown", "digAutoMax", "digAutoArm", "digSessionPnl", "digPnlReset"]) {
    assert.ok(page.indexOf(`id="${id}"`) > iExec && page.indexOf(`id="${id}"`) < iFreq, id);
  }
  assert.match(page, /Automated Match/);
  assert.match(html, /function digResetSessionPnl\(\)/);
  assert.match(html, /nextStake: \(\) =>/);
});
test("auto-order stake is rounded to at most 2 decimals before the proposal is sent", async () => {
  const p = await page({ armed: true });
  p.host.nextStake = () => 5.832;
  p.tick(L_WARM);
  p.L.engine.cfg.minProbability = 0.0001;
  p.tick(30);
  const props = p.sent.filter(m => m.proposal);
  assert.ok(props.length >= 1);
  assert.ok(props.every(m => m.amount === 5.83));
});

test("multiplier inputs use one decimal and the stake progression is rounded to cents", () => {
  const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  assert.match(html, /id="digMultN" min="1" max="10" step="0\.1"/);
  assert.match(html, /Math\.round\(n \* 10\) \/ 10/);
  assert.match(html, /function nextStake\(strat\)\{ return Math\.round\(rawNext\(strat\)\*100\)\/100; \}/);
});
test("cycle mode (default): one proposal per non-target tick through the executor, Demo/Real selected account, Stop halts", async () => {
  for (const demo of [true, false]) {
    const p = await page({ armed: true, demo, mode: "cycle" });
    p.L.executor.setAccountType(demo ? "demo" : "real");
    p.tick(L_WARM);
    p.L.engine.cfg.minProbability = 0.0001;
    p.tick(40);
    const props = p.sent.filter(m => m.proposal);
    const orders = [...p.L.executor.orders.values()];
    assert.ok(props.length >= 1);
    assert.ok(orders.every(o => o.isVirtual === demo && o.mode === "cycle"));
    const keys = orders.map(o => o.intent.key);
    assert.equal(new Set(keys).size, keys.length);
    assert.ok(orders.every(o => o.intent.tickDigit !== o.digit));
    p.L.executor.setStopped(true);
    const n = p.sent.filter(m => m.proposal).length;
    p.tick(10);
    assert.equal(p.sent.filter(m => m.proposal).length, n);
  }
});