import test from "node:test";
import assert from "node:assert/strict";
import { installFakeIndexedDB } from "../support/fakeIndexedDB.js";
import { createLiveResearch, normalizeLiveTick, sourceId } from "../../src/super-mathes/live.js";
import { walkForward } from "../../src/super-mathes/validation.js";
import { readdir, readFile } from "node:fs/promises";

const endpoint = "wss://public.example";
const source = sourceId(endpoint, "R_100", 2);
const tick = (epoch, rawQuote = "1.23", symbol = "R_100") => ({ endpoint, symbol, epoch, rawQuote, decimals: 2 });
const prediction = (id, timestamp = 1, s = source) => ({
  id, source: s, timestamp, selectedDigit: 3, probabilities: Array(10).fill(0.1),
  hazards: Array(5).fill(0.1), model: "uniform", assumptions: "research fixture",
});

test("live validation retains original literals and separates endpoints, symbols and precisions", () => {
  const t = normalizeLiveTick(tick(1, "1.2"));
  assert.equal(t.rawQuote, "1.2");
  assert.equal(t.quote, "1.20");
  assert.notEqual(source, sourceId(endpoint, "R_10", 2));
  assert.notEqual(source, sourceId(endpoint, "R_100", 3));
  assert.notEqual(source, sourceId("wss://other.example", "R_100", 2));
  for (const bad of [tick(1, "1e2"), tick(1, "1.234"), tick(1.5), tick(1, null)]) {
    assert.throws(() => normalizeLiveTick(bad), /Invalid|precision/);
  }
});

test("durable records keep five outcomes and immutable prediction inputs across recovery", async () => {
  const fake = installFakeIndexedDB(), errors = [];
  try {
    const live = createLiveResearch({ report: e => errors.push(e) });
    await live.ingest(tick(1));
    const input = prediction("early");
    const creation = live.createPrediction(input, 1);
    input.probabilities[3] = 0.9;
    await creation;
    await live.ingest(tick(2, "1.23"));
    let record = await live.getPrediction("early");
    assert.equal(record.status, "Immediate Hit");
    assert.equal(record.prediction.probabilities[3], 0.1);
    await live.ingest(tick(3, "1.21"));
    await live.ingest(tick(4, "1.23"));
    await live.ingest(tick(5, "1.20"));
    await live.ingest(tick(6, "1.23"));
    record = await live.getPrediction("early");
    assert.equal(record.observations.length, 5);
    assert.deepEqual(record.observations.map(o => o.digit), [3, 1, 3, 0, 3]);
    assert.equal(record.appearancePosition, 1);
    assert.equal((await live.getSource(source)).lastSeq, 6);
    const restarted = createLiveResearch({ report: e => errors.push(e) });
    assert.equal((await restarted.getPrediction("early")).observations.length, 5);
    assert.equal((await restarted.listObservations(source, 10)).length, 6);
    assert.deepEqual(errors, []);
  } finally { fake.teardown(); }
});

test("all first appearances, five misses and incomplete lifecycle survive reload without inventing outcomes", async () => {
  const fake = installFakeIndexedDB();
  try {
    const live = createLiveResearch({ report: () => {} });
    await live.ingest(tick(1));
    for (let n = 1; n <= 6; n++) await live.createPrediction(prediction(`p${n}`), 1);
    for (let n = 1; n <= 5; n++) {
      // Separate source streams give each record a different first hit.
      const s = sourceId(endpoint, `S${n}`, 2);
      await live.ingest(tick(10, "1.21", `S${n}`));
      await live.createPrediction(prediction(`s${n}`, 10, s), 1);
      for (let k = 1; k <= 5; k++) await live.ingest(tick(10 + k, k === n ? "1.23" : "1.21", `S${n}`));
      const r = await live.getPrediction(`s${n}`);
      assert.equal(r.appearancePosition, n);
      assert.equal(r.observations.length, 5);
    }
    // The source switch invalidated the first source rather than treating another market as its outcome.
    assert.equal((await live.getPrediction("p1")).status, "Unscorable");
    const s = sourceId(endpoint, "MISS", 2);
    await live.ingest(tick(20, "1.21", "MISS"));
    await live.createPrediction(prediction("miss", 20, s), 1);
    for (let k = 1; k <= 5; k++) await live.ingest(tick(20 + k, "1.21", "MISS"));
    assert.equal((await live.getPrediction("miss")).status, "Not Appeared Within 5 Observations");
    await live.createPrediction(prediction("partial", 25, s), 6);
    await live.ingest(tick(26, "1.23", "MISS"));
    const restarted = createLiveResearch({ report: () => {} });
    const partial = await restarted.getPrediction("partial");
    assert.equal(partial.status, "Unscorable");
    assert.equal(partial.observations.length, 1);
    assert.equal(partial.observations[0].digit, 3);
    assert.equal(partial.interruptionReason, "Application restarted; continuity is unknown");
  } finally { fake.teardown(); }
});

test("duplicates, order, stale origins, gaps and creation races cannot score later observations", async () => {
  const fake = installFakeIndexedDB(), errors = [];
  try {
    const live = createLiveResearch({ report: e => errors.push(e) });
    await live.ingest(tick(1));
    const ahead = live.ingest(tick(2));
    const stale = live.createPrediction(prediction("stale"), 1);
    await ahead;
    await assert.rejects(stale, /stale/);
    await live.createPrediction(prediction("duplicate", 2), 2);
    assert.equal((await live.ingest(tick(2))).duplicate, true);
    assert.equal((await live.getPrediction("duplicate")).status, "Unscorable");
    await assert.rejects(live.ingest(tick(1, "1.22")), /Conflicting|order/);
    await live.ingest(tick(3));
    await assert.rejects(live.createPrediction(prediction("duplicate", 3), 3), /already exists/);
    await live.createPrediction(prediction("bad", 3), 3);
    await assert.rejects(live.ingest(tick(4, "1.234")), /precision/);
    assert.equal((await live.getPrediction("bad")).status, "Unscorable");
    await live.ingest(tick(5));
    await live.createPrediction(prediction("disconnect", 5), 4);
    await live.interrupt("Disconnected");
    await live.ingest(tick(6));
    assert.equal((await live.getPrediction("disconnect")).observations.length, 0);
    assert.equal((await live.getPrediction("disconnect")).status, "Unscorable");
    assert.ok(errors.length >= 3);
  } finally { fake.teardown(); }
});

test("stored digits can be passed chronologically to existing walk-forward evaluation", async () => {
  const fake = installFakeIndexedDB();
  try {
    const live = createLiveResearch({ report: () => {} });
    for (let i = 1; i <= 30; i++) await live.ingest(tick(i, `1.2${i % 10}`));
    const digits = (await live.listObservations(source, 100)).reverse().map(o => o.digit);
    const result = walkForward(digits, { warmup: 20 });
    assert.equal(result.n, 10);
    assert.equal(result.status, "Under Validation");
  } finally { fake.teardown(); }
});

test("research module has no imports or storage coupling to LDPE", async () => {
  const dir = new URL("../../src/super-mathes/", import.meta.url);
  for (const name of await readdir(dir)) {
    if (!name.endsWith(".js")) continue;
    assert.doesNotMatch(await readFile(new URL(name, dir), "utf8"), /ldpe/i, name);
  }
});

test("research frequency prediction, persisted evaluation and historical import are isolated", async () => {
  const fake = installFakeIndexedDB();
  try {
    const live = createLiveResearch({ report: () => {} });
    for (let i = 1; i <= 30; i++) await live.ingest(tick(i, i % 4 ? "1.23" : "1.21"));
    const r = await live.createModelPrediction(30);
    assert.equal(r.prediction.selectedDigit, 3);
    assert.equal(r.prediction.probabilities.length, 10);
    assert.ok(Math.abs(r.prediction.probabilities.reduce((a, b) => a + b, 0) - 1) < 1e-12);
    const report = await live.benchmark(30, 20);
    assert.equal(report.result.n, 10);
    assert.equal((await live.listReports(source, 1))[0].id, report.id);
    await live.setSetting("windowSize", 30);
    assert.equal((await live.getSetting("windowSize")).value, 30);
    const historical = await live.importHistorical("dataset", [tick(1, "1.2"), tick(2, "1.23")]);
    assert.equal(historical.imported, 2);
    assert.notEqual(historical.source, source);
    assert.equal((await live.getSource(historical.source)).connected, false);
    assert.equal((await live.importHistorical("dataset", [tick(1, "1.2"), tick(2, "1.23")])).imported, 0);
    await assert.rejects(live.importHistorical("dataset", [{ ...tick(3), decimals: 3 }]), /precision/);
    const restarted = createLiveResearch({ report: () => {} });
    assert.equal((await restarted.listReports(source, 1))[0].id, report.id);
    assert.equal((await restarted.getSetting("windowSize")).value, 30);
  } finally { fake.teardown(); }
});

test("a detected feed gap starts a new segment and leaves unfinished predictions unscorable", async () => {
  const fake = installFakeIndexedDB();
  try {
    const live = createLiveResearch({ report: () => {} });
    for (let i = 1; i <= 22; i++) await live.ingest(tick(i));
    await live.createPrediction(prediction("gap", 22), 22);
    await live.ingest(tick(30));
    const result = await live.getPrediction("gap");
    assert.equal(result.status, "Unscorable");
    assert.equal(result.observations.length, 0);
    assert.equal((await live.getSource(source)).segment, 2);
  } finally { fake.teardown(); }
});

test("model creation rejects ties and accepts explicit Markov selection without promoting it", async () => {
  const fake = installFakeIndexedDB();
  try {
    const live = createLiveResearch({ report: () => {} });
    for (let i = 1; i <= 20; i++) await live.ingest(tick(i, `1.2${(i - 1) % 10}`));
    await assert.rejects(live.createModelPrediction(20, "frequency"), /tied/);
    await live.ingest(tick(21, "1.20"));
    const record = await live.createModelPrediction(21, "markov");
    assert.equal(record.prediction.model, "smoothed-first-order-markov");
    assert.equal(record.prediction.selectedDigit, 1);
    const report = await live.benchmark(21, 10, "markov");
    assert.equal(report.result.status, "Under Validation");
    assert.equal(report.model, "markov");
  } finally { fake.teardown(); }
});
