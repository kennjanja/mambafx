import { test } from "node:test";
import assert from "node:assert/strict";
import { nextLadderStake, normalizeLadder, ladderActive } from "../../src/bazu/stakeLadder3m.js";

const L = { afterWin: 2.5, afterLoss: 3, resetEvery: 5 };
const run = (results, ladder = L, base = 1) => {
  let stake = base, count = 0; const seq = [];
  for (const r of results) { const n = nextLadderStake({ ladder, base, lastStake: stake, result: r, count }); stake = n.stake; count = n.count; seq.push(stake); }
  return seq;
};

test("win multiplies by the win value, loss by the loss value", () => {
  assert.deepEqual(run(["win"]), [2.5]);
  assert.deepEqual(run(["loss"]), [3]);
  assert.deepEqual(run(["loss", "win"]), [3, 7.5]);
});
test("stake returns to base after n settled trades and the count restarts", () => {
  assert.deepEqual(run(["win", "win", "loss", "loss", "win", "loss"]), [2.5, 6.25, 18.75, 56.25, 1, 3]);
});
test("ties and unknown results keep the stake but still count", () => {
  assert.deepEqual(run(["tie", "unknown"]), [1, 1]);
  assert.equal(run(["tie", "tie", "tie", "tie", "win"]).at(-2), 1);
});
test("defaults are off; invalid input falls back safely", () => {
  assert.equal(ladderActive(normalizeLadder()), false);
  assert.deepEqual(normalizeLadder({ afterWin: "x", afterLoss: -2, resetEvery: 0 }), { afterWin: 1, afterLoss: 1, resetEvery: 5 });
  assert.equal(normalizeLadder({ resetEvery: 2.9 }).resetEvery, 2);
  assert.equal(ladderActive(normalizeLadder({ afterWin: 2 })), true);
});
test("stake never falls below the 0.35 minimum", () => {
  assert.equal(run(["win"], { afterWin: 0.1, afterLoss: 1, resetEvery: 5 }, 1)[0], 0.35);
});
test("reset every 1 trade always returns to base", () => {
  assert.deepEqual(run(["win", "loss"], { afterWin: 2, afterLoss: 2, resetEvery: 1 }), [1, 1]);
});
