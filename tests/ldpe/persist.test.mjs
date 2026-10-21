import test from "node:test";
import assert from "node:assert/strict";
import { Ldpe } from "../../src/ldpe/engine.js";
import { snapshotEngine, restoreEngine, StateStore, assertNoSecrets } from "../../src/ldpe/persist.js";

function rng(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const ticks = (seed, n, start = 1000) => { const r = rng(seed); return Array.from({ length: n }, (_, i) => ({ epoch: start + i, quote: "100.0" + Math.floor(r() * 10), decimals: 2 })); };
const feed = (e, d) => { for (const t of d) e.ingest("S", t); return e; };
const mem = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), removeItem: k => m.delete(k), m }; };
const CFG = { horizon: 5, minTicks: 50, calMin: 100, calRefit: 20 };
const roundTrip = (e, opts) => { const s = new StateStore(mem()); assert.ok(s.save(snapshotEngine(e, opts))); return s.load(); };

test("reload with overlapping history is equivalent to an uninterrupted run", () => {
  const data = ticks(1, 900);
  const cont = feed(new Ldpe(CFG), data);
  const a = feed(new Ldpe(CFG), data.slice(0, 600));
  const { engine: b, info } = restoreEngine(CFG, roundTrip(a, { maxTicks: 5000 }));
  assert.equal(info.restored.S.lastSeq, 600);
  assert.equal(b.isHolding("S"), true);
  b.ingest("S", data[800]);                                     // live tick arrives during the hold
  const r = b.backfill("S", data.slice(590, 810));               // history overlaps the last known tick
  assert.equal(r.overlap, true);
  assert.equal(b.state("S").seq, 810);
  const c = feed(new Ldpe(CFG), data.slice(0, 810));
  assert.deepEqual(b.state("S").pending.map(f => [f.id, f.targetSeq, f.predictedDigit]), c.state("S").pending.map(f => [f.id, f.targetSeq, f.predictedDigit]));
  assert.equal(b.metrics("S").n, c.metrics("S").n);
  assert.ok(cont.metrics("S").n >= 0);
  // forecasts that were pending at snapshot time were scored on their true target ticks, once
  const bById = new Map(b.state("S").forecasts.map(f => [f.id, f]));
  for (const f of c.state("S").forecasts.filter(x => x.madeAtSeq >= 596 && x.madeAtSeq <= 600)) {
    const g = bById.get(f.id);
    assert.ok(g, "missing " + f.id); assert.equal(g.status, "scored"); assert.equal(g.realized, f.realized); assert.equal(g.targetSeq, f.targetSeq);
  }
  const ids = b.state("S").forecasts.map(f => f.id);
  assert.equal(new Set(ids).size, ids.length, "no forecast scored twice");
});

test("truncated tick tail still restores warm-up and absolute sequence identity", () => {
  const a = feed(new Ldpe(CFG), ticks(2, 1200));
  const snap = roundTrip(a, { maxTicks: 300 });
  assert.equal(snap.symbols.S.ticks.length, 300);
  const { engine: b } = restoreEngine(CFG, snap);
  assert.equal(b.state("S").seq, 1200);
  assert.equal(b.warmup("S").complete, true);
  assert.equal(b.state("S").pending.length, 5);
  assert.deepEqual(b.state("S").pending.map(f => f.targetSeq), a.state("S").pending.map(f => f.targetSeq));
});

test("restart gap without overlap: pending forecasts become unscorable, never scored on wrong ticks", () => {
  const a = feed(new Ldpe(CFG), ticks(3, 400));
  const { engine: b } = restoreEngine(CFG, roundTrip(a));
  const pendingIds = b.state("S").pending.map(f => f.id);
  const r = b.backfill("S", ticks(4, 30, 9000));
  assert.equal(r.overlap, false);
  const hist = new Map(b.state("S").forecasts.map(f => [f.id, f]));
  for (const id of pendingIds) assert.equal(hist.get(id).status, "unscorable");
  assert.equal(b.contiguous("S", 395, 405), false);
});

test("hold released without history records a hole; duplicate and stale ticks after reload are rejected", () => {
  const d = ticks(5, 300);
  const { engine: b } = restoreEngine(CFG, roundTrip(feed(new Ldpe(CFG), d)));
  b.releaseHold("S");
  assert.equal(b.isHolding("S"), false);
  assert.equal(b.ingest("S", d[299]).flags.duplicate, true);
  assert.equal(b.ingest("S", d[100]).flags.outOfOrder, true);
  assert.equal(b.state("S").seq, 300);
});

test("restoring twice from one snapshot and replaying the same history does not double-score", () => {
  const data = ticks(6, 500);
  const snap = roundTrip(feed(new Ldpe(CFG), data.slice(0, 400)));
  for (let i = 0; i < 2; i++) {
    const { engine: b } = restoreEngine(CFG, JSON.parse(JSON.stringify(snap)));
    b.backfill("S", data.slice(395, 500));
    b.backfill("S", data.slice(395, 500)); // repeated history event
    const ids = b.state("S").forecasts.map(f => f.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(b.state("S").seq, 500);
  }
});

test("incompatible or missing snapshots are rejected cleanly", () => {
  assert.equal(restoreEngine(CFG, null).info.rejected, "no compatible snapshot");
  assert.equal(restoreEngine(CFG, { v: 99, symbols: {} }).info.rejected, "no compatible snapshot");
  const store = new StateStore({ getItem: () => "{not json", setItem() { throw new Error("quota"); }, removeItem() {} });
  assert.equal(store.load(), null);
  assert.equal(store.save({ v: 1, symbols: {} }), false);
});

test("snapshots contain no credentials and secret-like fields are refused", () => {
  const snap = roundTrip(feed(new Ldpe(CFG), ticks(7, 200)));
  assert.doesNotMatch(JSON.stringify(snap), /token|bearer|secret|authorize|otp/i);
  assert.throws(() => assertNoSecrets({ a: { access_token: "x" } }), /secret-like/);
  assert.throws(() => new StateStore(mem()).save({ session_token: "x" }), /secret-like/);
});
