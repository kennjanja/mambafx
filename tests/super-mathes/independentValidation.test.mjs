import test from "node:test";
import assert from "node:assert/strict";
import { independentValidation } from "../../src/super-mathes/independentValidation.js";
import { frequencyDistribution, transitionDistribution } from "../../src/super-mathes/models.js";
import { logLoss } from "../../src/super-mathes/math.js";

function observations(digits) {
  return digits.map((digit, i) => ({ source: "fixture", segment: 1, sequence: i + 1, epoch: i + 1, digit }));
}

test("small samples are explicitly insufficient and mixed or incomplete segments are rejected", () => {
  const input = observations(Array.from({ length: 800 }, (_, i) => i % 10));
  const result = independentValidation(input);
  assert.equal(result.status, "Insufficient Evidence");
  assert.equal(result.protocol.evaluatedObservations, 300);
  assert.equal(result.models.markov.immediate.top1.confidence95, null);
  const gap = input.map(x => ({ ...x }));
  gap[10].sequence++;
  assert.throws(() => independentValidation(gap), /consecutive/);
  gap[10] = { ...input[10], source: "other" };
  assert.throws(() => independentValidation(gap), /single-source/);
  assert.throws(() => independentValidation(input, { warmup: 100 }), /500/);
});

test("recurrence uses disjoint windows and correct uniform conditional and cumulative baselines", () => {
  const digits = Array.from({ length: 800 }, (_, i) => i < 500 ? i % 2 : 9);
  const result = independentValidation(observations(digits));
  const rec = result.models.markov.recurrence.uniform;
  assert.equal(rec.within5.n, 60);
  assert.ok(Math.abs(rec.within5.predicted - 0.40951) < 1e-12);
  assert.ok(Math.abs(rec.none5.predicted - 0.59049) < 1e-12);
  assert.ok(Math.abs(rec.exact4.predicted - 0.0729) < 1e-12);
  assert.ok(Math.abs(rec.conditional2.predicted - 0.1) < 1e-12);
});

test("walk-forward outputs for earlier periods do not depend on later outcomes", () => {
  const original = Array.from({ length: 800 }, (_, i) => i % 2);
  const changed = [...original.slice(0, 700), ...Array(100).fill(9)];
  const a = independentValidation(observations(original));
  const b = independentValidation(observations(changed));
  assert.deepEqual(a.models.markov.periods.slice(0, 2), b.models.markov.periods.slice(0, 2));
});

test("confidence intervals require thirty disjoint hundred-observation blocks", () => {
  const result = independentValidation(observations(Array.from({ length: 3500 }, (_, i) => i % 2)));
  assert.equal(result.status, "Under Validation");
  assert.equal(result.protocol.blocks, 30);
  assert.equal(result.models.markov.immediate.top1.n, 3000);
  assert.equal(result.models.markov.recurrence.model.within5.n, 600);
  assert.equal(result.models.markov.immediate.top1.confidence95.length, 2);
  assert.equal(result.models.markov.immediate.frequencyLogLossGain.confidence95.length, 2);
});

test("uniform baseline uses expected random tie scores instead of selecting a digit", () => {
  const result = independentValidation(observations(Array.from({ length: 800 }, (_, i) => i % 10)));
  assert.ok(Math.abs(result.baselines.uniform.top1.observed - 0.1) < 1e-12);
  assert.ok(Math.abs(result.baselines.uniform.top2.observed - 0.2) < 1e-12);
  assert.ok(Math.abs(result.baselines.uniform.top3.observed - 0.3) < 1e-12);
  assert.ok(result.models.frequency.immediate.top1.n < result.protocol.evaluatedObservations);
});

test("evaluation scores the same rolling windows as the operational models", () => {
  const digits = Array.from({ length: 800 }, (_, i) => (i * i + Math.floor(i / 19)) % 10);
  const result = independentValidation(observations(digits), { warmup: 500, windowSize: 100 });
  for (const [model, predict] of [["frequency", frequencyDistribution], ["markov", transitionDistribution]]) {
    let sum = 0;
    for (let i = 500; i < 800; i++) sum += logLoss(predict(digits.slice(i - 100, i)), digits[i]);
    assert.ok(Math.abs(result.models[model].immediate.logLoss.observed - sum / 300) < 1e-12);
  }
});
