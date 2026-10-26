import test from 'node:test';
import assert from 'node:assert/strict';
import { parseActiveSymbols, parseContractsFor, pickDurations, parseDur } from '../../src/bazu/universe.js';

const cf = (types) => ({ contracts_for: { available: types } });
const t = (type, expiry, lo, hi) => ({ contract_category: 'callput', contract_type: type, expiry_type: expiry, min_contract_duration: lo, max_contract_duration: hi });

test('active symbols filtered to open synthetic indices', () => {
  const r = parseActiveSymbols([
    { underlying_symbol: 'R_100', market: 'synthetic_index', pip_size: 0.01 },
    { underlying_symbol: 'frxEURUSD', market: 'forex' },
    { underlying_symbol: 'X', market: 'synthetic_index', is_trading_suspended: 1 },
  ]);
  assert.deepEqual(r.map((x) => x.symbol), ['R_100']);
});

test('jump and step indices are excluded; all volatility indices are kept', () => {
  const syn = (underlying_symbol, extra = {}) => ({ underlying_symbol, market: 'synthetic_index', ...extra });
  const r = parseActiveSymbols([
    syn('R_10'), syn('R_75'), syn('1HZ10V'), syn('1HZ150V'), syn('1HZ250V'),
    syn('JD10', { submarket: 'jump_index' }), syn('JD100'), syn('stpRNG', { submarket: 'step_index' }), syn('stpRNG3'), syn('STP200'),
    syn('X', { underlying_symbol_name: 'Step Index 500' }),
  ]);
  assert.deepEqual(r.map((x) => x.symbol), ['R_10', 'R_75', '1HZ10V', '1HZ150V', '1HZ250V']);
});

test('skips symbols without Rise/Fall', () => {
  assert.equal(parseContractsFor(cf([{ contract_category: 'accumulator', contract_type: 'ACCU' }])), null);
});

test('durations only those Deriv allows', () => {
  const r = parseContractsFor(cf([t('CALL', 'tick', '1t', '10t'), t('PUT', 'tick', '1t', '10t'), t('CALL', 'intraday', '15s', '1d'), t('PUT', 'intraday', '15s', '1d')]));
  assert.deepEqual(pickDurations(r.ranges, 3).map((d) => `${d.n}${d.unit}`), ['5t', '10t', '30s']);
  const w = parseContractsFor(cf([t('CALL', 'intraday', '15m', '10h'), t('PUT', 'intraday', '15m', '10h')]));
  assert.deepEqual(pickDurations(w.ranges, 3).map((d) => `${d.n}${d.unit}`), ['15m']);
  assert.deepEqual(parseDur('15s'), { n: 15, unit: 's' });
});
