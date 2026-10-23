import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GapResearch } from "../../src/ldpe/gap-research.js";

const feed = (r, digits, sym = "R_10", e0 = 1) => digits.forEach((d, i) => r.ingest(sym, d, e0 + i));

test("gap = ticks without the digit between two occurrences; frequency counts exact repeats", () => {
  const r = new GapResearch();
  feed(r, [5, 1, 2, 5, 1, 2, 5, 5]);           // 5: gaps 2, 2, 0
  const top = r.top("R_10");
  assert.deepEqual(top.find(x => x.digit === 5 && x.gap === 2), { digit: 5, gap: 2, frequency: 2 });
  assert.ok(top.some(x => x.digit === 5 && x.gap === 0 && x.frequency === 1));
});

test("the unseen start before a digit's first occurrence is not counted as a gap", () => {
  const r = new GapResearch();
  feed(r, [1, 2, 3, 4, 5]);
  assert.deepEqual(r.top("R_10"), []);
});

test("top 5 are ordered by longest gap, per market, and markets stay separate", () => {
  const r = new GapResearch();
  const seq = []; for (let d = 0; d < 7; d++) { seq.push(d); for (let i = 0; i < (d + 1) * 3; i++) seq.push(9); }
  for (let d = 0; d < 7; d++) seq.push(d);
  feed(r, seq, "R_10");
  feed(r, [3, 3], "R_100");
  const top = r.top("R_10");
  assert.equal(top.length, 5);
  assert.ok(top.every((x, i) => i === 0 || top[i - 1].gap >= x.gap));
  assert.equal(r.top("R_100")[0].gap, 0);
  assert.equal(r.ticks("R_100"), 2);
});

test("duplicate and out-of-order ticks are ignored; state persists across reload without double counting", () => {
  const mem = { d: {}, getItem(k) { return this.d[k] ?? null; }, setItem(k, v) { this.d[k] = v; } };
  const r = new GapResearch(mem);
  feed(r, [4, 0, 4, 0, 0, 4]);
  assert.equal(r.ingest("R_10", 4, 3), false);
  r.save();
  const r2 = new GapResearch(mem);
  feed(r2, [4, 0, 4, 0, 0, 4]);                 // replayed history: same epochs
  assert.deepEqual(r2.top("R_10"), r.top("R_10"));
  assert.equal(r2.ticks("R_10"), 6);
});

test("page wiring: research card sits beside the frequency table and ticks feed it", () => {
  const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  const a = html.indexOf('id="digFreqTable"'), b = html.indexOf('id="digResearchCard"');
  assert.ok(a > 0 && b > a && b - a < 2500);
  assert.match(html, /window\.GAPRES\.ingest\(SYMBOL, d, epoch/);
  assert.match(html, /src\/ldpe\/gap-research\.js/);
});