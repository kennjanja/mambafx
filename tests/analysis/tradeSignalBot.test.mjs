import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isVolatilityAbove100,
  nextSignalStake,
  signalDuration,
  signalPriceState,
  signalTradeKey,
  tradeBotLimitReached,
  validateTradeBotSettings,
} from '../../src/analysis/tradeSignalBot.js';

test('Trade Signal bot filters volatility indices strictly above 100', () => {
  assert.equal(isVolatilityAbove100('R_100', 'Volatility 100 Index'), false);
  assert.equal(isVolatilityAbove100('1HZ100V', 'Volatility 100 (1s) Index'), false);
  assert.equal(isVolatilityAbove100('R_150', 'Volatility 150 Index'), true);
  assert.equal(isVolatilityAbove100('1HZ250V', 'Volatility 250 (1s) Index'), true);
  assert.equal(isVolatilityAbove100('JD100', 'Jump 100 Index'), false);
});

test('signal identity is tied to confirmed model event, not repeated scans', () => {
  const signal = { status: 'signal', symbol: 'R_50', profile: 'scalp', dir: 1, confirmedAt: 123, primaryModel: { model_id: 'A' } };
  assert.equal(signalTradeKey(signal), 'R_50|scalp|1|A|123');
  assert.equal(signalTradeKey({ ...signal, entryAt: 125 }), signalTradeKey(signal));
  assert.equal(signalTradeKey({ ...signal, confirmedAt: 124 }), 'R_50|scalp|1|A|124');
  assert.equal(signalTradeKey({ ...signal, status: 'watching' }), null);
  assert.equal(signalTradeKey({ ...signal, confirmedAt: null }), null);
});

test('signal hold duration maps to Deriv seconds or minutes', () => {
  assert.deepEqual(signalDuration({ holdSec: 180 }), { duration: 3, durationUnit: 'm' });
  assert.deepEqual(signalDuration({ holdSec: 3600 }), { duration: 60, durationUnit: 'm' });
  assert.deepEqual(signalDuration({ holdSec: 15 }), { duration: 15, durationUnit: 's' });
  assert.equal(signalDuration({ holdSec: 0 }), null);
});

test('live entry coloring is direction-relative, with ties adverse', () => {
  assert.deepEqual(signalPriceState(1, 100, 101), { position:'above', favorable:true, className:'ts-current-good' });
  assert.deepEqual(signalPriceState(1, 100, 99), { position:'below', favorable:false, className:'ts-current-bad' });
  assert.deepEqual(signalPriceState(-1, 100, 99), { position:'below', favorable:true, className:'ts-current-good' });
  assert.deepEqual(signalPriceState(-1, 100, 101), { position:'above', favorable:false, className:'ts-current-bad' });
  assert.deepEqual(signalPriceState(1, 100, 100), { position:'at', favorable:false, className:'ts-current-bad' });
  assert.equal(signalPriceState(0, 100, 100), null);
});

test('flat and martingale stake progression respect settings', () => {
  assert.equal(nextSignalStake({ baseStake: 1, progression: 'flat', consecutiveLosses: 5, multiplier: 2 }), 1);
  assert.equal(nextSignalStake({ baseStake: 1, progression: 'martingale', consecutiveLosses: 3, multiplier: 2 }), 8);
  assert.equal(nextSignalStake({ baseStake: 1, progression: 'martingale', consecutiveLosses: 1000, multiplier: 10 }), null);
});

test('automatic execution requires account, positive take-profit and stop-loss', () => {
  const valid = { baseStake: 1, multiplier: 2, takeProfit: 10, stopLoss: 5, progression: 'martingale', accountType: 'demo' };
  assert.equal(validateTradeBotSettings(valid), null);
  assert.match(validateTradeBotSettings({ ...valid, takeProfit: 0 }), /take-profit/);
  assert.match(validateTradeBotSettings({ ...valid, stopLoss: -1 }), /stop-loss/);
  assert.match(validateTradeBotSettings({ ...valid, accountType: 'other' }), /account/);
});

test('session P/L limits stop further entries at the configured thresholds', () => {
  assert.equal(tradeBotLimitReached(10, 10, 5), true);
  assert.equal(tradeBotLimitReached(-5, 10, 5), true);
  assert.equal(tradeBotLimitReached(9.99, 10, 5), false);
  assert.equal(tradeBotLimitReached(-4.99, 10, 5), false);
});
