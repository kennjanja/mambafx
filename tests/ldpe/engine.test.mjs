import test from "node:test";
import assert from "node:assert/strict";
import { Ldpe, extractDigit, projectWeights, validVector, LN10 } from "../../src/ldpe/engine.js";

function rng(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }
function stream(seed, n, pick, start = 1000) {
  const r = rng(seed), out = [];
  for (let i = 0; i < n; i++) out.push({ epoch: start + i, quote: "100.0" + (pick ? pick(r) : Math.floor(r() * 10)), decimals: 2 });
  return out;
}
const lastDigit = (t) => Number(t.quote.slice(-1));

test("digit extraction keeps trailing zeros and rejects bad input", () => {
  assert.equal(extractDigit("12345.60", 2), 0);
  assert.equal(extractDigit("12345.6", 1), 6);
  assert.equal(extractDigit("12345.6", 2), null);
  assert.equal(extractDigit("57", 0), 7);
  assert.equal(extractDigit("1e-7", 7), null);
  assert.equal(extractDigit("abc", 2), null);
  assert.equal(extractDigit(null, 2), null);
  assert.equal(extractDigit("1.239", undefined), 9);
});

test("data quality: duplicate epochs dropped, same-quote new epoch kept, out-of-order rejected", () => {
  const e = new Ldpe({ minTicks: 5 });
  assert.equal(e.ingest("S", { epoch: 1, quote: "1.50", decimals: 2 }).accepted, true);
  assert.equal(e.ingest("S", { epoch: 1, quote: "1.51", decimals: 2 }).flags.duplicate, true);
  assert.equal(e.ingest("S", { epoch: 2, quote: "1.50", decimals: 2 }).accepted, true);
  assert.equal(e.ingest("S", { epoch: 1, quote: "1.50", decimals: 2 }).flags.outOfOrder, true);
  assert.equal(e.ingest("S", { epoch: 3, quote: "1.5", decimals: 2 }).flags.precisionMismatch, true);
  assert.equal(e.state("S").seq, 2);
  assert.equal(e.state("S").counts[0], 2);
});

test("warm-up blocks TRADE and cold start gives a valid distribution", () => {
  const e = new Ldpe({ minTicks: 50, minProbability: 0 });
  let f;
  for (const t of stream(1, 10)) f = e.ingest("S", t).forecast;
  assert.equal(f.decision, "SKIP"); assert.equal(f.reason, "warming up");
  assert.ok(validVector(f.vectors.ensemble));
  assert.equal(e.warmup("S").remaining, 40);
  const e2 = new Ldpe({ minTicks: 1 });
  assert.ok(validVector(e2.ingest("S", { epoch: 1, quote: "1.23", decimals: 2 }).forecast.vectors.ensemble));
});

test("every forecast is scored exactly once at its own target tick", () => {
  const e = new Ldpe({ horizon: 3, minTicks: 10 });
  const data = stream(7, 300);
  for (const t of data) e.ingest("S", t);
  const st = e.state("S"), seen = new Set();
  for (const f of st.forecasts) {
    assert.equal(f.status, "scored");
    assert.ok(!seen.has(f.id)); seen.add(f.id);
    assert.equal(f.targetSeq, f.madeAtSeq + 3);
    assert.equal(f.realized, lastDigit(data[f.targetSeq - 1]));
  }
  assert.equal(st.forecasts.length, 297);
  assert.equal(st.pending.length, 3);
  assert.equal(e.metrics("S").n, 297);
});

test("no look-ahead: forecasts depend only on the prefix; replay is identical", () => {
  const a = stream(11, 400), b = a.slice(0, 250).concat(stream(99, 150, null, 1250));
  const ra = Ldpe.replay({ minTicks: 20 }, "S", a).forecasts, rb = Ldpe.replay({ minTicks: 20 }, "S", b).forecasts;
  for (let i = 0; i < 250; i++) assert.deepEqual(ra[i].vectors.ensemble, rb[i].vectors.ensemble);
  const rc = Ldpe.replay({ minTicks: 20 }, "S", a).forecasts;
  assert.deepEqual(ra.map(f => f.vectors.ensemble), rc.map(f => f.vectors.ensemble));
  assert.deepEqual(ra.map(f => f.stateVersion), rc.map(f => f.stateVersion));
});

test("discontinuity marks pending forecasts unscorable, never scored", () => {
  const e = new Ldpe({ horizon: 5, minTicks: 5 });
  for (const t of stream(3, 20)) e.ingest("S", t);
  const before = e.metrics("S").n;
  e.markDiscontinuity("S");
  assert.equal(e.state("S").forecasts.filter(f => f.status === "unscorable").length, 5);
  for (const t of stream(4, 20, null, 5000)) e.ingest("S", t);
  assert.equal(e.state("S").forecasts.filter(f => f.status === "unscorable").length, 5);
  assert.ok(e.metrics("S").n > before);
});

test("symbols keep independent state", () => {
  const e = new Ldpe({ minTicks: 5 });
  for (const t of stream(1, 50)) e.ingest("A", t);
  assert.equal(e.state("B").seq, 0);
  assert.equal(e.warmup("B").remaining, 5);
});

test("weights respect floor/cap/sum; infeasible bounds raise", () => {
  const w = projectWeights([0.9, 0.05, 0.03, 0.02], 0.01, 0.6);
  assert.ok(Math.abs(w.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  assert.ok(w.every(x => x >= 0.01 - 1e-12 && x <= 0.6 + 1e-12));
  assert.throws(() => projectWeights([0.5, 0.5], 0.01, 0.3), /infeasible/);
  assert.throws(() => projectWeights([0.5, 0.5], 0.7, 0.9), /infeasible/);
});

test("ensemble and weights stay valid through a long run", () => {
  const e = new Ldpe({ minTicks: 20 });
  for (const t of stream(5, 1500)) {
    const f = e.ingest("S", t).forecast;
    assert.ok(validVector(f.vectors.ensemble)); assert.ok(validVector(f.vectors.final));
    const ws = Object.values(f.weights);
    assert.ok(Math.abs(ws.reduce((a, b) => a + b, 0) - 1) < 1e-9);
    assert.ok(ws.every(x => x >= 0.01 - 1e-9 && x <= 0.6 + 1e-9));
  }
});

test("trigger: SKIP below minProbability, TRADE above", () => {
  const lo = new Ldpe({ minTicks: 10, minProbability: 0.5 });
  let f; for (const t of stream(2, 200)) f = lo.ingest("S", t).forecast;
  assert.equal(f.decision, "SKIP"); assert.equal(f.reason, "below minProbability");
  const hi = new Ldpe({ minTicks: 10, minProbability: 0.05 });
  for (const t of stream(2, 200)) f = hi.ingest("S", t).forecast;
  assert.equal(f.decision, "TRADE");
});

// Acceptance criteria fixed before running (not tuned on these streams):
//  - per-seed ensemble log loss within 0.03 nats of ln(10); Brier within 0.01 of 0.9
//  - fraction of eligible forecasts at/above 12% below 5%
test("synthetic null: no artificial confidence, no systematic false triggers", () => {
  let above = 0, total = 0;
  for (const seed of [101, 202, 303, 404, 505]) {
    const e = new Ldpe({ minTicks: 100, horizon: 5 });
    for (const t of stream(seed, 4000)) {
      const f = e.ingest("S", t).forecast;
      if (f.warmup.complete) { total++; if (f.probability >= 0.12) above++; }
    }
    const m = e.metrics("S");
    assert.ok(m.logLoss - LN10 < 0.03, `seed ${seed} log loss ${m.logLoss}`);
    assert.ok(m.brier - 0.9 < 0.01, `seed ${seed} brier ${m.brier}`);
  }
  assert.ok(above / total < 0.05, `trigger rate ${above / total}`);
});

// Signal fixed in advance: digit 7 at 15%; success = beats uniform log loss and lifts P(7).
test("planted signal: biased digit is detected on most independent seeds", () => {
  const pick = (r) => { if (r() < 0.15) return 7; const y = Math.floor(r() * 9); return y >= 7 ? y + 1 : y; };
  let detected = 0; const seeds = [11, 12, 13, 14, 15, 16];
  for (const seed of seeds) {
    const e = new Ldpe({ minTicks: 100, horizon: 5 });
    let sum7 = 0, n = 0;
    for (const t of stream(seed, 6000, pick)) {
      const f = e.ingest("S", t).forecast;
      if (f.warmup.complete) { sum7 += f.vectors.ensemble[7]; n++; }
    }
    if (e.metrics("S").logLoss < LN10 && sum7 / n > 0.11) detected++;
  }
  assert.ok(detected >= 5, `detected ${detected}/${seeds.length}`);
});
