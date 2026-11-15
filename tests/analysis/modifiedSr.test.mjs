import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateCandles, computeModifiedSr, periodEnd, periodStart, SR_GROUPS } from '../../src/analysis/modifiedSr.js';

const frames = SR_GROUPS.flatMap(g => g.frames);
const now = Date.UTC(2026, 10, 15) / 1000;
function candles(g, offset = 0, count = 20) {
  const kind = g === 2592000 ? 'month' : g === 604800 ? 'week' : g;
  const end = periodStart(now, kind);
  return Array.from({ length: count }, (_, i) => {
    const epoch = kind === 'month'
      ? Date.UTC(2026, 10 - count + i, 1) / 1000
      : end - (count - i) * g;
    return { epoch, open: 100, close: 100, high: i % 5 === 2 ? 110 + offset : 105, low: i % 5 === 2 ? 90 - offset : 95 };
  });
}
function data() { return Object.fromEntries(frames.map(g => [g, candles(g)])); }

test('all 15 frames create Sure support and resistance without duplicate group labels', () => {
  const result = computeModifiedSr(data(), now, 100);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.support.map(x => x.label), ['Sure TFSR']);
  assert.deepEqual(result.resistance.map(x => x.label), ['Sure TFSR']);
  assert.equal(result.support[0].price, 90);
  assert.equal(result.resistance[0].price, 110);
});

test('a missing frame blocks its group and Sure, but not other groups', () => {
  const input = data(); input[2700] = [];
  const result = computeModifiedSr(input, now, 100);
  assert.deepEqual(result.missing, [2700]);
  assert.deepEqual(result.support.map(x => x.label), ['Low TFSR', 'High TFSR', 'Ultra TFSR']);
  assert.deepEqual(result.resistance.map(x => x.label), ['Low TFSR', 'High TFSR', 'Ultra TFSR']);
});

test('a group needs all frames and the entire spread must fit its smallest-frame ATR tolerance', () => {
  const input = data();
  input[300] = candles(300, 10);
  const result = computeModifiedSr(input, now, 100);
  assert.ok(!result.support.some(x => x.label === 'Low TFSR' || x.label === 'Sure TFSR'));
  assert.ok(!result.resistance.some(x => x.label === 'Low TFSR' || x.label === 'Sure TFSR'));
  assert.ok(result.support.some(x => x.label === 'Medium TFSR'));
});

test('a chain of individually close pivots cannot bridge a wider spread', () => {
  const input = data();
  input[180] = candles(180, 2);
  input[300] = candles(300, 4);
  const result = computeModifiedSr(input, now, 100);
  assert.ok(!result.support.some(x => x.label === 'Low TFSR' || x.label === 'Sure TFSR'));
});

test('closed monthly swings can contribute with less than 14 months of history', () => {
  const input = data(); input[2592000] = candles(2592000, 0, 8);
  const result = computeModifiedSr(input, now, 100);
  assert.ok(result.support.some(x => x.label === 'Sure TFSR'));
});

test('forming candles cannot create a confirmed swing', () => {
  const input = data();
  input[30] = candles(30, 0, 4);
  input[30].push({ epoch: periodStart(now, 30), open: 100, close: 100, high: 105, low: 95 });
  const result = computeModifiedSr(input, now, 100);
  assert.ok(result.missing.includes(30));
  assert.ok(!result.support.some(x => x.label === 'Low TFSR' || x.label === 'Sure TFSR'));
});

test('UTC week and month boundaries include leap days', () => {
  const date = Date.UTC(2024, 1, 29, 12) / 1000;
  assert.equal(periodStart(date, 'week'), Date.UTC(2024, 1, 26) / 1000);
  assert.equal(periodEnd(date, 'week'), Date.UTC(2024, 2, 4) / 1000);
  assert.equal(periodStart(date, 'month'), Date.UTC(2024, 1, 1) / 1000);
  assert.equal(periodEnd(date, 'month'), Date.UTC(2024, 2, 1) / 1000);
});

test('aggregation drops incomplete and gapped closed buckets, but retains complete and current buckets', () => {
  const source = Array.from({ length: 10 }, (_, i) => ({ epoch: i * 900, open: i, high: i + 1, low: i, close: i + 1 }));
  const result = aggregateCandles(source.filter(c => c.epoch !== 3600), 900, 2700, 8100);
  assert.deepEqual(result.map(c => c.epoch), [0, 5400, 8100]);
  assert.deepEqual(result[0], { epoch: 0, open: 0, high: 3, low: 0, close: 3 });
  assert.deepEqual(aggregateCandles(source.slice(1, 3), 900, 2700, 2700), []);
});
