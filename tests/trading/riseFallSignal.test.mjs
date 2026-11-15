import test from 'node:test';
import assert from 'node:assert/strict';
import { createRiseFallSample, discoverVolatilityMarkets, riseFallDirection } from '../../src/trading/riseFallSignal.mjs';

function sampleFromChanges(changes){
  const sample = createRiseFallSample();
  let value = 100;
  assert.equal(sample.observe(value), null);
  let result;
  for (const change of changes) result = sample.observe(value += change);
  return result;
}

test('requires two complete 50-tick windows and compares 49 changes', () => {
  const sample = createRiseFallSample();
  for (let i = 0; i < 50; i++) assert.equal(sample.observe(i), null);
  const result = sample.observe(50);
  assert.equal(result.risePercent, 100);
  assert.equal(result.riseIncreasing, false);
});

test('unchanged ticks count in the denominator and rise requires an increase', () => {
  const result = sampleFromChanges([-1, ...Array(27).fill(1), ...Array(21).fill(0), 1]);
  assert.equal(result.risePercent, 28 * 100 / 49);
  assert.equal(result.fallPercent, 0);
  assert.equal(result.riseIncreasing, true);
  assert.equal(riseFallDirection(result, 'bullish'), 'RISE');
  assert.equal(riseFallDirection(result, 'bearish'), null);
});

test('fall trigger is symmetric and requires bearish trend and more than 56 percent', () => {
  const result = sampleFromChanges([1, ...Array(27).fill(-1), ...Array(21).fill(0), -1]);
  assert.equal(result.fallPercent, 28 * 100 / 49);
  assert.equal(riseFallDirection(result, 'bearish'), 'FALL');
  assert.equal(riseFallDirection(result, 'bullish'), null);
  assert.equal(riseFallDirection({ fallPercent: 56, fallIncreasing: true }, 'bearish'), null);
  assert.equal(riseFallDirection({ fallPercent: 80, fallIncreasing: false }, 'bearish'), null);
});

test('reset prevents windows spanning a feed gap', () => {
  const sample = createRiseFallSample();
  for (let i = 0; i < 51; i++) sample.observe(i);
  sample.reset();
  for (let i = 0; i < 50; i++) assert.equal(sample.observe(i), null);
});

test('discovers active standard volatility indices without limiting the symbol list', () => {
  const rows = [
    { underlying_symbol: '1HZ15V', underlying_symbol_name: 'Volatility 15 (1s) Index', market: 'synthetic_index', exchange_is_open: 1 },
    { symbol: 'R_100', display_name: 'Volatility 100 Index', market: 'synthetic_index' },
    { symbol: '1HZ300V', display_name: 'Volatility 300 (1s) Index', market: 'synthetic_index' },
    { symbol: 'R_10', display_name: 'Volatility 10 Index', is_trading_suspended: 1 },
    { symbol: 'STP', display_name: 'Step Index' },
    { symbol: 'RANGE', display_name: 'Range Break 100 Index' },
  ];
  assert.deepEqual(discoverVolatilityMarkets(rows).map(x => x.symbol), ['1HZ15V', 'R_100', '1HZ300V']);
  assert.throws(() => discoverVolatilityMarkets(null), TypeError);
});
