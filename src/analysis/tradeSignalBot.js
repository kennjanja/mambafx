export function isVolatilityAbove100(symbol, label = '') {
  const text = `${label} ${symbol}`.toUpperCase();
  if (!text.includes('VOLATILITY') && !/\b(?:1HZ|R_)\d+V?\b/.test(text)) return false;
  const match = text.match(/VOLATILITY\D*(\d+)|1HZ(\d+)V?\b|R_(\d+)V?\b/);
  if (!match) return false;
  const index = Number(match[1] || match[2] || match[3]);
  return Number.isFinite(index) && index > 100;
}

export function signalTradeKey(signal) {
  if (!signal || signal.status !== 'signal' || !Number.isFinite(signal.confirmedAt)) return null;
  const symbol = signal.symbol;
  const profile = signal.profile;
  const direction = signal.dir;
  const model = signal.primaryModel?.model_id || signal.primaryModel?.id;
  if (!symbol || !profile || ![-1, 1].includes(direction) || !model) return null;
  return `${symbol}|${profile}|${direction}|${model}|${signal.confirmedAt}`;
}

export function signalDuration(signal) {
  const holdSec = Number(signal?.holdSec);
  if (!Number.isInteger(holdSec) || holdSec < 1) return null;
  return holdSec >= 60 && holdSec % 60 === 0
    ? { duration: holdSec / 60, durationUnit: 'm' }
    : { duration: holdSec, durationUnit: 's' };
}

export function signalPriceState(direction, entry, current) {
  const dir = Number(direction), entryPrice = Number(entry), price = Number(current);
  if (![-1, 1].includes(dir) || !Number.isFinite(entryPrice) || !Number.isFinite(price)) return null;
  const favorable = (price - entryPrice) * dir > 0;
  return {
    position: price > entryPrice ? 'above' : price < entryPrice ? 'below' : 'at',
    favorable,
    className: favorable ? 'ts-current-good' : 'ts-current-bad',
  };
}

export function validateTradeBotSettings(settings, requireLimits = true) {
  const baseStake = Number(settings?.baseStake);
  const multiplier = Number(settings?.multiplier);
  const takeProfit = Number(settings?.takeProfit);
  const stopLoss = Number(settings?.stopLoss);
  if (!Number.isFinite(baseStake) || baseStake < 0.35) return 'Base stake must be at least 0.35.';
  if (!Number.isFinite(multiplier) || multiplier < 1 || multiplier > 10) return 'Martingale multiplier must be between 1 and 10.';
  if (requireLimits && (!Number.isFinite(takeProfit) || takeProfit <= 0)) return 'Set a take-profit amount greater than zero.';
  if (requireLimits && (!Number.isFinite(stopLoss) || stopLoss <= 0)) return 'Set a stop-loss amount greater than zero.';
  if (!['flat', 'martingale'].includes(settings?.progression)) return 'Choose Flat or Martingale progression.';
  if (!['demo', 'real'].includes(settings?.accountType)) return 'Choose a Demo or Real account.';
  return null;
}

export function nextSignalStake({ baseStake, multiplier, progression, consecutiveLosses }) {
  const base = Number(baseStake);
  if (!Number.isFinite(base) || base < 0.35) return null;
  if (progression === 'flat') return base;
  if (progression !== 'martingale') return null;
  const losses = Number(consecutiveLosses);
  const factor = Number(multiplier);
  if (!Number.isInteger(losses) || losses < 0 || !Number.isFinite(factor) || factor < 1 || factor > 10) return null;
  const stake = base * factor ** losses;
  return Number.isFinite(stake) ? stake : null;
}

export function tradeBotLimitReached(realizedPnl, takeProfit, stopLoss) {
  return Number(realizedPnl) >= Number(takeProfit) || Number(realizedPnl) <= -Number(stopLoss);
}
