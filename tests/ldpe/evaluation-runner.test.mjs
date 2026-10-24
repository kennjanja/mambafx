import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { evaluateDevelopment, evaluateSelectedHoldout } from "../../src/ldpe/evaluation/runner.mjs";

function ticks(symbol, count, startEpoch = 1_800_000_000) {
  return Array.from({ length: count }, (_, i) => ({
    symbol, epoch: startEpoch + i, quote: `100.0${String(i % 10)}`, decimals: 2,
  }));
}

test("development runner reports the complete registered family and keeps holdout locked", () => {
  const datasets = Object.fromEntries(["R_100", "1HZ10V", "1HZ25V", "1HZ50V", "1HZ75V", "1HZ100V"]
    .map((symbol) => [symbol, ticks(symbol, 500)]));
  const report = evaluateDevelopment(datasets, {
    minimumTicks: 20, bootstrapReplicates: 100, powerSimulations: 1000,
  });
  assert.equal(report.registeredCells, 90);
  assert.equal(report.registeredHypotheses, 180);
  assert.equal(report.results.length, 180);
  assert.equal(report.selection.classifications.length, 90);
  assert.ok(report.selection.classifications.every((item) => item.classification && item.reason));
  assert.equal(report.stage, "development-evaluation");
  assert.equal(report.holdoutAccessed, false);
  assert.equal(report.selection.holdoutMayOpen, false);
});

test("holdout evaluator refuses to run unless both registered gates pass", () => {
  assert.throws(() => evaluateSelectedHoldout({}, { selection: { holdoutMayOpen: false } }), /holdout is locked/);
});

test("offline candidate evaluation is not wired into production trading modules", async () => {
  const root = new URL("../../src/ldpe/", import.meta.url);
  for (const file of ["bridge.js", "exec.js", "cycle.js", "gap-trader.js"]) {
    const source = await fs.readFile(new URL(file, root), "utf8");
    assert.doesNotMatch(source, /evaluation[\\/]/i, file);
    assert.doesNotMatch(source, /CandidateForecaster|evaluateDevelopment|evaluateSelectedHoldout/, file);
  }
});

test("development results are unchanged when only locked-holdout digits change", () => {
  const original = ticks("R_100", 500);
  const altered = original.map((tick, index) => index >= 385
    ? { ...tick, quote: "100.09" }
    : tick);
  const options = { minimumTicks: 20, bootstrapReplicates: 100, powerSimulations: 1000 };
  const first = evaluateDevelopment({ R_100: original }, options);
  const second = evaluateDevelopment({ R_100: altered }, options);
  const extract = (report) => report.results.filter((result) => result.symbol === "R_100");
  assert.deepEqual(extract(first), extract(second));
});
