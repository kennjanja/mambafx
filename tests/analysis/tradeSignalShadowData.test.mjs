import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateClosedTicks, contractDurationSeconds, indicativeDurationRange } from '../../src/analysis/tradeSignalShadowData.js';

const contracts = [
  { contract_type: 'CALL', contract_category: 'callput', min_contract_duration: '15s', max_contract_duration: '1d', expiry_type: 'intraday' },
  { contract_type: 'PUT', contract_category: 'callput', min_contract_duration: '1t', max_contract_duration: '10t', expiry_type: 'tick' },
];

test('public duration ranges are indicative, direction-specific, and never convert ticks to seconds', () => {
  assert.equal(contractDurationSeconds('4m'), 240);
  assert.equal(contractDurationSeconds('9m'), 540);
  assert.equal(contractDurationSeconds('10t'), null);
  assert.equal(contractDurationSeconds('0s'), null);
  assert.equal(indicativeDurationRange(contracts, 1, 10).status, 'outside-indicative-range');
  assert.equal(indicativeDurationRange(contracts, 1, 240).status, 'in-indicative-range');
  assert.equal(indicativeDurationRange(contracts, 1, 540).status, 'in-indicative-range');
  assert.equal(indicativeDurationRange(contracts, -1, 240).status, 'unknown');
  assert.equal(indicativeDurationRange([{ ...contracts[0], min_contract_duration: '10s' }], 1, 10).status, 'in-indicative-range');
  assert.equal(indicativeDurationRange([...contracts, { ...contracts[0], min_contract_duration: 'unknown' }], 1, 10).status, 'unknown');
});

test('tick aggregation excludes the partial first bucket and any unfinished or future bucket', () => {
  const history = { times: [1, 4, 10, 12, 19, 20, 29, 30, 39, 40], prices: [9, 8, 10, 12, 11, 13, 14, 15, 16, 99] };
  assert.deepEqual(aggregateClosedTicks(history, 10, 35).candles, [
    { epoch: 10, open: 10, high: 12, low: 10, close: 11 },
    { epoch: 20, open: 13, high: 14, low: 13, close: 14 },
  ]);
});

test('missing buckets are not synthesized and only the contiguous tail is returned', () => {
  const result = aggregateClosedTicks({ times: [0, 10, 30, 40], prices: [1, 2, 3, 4] }, 10, 50);
  assert.deepEqual(result.candles.map((c) => c.epoch), [30, 40]);
  assert.equal(result.discardedBeforeLastGap, 1);
  assert.equal(result.isCurrent, true);
  assert.match(result.limitation, /not guaranteed/);
});

test('future prices cannot affect closed candles and stale data is identified', () => {
  const base = { times: [0, 10, 20, 40], prices: [1, 2, 3, 4] };
  const mutated = { ...base, prices: [1, 2, 3, null] };
  const original = aggregateClosedTicks(base, 10, 35);
  const changed = aggregateClosedTicks(mutated, 10, 35);
  assert.deepEqual(changed.candles, original.candles);
  assert.equal(original.isCurrent, true);
  assert.equal(aggregateClosedTicks(base, 10, 39).isCurrent, true);
  assert.equal(aggregateClosedTicks(base, 10, 40).isCurrent, false);
});

test('bad, unordered, or mismatched tick input fails explicitly', () => {
  assert.throws(() => aggregateClosedTicks({ times: [2, 1], prices: [1, 1] }, 1, 5), /unordered/);
  assert.throws(() => aggregateClosedTicks({ times: [1], prices: [] }, 1, 5), /equal-length/);
  assert.throws(() => aggregateClosedTicks({ times: [1], prices: [0] }, 1, 5), /Invalid/);
  assert.throws(() => aggregateClosedTicks({ times: [], prices: [] }, 0, 5), /whole seconds/);
});
