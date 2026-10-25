import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyBreakouts } from '../../src/bazu/breakoutStates3m.js';
import { outcomeAt, accuracy, byGroup } from '../../src/bazu/horizons3m.js';
import { createScoreCalibrator } from '../../src/bazu/scoreCalibrator3m.js';

const cd = (o, h, l, c, atr = 1) => { const r = h - l, b = Math.abs(c - o); return { open: o, high: h, low: l, close: c, atr, patternOk: true, bodyRange: r ? b / r : 0, upperFrac: r ? (h - Math.max(o, c)) / r : 0, lowerFrac: r ? (Math.min(o, c) - l) / r : 0, rangeATR: r / atr }; };
const flat = (n) => Array.from({ length: n }, () => cd(9.5, 9.8, 9.3, 9.6));
const zone = { low: 9.9, high: 10, kind: 'resistance', tf: 'M5', touches: 3, strength: 2, overlap: 1 };

test('breakout lifecycle: provisional -> confirmed -> continuation -> exhaustion, failed', () => {
  const brk = cd(9.8, 10.5, 9.8, 10.45);
  assert.equal(classifyBreakouts([...flat(12), brk], [zone]).top.state, 'provisional');
  const conf = [...flat(12), brk, cd(10.4, 10.6, 10.3, 10.5), cd(10.5, 10.7, 10.4, 10.6)];
  assert.equal(classifyBreakouts(conf, [zone]).top.state, 'confirmed');
  const cont = [...flat(12), brk, cd(10.4, 11, 10.3, 10.9), cd(10.9, 11.6, 10.8, 11.5)];
  assert.equal(classifyBreakouts(cont, [zone]).top.state, 'continuation');
  const exh = [...flat(12), brk, cd(10.4, 11, 10.3, 10.9), cd(10.9, 13.3, 10.8, 13.2)];
  assert.equal(classifyBreakouts(exh, [zone]).top.state, 'exhaustion');
  const fail = [...flat(12), brk, cd(10.4, 10.5, 9.6, 9.7)];
  const r = classifyBreakouts(fail, [zone]).top; assert.equal(r.state, 'failed'); assert.equal(r.direction, 1);
});

test('strength and confirmation are separate fields', () => {
  const t = classifyBreakouts([...flat(12), cd(9.8, 10.5, 9.8, 10.45), cd(10.4, 10.6, 10.3, 10.5)], [zone]).top;
  assert.ok(t.strength.penetrationATR > 0.25 && t.strength.bodyRange >= 0.6);
  assert.equal(t.confirmation.closesBeyond, 1);
});

test('weak break is only penetrated; nearby price is approaching', () => {
  assert.equal(classifyBreakouts([...flat(12), cd(9.9, 10.2, 9.9, 10.05)], [zone]).top.state, 'penetrated');
  assert.equal(classifyBreakouts(flat(14), [zone]).top.state, 'approaching');
});

test('outcomeAt: entry is the tick after the decision; ties are not wins', () => {
  const p = [1, 1, 2, 3, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22];
  const o = outcomeAt(p, 0, 1); assert.equal(o.entry, 1);
  assert.equal(o.h[1], 'win'); assert.equal(o.h[3], 'win');
  assert.equal(outcomeAt(p, 0, -1).h[1], 'loss');
  assert.equal(outcomeAt([1, 2, 2, 2], 0, 1).h[1], 'tie');
  assert.equal(outcomeAt([1, 2, 3], 0, 1).h[5], null);
  assert.equal(outcomeAt([1], 0, 1), null);
});

test('accuracy reports balanced accuracy and groups', () => {
  const a = accuracy([{ dir: 1, result: 'win' }, { dir: 1, result: 'win' }, { dir: 1, result: 'win' }, { dir: -1, result: 'loss' }]);
  assert.equal(a.accuracy, 0.75); assert.equal(a.balanced, 0.5);
  const g = byGroup([{ dir: 1, st: 'x', outcome: { h: { 3: 'win' } } }, { dir: 1, st: 'y', outcome: { h: { 3: 'loss' } } }], (o) => o.st, 3);
  assert.equal(g.x.accuracy, 1); assert.equal(g.y.accuracy, 0);
});

test('score calibrator is monotone and flags uncalibrated until enough data', () => {
  const c = createScoreCalibrator({ bins: 5, minN: 50 });
  assert.equal(c.prob(0.9).calibrated, false);
  for (let i = 0; i < 60; i++) { c.add(0.9, i % 10 < 3); c.add(0.1, i % 10 < 6); } // inverted: low score wins more
  const lo = c.prob(0.1).p, hi = c.prob(0.9).p;
  assert.ok(hi >= lo, 'monotone after pooling');
  assert.equal(c.prob(0.9).calibrated, true);
});
