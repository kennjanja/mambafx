import test from "node:test";
import assert from "node:assert/strict";
import {
  CandidateForecaster, EarnedWeightMixture, fitTuningParameters, GapRampForecaster,
  normalizeProbabilities, SoftmaxRegressionForecaster,
} from "../../src/ldpe/evaluation/models.mjs";

function valid(v) {
  assert.equal(v?.length, 10);
  assert.ok(v.every((p) => Number.isFinite(p) && p >= 0));
  assert.ok(Math.abs(v.reduce((a, b) => a + b, 0) - 1) < 1e-10);
}

function stream(n, pick) {
  let state = 19;
  const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296);
  return Array.from({ length: n }, (_, i) => pick ? pick(random, i) : Math.floor(random() * 10));
}

test("candidate probability normalization rejects malformed input", () => {
  assert.deepEqual(normalizeProbabilities(Array(10).fill(1)), Array(10).fill(0.1));
  assert.equal(normalizeProbabilities([1, -1, ...Array(8).fill(1)]), null);
  assert.equal(normalizeProbabilities([1, 2]), null);
});

test("all registered candidate families return valid distributions", () => {
  const digits = stream(500);
  const fitted = fitTuningParameters(digits.slice(0, 300), 5);
  for (const family of ["hdm", "ddir", "ctw", "inc", "lag"]) {
    const model = new CandidateForecaster(family, 5, fitted);
    let forecast;
    for (const digit of digits) { model.observe(digit); forecast = model.predict(); valid(forecast); }
  }
});

test("candidate forecasts at an origin depend only on the observed prefix", () => {
  const prefix = stream(500);
  for (const family of ["hdm", "ddir", "ctw", "inc", "lag"]) {
    const a = new CandidateForecaster(family, 5, { hierarchicalBase: Array(10).fill(0.1), hierarchicalAlpha: 10, discount: 0.995 });
    const b = new CandidateForecaster(family, 5, { hierarchicalBase: Array(10).fill(0.1), hierarchicalAlpha: 10, discount: 0.995 });
    for (const digit of prefix) { a.observe(digit); b.observe(digit); }
    const forecastA = a.predict(), forecastB = b.predict();
    assert.deepEqual(forecastA, forecastB, family);
    for (const digit of [1, 1, 9, 9, 9, 0, 2]) b.observe(digit);
    assert.deepEqual(forecastA, forecastB, family);
  }
});

test("horizon training pairs mature only after their target tick arrives", () => {
  const model = new CandidateForecaster("lag", 5);
  for (let d = 0; d < 5; d++) model.observe(d);
  assert.equal(model.lagCounts[0].size, 0);
  model.observe(7);
  assert.deepEqual(model.lagCounts[0].get(0), [0, 0, 0, 0, 0, 0, 0, 1, 0, 0]);
});

test("hierarchical and discounted tuning stays inside the supplied tuning prefix", () => {
  const tuning = stream(1000);
  const changedFuture = tuning.concat(stream(1000, () => 9));
  assert.deepEqual(fitTuningParameters(tuning, 5), fitTuningParameters(changedFuture.slice(0, 1000), 5));
});

test("first-order increment model forecasts a deterministic modular walk", () => {
  const model = new CandidateForecaster("inc", 1);
  for (let i = 0; i < 500; i++) model.observe(i % 10);
  const p = model.predict();
  valid(p);
  assert.ok(p[(model.digits.at(-1) + 1) % 10] > 0.9);
});

test("increment context does not bridge a feed discontinuity", () => {
  const model = new CandidateForecaster("inc", 1);
  model.observe(0);
  model.observe(1);
  model.markDiscontinuity();
  model.observe(2);
  model.observe(3);
  assert.equal(model.incrementCounts[1][1], 0);
  model.observe(4);
  assert.equal(model.incrementCounts[1][1], 1);
});

test("softmax regression learns a deterministic first-order pattern without future targets", () => {
  const model = new SoftmaxRegressionForecaster(1);
  for (let i = 0; i < 1200; i++) model.observe(i % 10);
  const forecast = model.predict();
  valid(forecast);
  assert.ok(forecast[(model.digits.at(-1) + 1) % 10] > 0.8);
});

test("gapRamp uses the configured 122-tick saturation scale", () => {
  const model = new GapRampForecaster(1, 122);
  model.observe(0);
  const forecast = model.predict();
  valid(forecast);
  assert.ok(forecast[1] > forecast[0]);
  assert.ok(Math.abs(forecast[1] / forecast[0] - ((1 + 2 / 122) / (1 + 1 / 122))) < 1e-10);
});

test("earned-weight mixture learns experts under cluster caps and retains a uniform floor", () => {
  const clusters = { useful: "sequence", weak: "frequency", gap: "gap", streak: "streak" };
  const mixture = new EarnedWeightMixture(clusters);
  const forecasts = {
    useful: [1, ...Array(9).fill(0)],
    weak: Array(10).fill(0.1),
    gap: Array(10).fill(0.1),
    streak: Array(10).fill(0.1),
  };
  const before = mixture.getWeights();
  for (let i = 0; i < 100; i++) mixture.observe(forecasts, 0);
  const after = mixture.getWeights();
  assert.ok(after.useful > before.useful);
  assert.ok(Math.abs(Object.values(after).reduce((sum, weight) => sum + weight, 0) - 1) < 1e-10);
  for (const cluster of new Set(Object.values(clusters))) {
    const weight = Object.keys(clusters).filter((name) => clusters[name] === cluster)
      .reduce((sum, name) => sum + after[name], 0);
    assert.ok(weight <= 0.4 + 1e-10);
  }
  const prediction = mixture.predict(forecasts);
  valid(prediction);
  assert.ok(prediction.every((probability) => probability >= 0.005));
});
