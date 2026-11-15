import test from "node:test";
import assert from "node:assert/strict";
import { SequenceLedger } from "../../src/super-mathes/data.js";
import { frequencyDistribution, rankDistribution, sequenceDiagnostics, transitionDistribution, UNIFORM } from "../../src/super-mathes/models.js";
import { createResearchPrediction, markUnscorable, observePrediction, recurrenceProbabilities } from "../../src/super-mathes/recurrence.js";
import { walkForward } from "../../src/super-mathes/validation.js";

test("source ledger preserves precision, rejects conflicts, and isolates sources", () => {
  const a = new SequenceLedger("market-a"), b = new SequenceLedger("market-b");
  assert.equal(a.append({ source: "market-a", epoch: 1, quote: "1.20", decimals: 2 }).digit, 0);
  assert.equal(a.append({ source: "market-a", epoch: 1, quote: "1.20", decimals: 2 }), null);
  assert.throws(() => a.append({ source: "market-a", epoch: 1, quote: "1.21", decimals: 2 }), /Conflicting/);
  assert.throws(() => a.append({ source: "market-a", epoch: 0, quote: "1.20", decimals: 2 }), /out-of-order/);
  assert.throws(() => a.append({ source: "market-b", epoch: 2, quote: "1.23", decimals: 2 }), /source/);
  assert.throws(() => a.append({ source: "market-a", epoch: 2, quote: 1.2, decimals: 2 }), /precision/);
  assert.throws(() => a.append({ source: "market-a", epoch: 2, quote: "1.2", decimals: 2 }), /precision/);
  b.append({ source: "market-b", epoch: 1, quote: "1.23", decimals: 2 });
  const copy = a.snapshot(); copy[0].digit = 9; copy.push({});
  assert.equal(a.snapshot()[0].digit, 0);
  assert.equal(b.snapshot()[0].digit, 3);
  assert.deepEqual(SequenceLedger.fromSnapshot("market-a", a.snapshot()).snapshot(), a.snapshot());
  assert.throws(() => SequenceLedger.fromSnapshot("market-a", [{ ...a.snapshot()[0], digit: 9 }]), /corrupt/);
  assert.throws(() => SequenceLedger.fromSnapshot("market-a", [...a.snapshot(), ...a.snapshot()]), /Duplicate/);
});

test("frequency and transition diagnostics are normalized and honest about small samples", () => {
  const vector = frequencyDistribution([2, 2, 2, 7]);
  assert.ok(Math.abs(vector.reduce((a, b) => a + b, 0) - 1) < 1e-12);
  assert.equal(rankDistribution(vector)[0].digit, 2);
  assert.equal(sequenceDiagnostics([2, 2, 2, 7]).transitionInformation.status, "insufficient");
  assert.throws(() => frequencyDistribution([10]), /Invalid/);
  assert.throws(() => rankDistribution(Array(10).fill(0.5)), /normalized/);
});

test("recurrence distinguishes cumulative, exact, conditional and survival probabilities", () => {
  const r = recurrenceProbabilities(Array(5).fill(0.1));
  assert.ok(Math.abs(r.within[4] - 0.40951) < 1e-12);
  assert.ok(Math.abs(r.exact[3] - 0.0729) < 1e-12);
  assert.ok(Math.abs(r.notWithinFive - 0.59049) < 1e-12);
  assert.equal(r.hazards[3], 0.1);
  assert.throws(() => recurrenceProbabilities([0.1, 0.2]), /five/);
});

function forecast(id = "f1") {
  return createResearchPrediction({
    id, source: "a", timestamp: 100, probabilities: UNIFORM, selectedDigit: 2,
    hazards: Array(5).fill(0.1), model: "uniform-baseline", assumptions: "Independent uniform draws; research only",
  });
}

test("the original prediction remains frozen through each possible recurrence position", () => {
  for (let position = 1; position <= 5; position++) {
    let r = forecast(`f${position}`);
    const original = r.prediction;
    for (let n = 1; n <= position; n++) {
      r = observePrediction(r, { source: "a", epoch: 100 + n, digit: n === position ? 2 : 7 });
      assert.equal(r.prediction, original);
      assert.equal(r.prediction.selectedDigit, 2);
      if (n === 1 && position > 1) assert.equal(r.status, "Immediate Miss");
    }
    assert.equal(r.appearancePosition, position);
    assert.equal(r.status, position === 1 ? "Immediate Hit" : `Appeared Within ${position} Observations`);
    for (let n = position + 1; n <= 5; n++) r = observePrediction(r, { source: "a", epoch: 100 + n, digit: 2 });
    assert.equal(r.appearancePosition, position);
    assert.equal(r.observations.length, 5);
    assert.throws(() => observePrediction(r, { source: "a", epoch: 200, digit: 2 }), /finalized/);
    assert.throws(() => { r.prediction.probabilities[2] = 1; }, TypeError);
  }
});

test("five misses finalize; duplicates, foreign sources and gaps cannot become outcomes", () => {
  let r = forecast();
  r = observePrediction(r, { source: "a", epoch: 101, digit: 7 });
  assert.throws(() => observePrediction(r, { source: "a", epoch: 101, digit: 7 }), /duplicate/);
  assert.throws(() => observePrediction(r, { source: "b", epoch: 102, digit: 2 }), /source|Invalid/);
  const gap = markUnscorable(r);
  assert.throws(() => observePrediction(gap, { source: "a", epoch: 102, digit: 2 }), /finalized/);
  for (let n = 2; n <= 5; n++) r = observePrediction(r, { source: "a", epoch: 100 + n, digit: 7 });
  assert.equal(r.status, "Not Appeared Within 5 Observations");
  assert.equal(r.appearancePosition, null);
  assert.equal(r.observations.length, 5);
  assert.throws(() => markUnscorable(r), /finalized/);
});

test("walk-forward scores only the chronological training prefix", () => {
  const sequence = Array.from({ length: 60 }, (_, i) => i % 10);
  const before = walkForward(sequence, { warmup: 20 });
  const after = walkForward([...sequence.slice(0, 40), ...Array(20).fill(9)], { warmup: 20 });
  assert.deepEqual(before.rows.slice(0, 20), after.rows.slice(0, 20));
  assert.deepEqual(before.rows[0].candidate, frequencyDistribution(sequence.slice(0, 20)));
  assert.equal(before.n, 40);
  assert.equal(before.status, "Under Validation");
  assert.equal(walkForward([0], { warmup: 20 }).status, "Insufficient Evidence");
  assert.ok(Number.isFinite(before.brier) && Number.isFinite(before.logLoss));
});

test("Markov research model uses only observed transitions and is evaluated before each update", () => {
  const sequence = Array.from({ length: 60 }, (_, i) => i % 2);
  const expected = transitionDistribution(sequence.slice(0, 20));
  assert.ok(expected[0] > expected[1]);
  const first = walkForward(sequence, { warmup: 20, model: "markov" });
  const changedFuture = walkForward([...sequence.slice(0, 40), ...Array(20).fill(9)], { warmup: 20, model: "markov" });
  assert.deepEqual(first.rows[0].candidate, expected);
  assert.deepEqual(first.rows.slice(0, 20), changedFuture.rows.slice(0, 20));
  assert.equal(first.status, "Under Validation");
});
test("walk-forward benchmark detects a strong planted frequency bias without promoting the model", () => {
  let state = 1234567;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
  const digits = Array.from({ length: 3000 }, () => {
    const r = random();
    if (r < 0.5) return 2;
    const other = Math.floor((r - 0.5) * 18);
    return other >= 2 ? other + 1 : other;
  });
  const result = walkForward(digits, { warmup: 100 });
  assert.ok(result.logLoss < result.uniformLogLoss);
  assert.ok(result.top1 > 0.45);
  assert.equal(result.status, "Under Validation");
});
