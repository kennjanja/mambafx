import test from "node:test";
import assert from "node:assert/strict";
import {
  bonferroniInterval, holmAdjust, longRunCovariance, neweyWestTest,
  pairedCovariance, promotionPower, splitChronologically, stationaryBootstrapCI,
  summarizeForecasts,
} from "../../src/ldpe/evaluation/statistics.mjs";

test("paired log loss, Brier and hit-rate summaries use identical outcomes", () => {
  const rows = [
    { actual: 0, candidate: [0.7, ...Array(9).fill(0.3 / 9)], reference: Array(10).fill(0.1) },
    { actual: 1, candidate: [0.1, 0.1, ...Array(8).fill(0.8 / 8)], reference: Array(10).fill(0.1) },
  ];
  const summary = summarizeForecasts(rows);
  assert.equal(summary.n, 2);
  assert.ok(Number.isFinite(summary.deltaLogLoss));
  assert.equal(summary.candidateHitRate, 0.5);
  assert.equal(summary.referenceHitRate, 0.5);
  assert.ok(summary.candidateBrier >= 0 && summary.candidateBrier <= 2);
});

test("Holm adjustment preserves original order and is monotone by rank", () => {
  const adjusted = holmAdjust([0.04, 0.001, 0.02]);
  assert.deepEqual(adjusted, [0.04, 0.003, 0.04]);
  assert.throws(() => holmAdjust([NaN]), /p-values/);
});

test("stationary bootstrap is reproducible and exact for a constant paired loss", () => {
  const values = Array(500).fill(0.25);
  const first = stationaryBootstrapCI(values, { meanBlockLength: 50, replicates: 200, seed: 123 });
  const second = stationaryBootstrapCI(values, { meanBlockLength: 50, replicates: 200, seed: 123 });
  assert.deepEqual(first, second);
  assert.deepEqual(first, [0.25, 0.25]);
});

test("Newey-West test and paired long-run covariance handle serial dependence", () => {
  const a = Array.from({ length: 1000 }, (_, i) => Math.sin(i / 4) * 0.01 + 0.001);
  const b = a.map((value, i) => value * 0.5 + Math.cos(i / 7) * 0.002);
  assert.ok(neweyWestTest(a, 10).longRunVariance > 0);
  assert.ok(longRunCovariance(a, b, 10) > 0);
  assert.ok(pairedCovariance(a, b) > 0);
});

test("Bonferroni intervals widen as the registered family grows", () => {
  const small = bonferroniInterval(0.001, 0.0001, 0.05, 2);
  const large = bonferroniInterval(0.001, 0.0001, 0.05, 180);
  assert.ok(large[0] < small[0]);
  assert.ok(large[1] > small[1]);
});

test("chronological split removes ten origins on each side of both boundaries", () => {
  const { segments, boundaries } = splitChronologically(200000);
  assert.deepEqual(boundaries, [40000, 150000]);
  assert.deepEqual(segments.tuning, [0, 39990]);
  assert.deepEqual(segments.development, [40010, 149990]);
  assert.deepEqual(segments.holdout, [150010, 200000]);
});

test("registered promotion power is based on fixed planning effect and increases with sample size", () => {
  const params = { varianceA: 1, varianceB: 1.2, covariance: 0.7, simulations: 5000, seed: 5 };
  const lower = promotionPower({ ...params, sampleSize: 1000 });
  const higher = promotionPower({ ...params, sampleSize: 100000 });
  assert.equal(lower.planningEffect, 0.001);
  assert.equal(higher.planningEffect, 0.001);
  assert.ok(higher.power >= lower.power);
});
