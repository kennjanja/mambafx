// Shared data contract and primitives for the structure / liquidity engine.
// Pure and deterministic: no DOM, no clock, no randomness.
//
// Candle: { epoch (s), open, high, low, close }. Indices always refer to the *sanitised* array.
// Every event carries `index` (where it happened) and `confirmedIndex` (first bar at which it was
// knowable). Nothing known at bar i ever depends on bars after i.

export const DEFAULTS = Object.freeze({
  atrPeriod: 14,
  internalPivot: 3,
  swingPivot: 10,
  breakMode: 'close', // 'close' | 'wick'
  displacementAtr: 1.5,
  displacementMultiBars: 3,
  eqTolAtr: 0.25,
  sweepConfirmBars: 1,
  poolMaxAge: 300,
  reactionBars: 5,
});

export function sanitize(input) {
  const candles = [];
  let dropped = 0;
  if (!Array.isArray(input)) return { candles, dropped: 0 };
  let lastEpoch = -Infinity;
  for (const c of input) {
    if (!c || ![c.epoch, c.open, c.high, c.low, c.close].every(Number.isFinite)
      || c.high < c.low || c.high < Math.max(c.open, c.close) || c.low > Math.min(c.open, c.close)
      || c.epoch <= lastEpoch) { dropped++; continue; }
    candles.push(c); lastEpoch = c.epoch;
  }
  return { candles, dropped };
}

export function anatomy(c) {
  const range = c.high - c.low;
  const body = Math.abs(c.close - c.open);
  return {
    range, body,
    upperWick: c.high - Math.max(c.open, c.close),
    lowerWick: Math.min(c.open, c.close) - c.low,
    dir: c.close > c.open ? 1 : c.close < c.open ? -1 : 0,
    bodyRatio: range > 0 ? body / range : 0,
  };
}

// Wilder ATR. atr[i] uses candles 0..i only; null until `period` candles exist.
export function atrSeries(candles, period = DEFAULTS.atrPeriod) {
  const out = new Array(candles.length).fill(null);
  let sum = 0, prev = null;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const tr = i === 0 ? c.high - c.low
      : Math.max(c.high - c.low, Math.abs(c.high - candles[i - 1].close), Math.abs(c.low - candles[i - 1].close));
    if (i < period) {
      sum += tr;
      if (i === period - 1) { prev = sum / period; out[i] = prev; }
    } else {
      prev = (prev * (period - 1) + tr) / period;
      out[i] = prev;
    }
  }
  return out;
}

// UTC period bucket ids (week starts Monday).
export const dayId = (epoch) => Math.floor(epoch / 86400);
export const weekId = (epoch) => Math.floor((Math.floor(epoch / 86400) + 3) / 7);
