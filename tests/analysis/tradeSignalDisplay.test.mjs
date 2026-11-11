import test from 'node:test';
import assert from 'node:assert/strict';
import { tradeSignalDisplay } from '../../src/analysis/tradeSignalDisplay.js';

const setup = (overrides = {}) => ({
  symbol: 'R_25', profile: 'scalp', status: 'watching', dir: 1,
  bias: { verdict: 'bullish-lean', balance: 0.4 }, overallBalance: 0.4,
  lifecycleState: 'Watching', reason: 'Location Gate: waiting for a qualifying location',
  layers: { signal: false, missingLayer: 'Location Gate',
    location: { status: 'Watching', reason: 'waiting for a qualifying location', evidence: [] },
    entry: { status: 'Watching' } },
  modelProgress: { best: { id: 'A', name: 'Liquidity Sweep Reversal', matched: 3, total: 3 } },
  ...overrides,
});

test('bias uses reported verdict and balance, including insufficient and neutral', () => {
  assert.equal(tradeSignalDisplay(setup()).biasText, 'Bullish');
  const bear = tradeSignalDisplay(setup({ dir: -1, bias: { verdict: 'bearish-lean', balance: -0.5 }, overallBalance: -0.5 }));
  assert.equal(bear.biasText, 'Bearish'); assert.equal(bear.balance, -0.5);
  assert.equal(tradeSignalDisplay(setup({ bias: { verdict: 'inconclusive' } })).biasStatus, 'NOT MET');
  assert.equal(tradeSignalDisplay(setup({ bias: { verdict: 'insufficient-data' } })).biasText, 'Insufficient data');
});

test('completed diagnostic sequence does not pass location, model or authorization', () => {
  const display = tradeSignalDisplay(setup());
  assert.equal(display.overall, 'WAITING FOR LOCATION');
  assert.equal(display.locationStatus, 'PENDING');
  assert.equal(display.entryStatus, 'PENDING');
  assert.match(display.sequenceStatus, /complete.*not confirmed/);
  assert.match(display.authorization, /No qualified signal/);
  assert.deepEqual(display.remaining, []);
});

test('engine approaching location is a passed gate while model confirmation remains pending', () => {
  const display = tradeSignalDisplay(setup({ lifecycleState: 'Approaching Location', reason: 'Entry Confirmation: waiting for a complete ordered entry-model sequence',
    layers: { signal: false, missingLayer: 'Entry Confirmation',
      location: { status: 'Approaching Location', reason: 'price is near a context-aligned location', evidence: [{ label: 'OB bullish nearby' }] },
      entry: { status: 'Watching' } },
    modelProgress: { best: { id: 'A', name: 'Liquidity Sweep Reversal', matched: 1, total: 3 } },
  }));
  assert.equal(display.overall, 'WAITING FOR ENTRY CONFIRMATION');
  assert.equal(display.lifecycle, 'Approaching Location');
  assert.equal(display.locationStatus, 'PASSED');
  assert.equal(display.locationText, 'OB bullish nearby');
  assert.deepEqual(display.confirmed, ['significant sweep']);
  assert.deepEqual(display.remaining, ['displacement', 'structure shift']);
});

test('confirmed model and full engine signal qualify separately from actual purchase', () => {
  const display = tradeSignalDisplay(setup({ status: 'signal', lifecycleState: 'Signal Active',
    reason: undefined, primaryModel: { model_id: 'C', name: 'FVG Continuation', confirmingEvents: [{ type: 'reaction', label: 'reaction' }] },
    layers: { signal: true, location: { status: 'Approaching Location', evidence: [{ label: 'FVG bullish retest in progress' }] }, entry: { status: 'Trigger Detected' } },
  }));
  assert.equal(display.overall, 'QUALIFIED - ENTRY CONFIRMED');
  assert.equal(display.entryStatus, 'PASSED');
  assert.match(display.authorization, /order checks not evaluated/);
  assert.deepEqual(display.confirmed, ['reaction']);
});

test('completed diagnostic with a pending model reports the unavailable exact cause', () => {
  const display = tradeSignalDisplay(setup({ lifecycleState: 'Approaching Location',
    layers: { signal: false, missingLayer: 'Entry Confirmation',
      location: { status: 'Approaching Location', evidence: [] }, entry: { status: 'Watching' } } }));
  assert.match(display.reason, /does not report the specific unmet requirement/);
  assert.equal(display.entryStatus, 'PENDING');
});

test('terminal and restored rows never inherit a fabricated current qualification', () => {
  for (const [state, expected] of [['Invalidated Before Entry', 'INVALIDATED BEFORE ENTRY'], ['Expired Without Entry', 'EXPIRED WITHOUT ENTRY'], ['Insufficient Data', 'INSUFFICIENT DATA'], ['Closed', 'CLOSED']]) {
    const display = tradeSignalDisplay(setup({ lifecycleState: state, lifecycleHistory: [{ reason: 'terminal reason' }], status: 'signal' }));
    assert.equal(display.overall, expected);
    assert.equal(display.reason, 'terminal reason');
    assert.match(display.authorization, /terminal/);
  }
  const restored = tradeSignalDisplay(setup({ status: 'signal', lifecycleState: 'Signal Active', layers: undefined, modelProgress: undefined }));
  assert.equal(restored.overall, 'SIGNAL ACTIVE - DETAILS UNAVAILABLE');
  assert.equal(restored.locationStatus, 'NOT AVAILABLE');
  assert.equal(restored.entryStatus, 'NOT AVAILABLE');
});

test('different market/profile inputs and successive updates retain independent display states', () => {
  const a = setup();
  const b = setup({ symbol: 'R_50', profile: 'swing', bias: { verdict: 'bearish-lean' }, dir: -1 });
  assert.equal(tradeSignalDisplay(a).biasText, 'Bullish');
  assert.equal(tradeSignalDisplay(b).biasText, 'Bearish');
  const updated = { ...a, layers: { ...a.layers, missingLayer: 'Entry Confirmation', location: { status: 'Approaching Location', evidence: [] } } };
  assert.equal(tradeSignalDisplay(updated).overall, 'WAITING FOR ENTRY CONFIRMATION');
  assert.equal(tradeSignalDisplay(a).overall, 'WAITING FOR LOCATION');
});
