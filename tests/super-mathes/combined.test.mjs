import test from "node:test";
import assert from "node:assert/strict";
import { combinedPrediction, frequencyDistribution, transitionDistribution } from "../../src/super-mathes/models.js";
import { createLiveResearch } from "../../src/super-mathes/live.js";
import { installFakeIndexedDB } from "../support/fakeIndexedDB.js";

const digits = [...Array(5).fill([3, 2, 2, 2, 2]).flat(), ...Array(6).fill([3, 1]).flat(), 3];

test("combined research uses both models and reports disagreement", () => {
  const result = combinedPrediction(digits, { frequencyWeight: 0.25 });
  assert.equal(result.frequencyLeader, 2);
  assert.equal(result.markovLeader, 1);
  assert.deepEqual(result.frequency, frequencyDistribution(digits));
  assert.deepEqual(result.markov, transitionDistribution(digits));
  for (let d = 0; d < 10; d++) assert.ok(Math.abs(result.probabilities[d] - (0.25 * result.frequency[d] + 0.75 * result.markov[d])) < 1e-12);
  assert.ok(Math.abs(result.probabilities.reduce((a, b) => a + b, 0) - 1) < 1e-12);
  assert.equal(result.selectedDigit, result.ranking[0].digit);
});

test("combined model rejects insufficient data, insufficient state transitions and excluded models", () => {
  assert.throws(() => combinedPrediction([1, 2]), /Insufficient observations/);
  assert.throws(() => combinedPrediction([...Array(20).fill(1), 2]), /Insufficient transitions/);
  assert.throws(() => combinedPrediction(digits, { frequencyWeight: 0 }), /positive weights/);
  assert.throws(() => combinedPrediction(digits, { frequencyWeight: 1 }), /positive weights/);
});

test("combined model evidence survives lifecycle updates and reload", async () => {
  const fake = installFakeIndexedDB();
  try {
    const live = createLiveResearch({ report: () => {} });
    const tick = (epoch, digit) => ({ endpoint: "wss://public.example", symbol: "R_100", epoch, rawQuote: `1.2${digit}`, decimals: 2 });
    for (let i = 0; i < digits.length; i++) await live.ingest(tick(i + 1, digits[i]));
    const created = await live.createModelPrediction(100, "combined", 0.25);
    const evidence = created.prediction.evidence;
    assert.equal(evidence.frequencyWeight, 0.25);
    assert.equal(evidence.frequencyLeader, 2);
    assert.equal(evidence.markovLeader, 1);
    await live.ingest(tick(digits.length + 1, created.prediction.selectedDigit));
    const recovered = createLiveResearch({ report: () => {} });
    const row = await recovered.getPrediction(created.id);
    assert.deepEqual(row.prediction.evidence, evidence);
    assert.equal(row.prediction.selectedDigit, created.prediction.selectedDigit);
    assert.equal(row.observations[0].digit, created.prediction.selectedDigit);
  } finally { fake.teardown(); }
});
