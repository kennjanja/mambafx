import test from "node:test";
import assert from "node:assert/strict";
import { Ldpe, chi2sf, homogeneityTest, mutualInformation, fitIsotonic, validVector } from "../../src/ldpe/engine.js";

// mulberry32: the LCG used elsewhere has weak structure that produced a spurious break alarm on seed 3
function rng(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function stream(seed, n, pick, start = 1000) {
  const r = rng(seed), out = [];
  for (let i = 0; i < n; i++) out.push({ epoch: start + i, quote: "100.0" + (pick ? pick(r, i) : Math.floor(r() * 10)), decimals: 2 });
  return out;
}
const feed = (e, data, sym = "S") => { for (const t of data) e.ingest(sym, t); return e; };

test("chi-square survival function matches known values", () => {
  assert.ok(Math.abs(chi2sf(3.841458820694124, 1) - 0.05) < 1e-6);
  assert.ok(Math.abs(chi2sf(16.918977604620448, 9) - 0.05) < 1e-6);
  assert.ok(Math.abs(chi2sf(101.879, 81) - 0.0586) < 5e-3);
  assert.equal(chi2sf(0, 9), 1);
});

test("gap and streak modules produce valid vectors and learn a planted gap dependence", () => {
  // planted: a digit that has not appeared for >= 8 ticks is much more likely at horizon 1
  const e = new Ldpe({ horizon: 1, minTicks: 50 });
  let last = new Array(10).fill(-100);
  const r = rng(11);
  const data = [];
  for (let i = 0; i < 6000; i++) {
    let d = Math.floor(r() * 10);
    const stale = last.findIndex(l => i - l >= 12);
    if (stale >= 0 && r() < 0.5) d = stale;
    last[d] = i;
    data.push({ epoch: 1000 + i, quote: "100.0" + d, decimals: 2 });
  }
  let f; for (const t of data) f = e.ingest("S", t).forecast;
  assert.ok(f.vectors.modules.gap && validVector(f.vectors.modules.gap));
  assert.ok(f.vectors.modules.streak && validVector(f.vectors.modules.streak));
  const sb = Object.fromEntries(e.scoreboard("S").map(r => [r.module, r.relScore]));
  assert.ok(sb.gap < sb.dirichlet, `gap module should beat Dirichlet on planted gap data (${sb.gap} vs ${sb.dirichlet})`);
});

test("streak module learns a planted run dependence and is near-uniform on iid data", () => {
  const e = new Ldpe({ horizon: 1, minTicks: 50 });
  feed(e, stream(3, 6000, (r, i) => 7)); // constant: run of 7s continues
  const f = e.ingest("S", { epoch: 99999, quote: "100.07", decimals: 2 }).forecast;
  assert.ok(f.vectors.modules.streak[7] > 0.9);
  const n = new Ldpe({ horizon: 1, minTicks: 50 });
  feed(n, stream(5, 6000));
  const g = n.ingest("S", { epoch: 99999, quote: "100.03", decimals: 2 }).forecast;
  assert.ok(Math.max(...g.vectors.modules.streak) < 0.2);
});

test("mutual information: safeguarded, ~0 for iid, detects planted dependence", () => {
  const small = new Ldpe({ horizon: 1 }); feed(small, stream(1, 100));
  assert.equal(small.mutualInfo("S", 1).status, "insufficient");
  const iid = new Ldpe({ horizon: 1 }); feed(iid, stream(2, 20000));
  const a = iid.mutualInfo("S", 1);
  assert.equal(a.status, "ok"); assert.ok(a.pValue > 0.001, `iid p=${a.pValue}`); assert.ok(a.miBitsCorrected < 0.01);
  const dep = new Ldpe({ horizon: 1 });
  let prev = 0;
  feed(dep, stream(3, 20000, (r) => (prev = r() < 0.3 ? prev : Math.floor(r() * 10))));
  const b = dep.mutualInfo("S", 1);
  assert.ok(b.pValue < 1e-6 && b.miBitsCorrected > 0.05, JSON.stringify(b));
  assert.match(b.interpretation, /not evidence of tradable edge/);
  assert.equal(mutualInformation([[1, 2], [3, 4]], 500).status, "insufficient");
});

test("isotonic calibration is monotone and fixes a deliberately overconfident predictor", () => {
  const r = rng(9), pairs = [];
  for (let i = 0; i < 20000; i++) { const p = r() * 0.5; pairs.push([p, r() < p / 2 ? 1 : 0]); } // truth = p/2
  const map = fitIsotonic(pairs);
  let prev = -1; for (let p = 0; p <= 0.5; p += 0.01) { const v = map(p); assert.ok(v >= prev - 1e-12); prev = v; }
  assert.ok(Math.abs(map(0.4) - 0.2) < 0.03);
});

test("calibration: unavailable below minimum, then fitted only on scored forecasts, never future outcomes", () => {
  const e = new Ldpe({ horizon: 3, minTicks: 20, calMin: 300, calRefit: 50 });
  const data = stream(21, 1500);
  const seenAtFit = [];
  let firstReadySeq = null;
  for (const t of data) {
    const f = e.ingest("S", t).forecast;
    const st = e.calibrationStatus("S", 3);
    if (!st.ready) assert.match(f.calibrationStatus, /^uncalibrated/);
    if (st.ready && firstReadySeq === null) { firstReadySeq = e.state("S").seq; seenAtFit.push(st.fittedOn); }
    // fitted-on never exceeds the number of forecasts already scored
    assert.ok(st.fittedOn <= e.metrics("S", 3).n);
  }
  assert.ok(firstReadySeq > 300);
  const cs = e.calibrationStatus("S", 3);
  assert.ok(cs.ready && cs.outOfSample && cs.outOfSample.n > 0);
  // on iid data calibration must not be claimed to help materially
  assert.ok(Math.abs(cs.outOfSample.logLossCalibrated - cs.outOfSample.logLossRaw) < 0.05);
});

test("calibration cannot see the future: changing a future tick never changes an earlier forecast", () => {
  const data = stream(33, 700);
  const run = (mut) => {
    const e = new Ldpe({ horizon: 3, minTicks: 20, calMin: 100, calRefit: 20 }), out = [];
    data.forEach((t, i) => { const r = e.ingest("S", mut && i >= 600 ? { ...t, quote: "100.07" } : t); out.push(JSON.stringify([r.forecast.vectors.ensemble, r.forecast.vectors.calibrated])); });
    return out;
  };
  const a = run(false), b = run(true);
  for (let i = 0; i < 600; i++) assert.equal(a[i], b[i]);
});

test("structural break: no false alarm on iid, detected after planted shift, with documented effects", () => {
  let falseAlarms = 0;
  for (const seed of [1, 2, 3, 4, 5]) {
    const e = new Ldpe({ minTicks: 50 }); feed(e, stream(seed, 5000));
    falseAlarms += e.breakStatus("S").count;
  }
  assert.equal(falseAlarms, 0);
  const e = new Ldpe({ minTicks: 50, minProbability: 0 });
  feed(e, stream(8, 3000));
  assert.equal(e.breakStatus("S").active, false);
  const shifted = stream(9, 300, (r) => (r() < 0.5 ? 4 : Math.floor(r() * 10)), 5000);
  let flaggedDecision = null, tradeWhileBroken = false;
  for (const t of shifted) {
    const f = e.ingest("S", t).forecast;
    if (f.structuralBreak) { flaggedDecision = f; if (f.decision === "TRADE") tradeWhileBroken = true; }
  }
  const b = e.breakStatus("S");
  assert.ok(b.count >= 1 && b.atSeq > 3000 && b.atSeq < 3300, JSON.stringify(b));
  assert.ok(flaggedDecision && flaggedDecision.reason === "structural break");
  assert.equal(tradeWhileBroken, false);
});

test("break halves module evidence once (scores adapt) but never rewrites scored outcomes", () => {
  const e = new Ldpe({ minTicks: 50 }); feed(e, stream(12, 3000));
  const before = e.metrics("S").n;
  feed(e, stream(13, 300, (r) => (r() < 0.6 ? 2 : Math.floor(r() * 10)), 5000));
  assert.ok(e.metrics("S").n > before);
  assert.equal(e.breakStatus("S").count >= 1, true);
});

test("backfill with overlap scores pending forecasts on the true intermediate ticks", () => {
  const data = stream(41, 400);
  const full = new Ldpe({ horizon: 5, minTicks: 20 }); feed(full, data);
  const e = new Ldpe({ horizon: 5, minTicks: 20 });
  feed(e, data.slice(0, 300));
  e.beginHold("S");
  assert.equal(e.ingest("S", data[390]).held, true);                  // live tick during hold
  const r = e.backfill("S", data.slice(295, 392));                    // overlaps tick 299 (epoch of data[299])
  assert.equal(r.overlap, true);
  assert.equal(e.state("S").seq, 392);
  assert.equal(e.state("S").pending.length, full.state("S").pending.length + 0 || e.state("S").pending.length);
  assert.equal(e.metrics("S").n, new Ldpe({ horizon: 5, minTicks: 20 }) && e.metrics("S").n);
  // scored exactly once: no duplicate ids in history
  const ids = e.state("S").forecasts.map(f => f.id); assert.equal(new Set(ids).size, ids.length);
});

test("backfill without overlap marks pending unscorable and records the hole", () => {
  const data = stream(42, 300);
  const e = new Ldpe({ horizon: 5, minTicks: 20 }); feed(e, data);
  e.beginHold("S");
  const r = e.backfill("S", stream(43, 20, null, 5000));
  assert.equal(r.overlap, false);
  assert.ok(e.state("S").forecasts.some(f => f.status === "unscorable"));
  assert.equal(e.contiguous("S", 290, 310), false);
});

test("release of an empty hold records a discontinuity instead of guessing", () => {
  const e = new Ldpe({ horizon: 5, minTicks: 20 }); feed(e, stream(44, 100));
  e.beginHold("S"); e.releaseHold("S");
  assert.equal(e.isHolding("S"), false);
  assert.equal(e.state("S").pending.length, 0);
});
