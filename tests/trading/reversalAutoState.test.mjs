import test from "node:test";
import assert from "node:assert/strict";
import { applyReversalSettlement, createReversalDetector } from "../../src/trading/reversalAutoState.mjs";

test("five upward price movements signal a Fall reversal once per run", () => {
  const detector = createReversalDetector();
  for (const price of [100, 101, 102, 103, 104]) assert.equal(detector.observe(price), null);
  assert.deepEqual(detector.observe(105), { pattern: "5R", direction: "FALL" });
  assert.equal(detector.observe(106), null);
});

test("five downward price movements signal a Rise reversal", () => {
  const detector = createReversalDetector();
  for (const price of [105, 104, 103, 102, 101]) assert.equal(detector.observe(price), null);
  assert.deepEqual(detector.observe(100), { pattern: "5F", direction: "RISE" });
});

test("unchanged prices do not break or count toward the movement run", () => {
  const detector = createReversalDetector();
  for (const price of [10, 11, 11, 12, 12, 13, 13, 14, 15]) {
    const signal = detector.observe(price);
    if (price === 15) assert.deepEqual(signal, { pattern: "5R", direction: "FALL" });
    else assert.equal(signal, null);
  }
});

test("a direction reversal starts a new run and a new run can signal again", () => {
  const detector = createReversalDetector();
  for (const price of [20, 21, 22, 23, 24]) detector.observe(price);
  assert.deepEqual(detector.observe(25), { pattern: "5R", direction: "FALL" });
  for (const price of [24, 23, 22, 21]) assert.equal(detector.observe(price), null);
  assert.deepEqual(detector.observe(20), { pattern: "5F", direction: "RISE" });
});

test("settlements advance losses only on confirmed losses and reset the cycle on a win", () => {
  const state = { consecutiveLosses: 0, cycleStatus: "Active", awaitingNextCycle: false };
  applyReversalSettlement(state, false);
  assert.equal(state.consecutiveLosses, 1);
  assert.equal(state.cycleStatus, "Active");
  applyReversalSettlement(state, false);
  assert.equal(state.consecutiveLosses, 2);
  applyReversalSettlement(state, true);
  assert.equal(state.consecutiveLosses, 0);
  assert.equal(state.cycleStatus, "Won");
  assert.equal(state.awaitingNextCycle, true);
});
