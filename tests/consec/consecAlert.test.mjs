import test from "node:test";
import assert from "node:assert/strict";
import { createRun, feed, levelOf, adviceOf } from "../../src/consec/consecAlert.js";

const run = (prices) => { const r = createRun(); prices.forEach((p) => feed(r, p)); return r; };

test("counts consecutive rises and ignores unchanged ticks", () => {
  const r = run([1, 2, 2, 3, 3, 4]);
  assert.deepEqual([r.dir, r.len], [1, 3]);
});
test("direction change restarts the run", () => {
  const r = run([1, 2, 3, 2]);
  assert.deepEqual([r.dir, r.len], [-1, 1]);
});
test("levels and reversal advice", () => {
  assert.equal(levelOf(5), "idle"); assert.equal(levelOf(6), "warn"); assert.equal(levelOf(10), "signal");
  assert.equal(adviceOf(1), "sell"); assert.equal(adviceOf(-1), "buy");
});
