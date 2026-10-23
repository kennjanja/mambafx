import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GapResearch } from "../../src/ldpe/gap-research.js";

const feed = (r, digits, sym = "R_10", e0 = 1) => digits.forEach((d, i) => r.ingest(sym, d, e0 + i));

test("gap = ticks without the digit between two occurrences", () => {
  const r = new GapResearch();
  feed(r, [5, 1, 2, 5, 1, 2, 5, 5]);           // 5: gaps 2, 2, 0
  const top = r.top("R_10");
  assert.deepEqual(top.find(x => x.digit === 5 && x.gap === 2), { digit: 5, gap: 2, frequency: 4 });
  assert.deepEqual(top.find(x => x.digit === 5 && x.gap === 0), { digit: 5, gap: 0, frequency: 5 });   // every gap reached >= 0
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
test("frequency counts every completed gap, by any digit, that reached at least this length", () => {
  const r = new GapResearch();
  // digit 6 gap 4; then digit 7 gap 4 (6's frequency becomes 2); then digit 0 gap 6 (6's becomes 3, 0 has 1)
  feed(r, [6, 1, 1, 1, 1, 6, 7, 1, 1, 1, 1, 7, 0, 1, 1, 1, 1, 1, 1, 0]);
  let top = r.top("R_10");
  const row = (d, g) => top.find(x => x.digit === d && x.gap === g);
  assert.equal(row(0, 6).frequency, 1);
  assert.equal(row(6, 4).frequency, 3);
  assert.equal(row(7, 4).frequency, 3 - 0);
  assert.ok(top.every((x, i) => i === 0 || top[i - 1].gap >= x.gap));
});

test("current gaps are exposed; unseen digits are null", () => {
  const r = new GapResearch();
  feed(r, [3, 1, 1]);
  const c = r.current("R_10");
  assert.equal(c[3], 2); assert.equal(c[1], 0); assert.equal(c[9], null);
});

test("page wiring: research card is named Digit research, has own stake/progression/multiplier and trading controls, no row numbering", () => {
  const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  assert.match(html, /Digit research<\/h2>/);
  for (const id of ["digResStake", "digResStrat", "digResMultN", "digResArm", "digResTrigger", "digResManual"]) assert.ok(html.includes(`id="${id}"`), id);
  assert.match(html, /<thead><tr><th>Digit<\/th><th>Gap<\/th><th>Frequency<\/th><\/tr><\/thead>/);
  assert.match(html, /value="martingale"[^>]*>Martingale[\s\S]{0,400}value="dalembert"/);
  assert.match(html, /GAPRES\.afterTick\(SYMBOL, d, epoch\)/);
  assert.match(html, /function makeMultiplier\(getStakeEl, getMultN\)/);
});
test("gap-research.js defines esc when it calls it (regression: undefined esc froze the tick path)", () => {
  const src = readFileSync(new URL("../../src/ldpe/gap-research.js", import.meta.url), "utf8");
  if (/\besc\(/.test(src)) assert.match(src, /const esc\s*=/);
});
