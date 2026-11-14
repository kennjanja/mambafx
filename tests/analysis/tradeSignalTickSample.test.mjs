import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { aggregateClosedTicks } from '../../src/analysis/tradeSignalShadowData.js';

test('captured R_100 sample is unchanged and closed tick candles match independent aggregation', () => {
  const raw = readFileSync(new URL('../../reports/trade-signal-ticks-r100.json', import.meta.url));
  assert.equal(createHash('sha256').update(raw).digest('hex'), '9b345538c07e040b94d7f4c9803186894ca1d68226150dd3d4343a96ec3a11bb');
  const sample = JSON.parse(raw), { times, prices } = sample.response.history;
  assert.equal(sample.response.echo_req.ticks_history, 'R_100');
  assert.equal(times.length, 1000);
  assert.equal(prices.length, times.length);
  for (let i = 0; i < times.length; i++) {
    assert.ok(Number.isSafeInteger(times[i]) && Number.isFinite(prices[i]) && prices[i] > 0);
    if (i) assert.equal(times[i] - times[i - 1], 2);
  }
  const asOf = times.at(-1);
  for (const [g, count] of [[10, 198], [30, 66], [60, 33]]) {
    const first = Math.floor(times[0] / g) * g, groups = new Map();
    for (let i = 0; i < times.length; i++) {
      const epoch = Math.floor(times[i] / g) * g;
      if (epoch <= first || epoch + g > asOf) continue;
      const group = groups.get(epoch) || [];
      group.push(prices[i]); groups.set(epoch, group);
    }
    const expected = [...groups].map(([epoch, p]) => ({ epoch, open: p[0], high: Math.max(...p), low: Math.min(...p), close: p.at(-1) }));
    assert.equal(expected.length, count);
    assert.deepEqual(aggregateClosedTicks({ times, prices }, g, asOf).candles, expected);
  }
});

test('captured tick candles agree with truncation at multiple historical as-of times', () => {
  const { response: { history } } = JSON.parse(readFileSync(new URL('../../reports/trade-signal-ticks-r100.json', import.meta.url)));
  for (const g of [10, 30, 60]) {
    for (const index of [100, 333, 700]) {
      const asOf = history.times[index];
      const prefix = { times: history.times.slice(0, index + 1), prices: history.prices.slice(0, index + 1) };
      assert.deepEqual(aggregateClosedTicks(history, g, asOf).candles, aggregateClosedTicks(prefix, g, asOf).candles);
      assert.ok(aggregateClosedTicks(history, g, asOf).candles.every((candle) => candle.epoch + g <= asOf));
    }
  }
});
