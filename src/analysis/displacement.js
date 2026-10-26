import { DEFAULTS, anatomy } from './core.js';

// Displacement: a candle (or short same-direction run) whose body is large relative to the ATR
// measured *before* it, so the candle cannot inflate its own yardstick.
export function detectDisplacement(candles, atr, opts = {}) {
  const mult = opts.displacementAtr ?? DEFAULTS.displacementAtr;
  const multiBars = opts.displacementMultiBars ?? DEFAULTS.displacementMultiBars;
  const events = [];
  const seen = new Set();
  for (let i = 1; i < candles.length; i++) {
    const a = atr[i - 1];
    if (!a) continue;
    const an = anatomy(candles[i]);
    if (an.dir !== 0 && an.body >= mult * a) {
      events.push({
        kind: 'single', dir: an.dir, index: i, startIndex: i, epoch: candles[i].epoch,
        confirmedIndex: i, strength: an.body / a, rangeExpansion: an.range / a,
        directional: an.bodyRatio, status: 'confirmed',
      });
      seen.add(i);
    }
  }
  // Multi-candle: net move of N consecutive same-colour candles >= 1.5x the single threshold.
  for (let i = multiBars; i < candles.length; i++) {
    const s = i - multiBars + 1;
    const a = atr[s - 1];
    if (!a || seen.has(i)) continue;
    const d0 = anatomy(candles[s]).dir;
    if (d0 === 0) continue;
    let ok = true;
    for (let k = s; k <= i; k++) if (anatomy(candles[k]).dir !== d0) { ok = false; break; }
    if (!ok) continue;
    const net = Math.abs(candles[i].close - candles[s].open);
    if (net >= mult * 1.5 * a) {
      events.push({
        kind: 'multi', dir: d0, index: i, startIndex: s, epoch: candles[i].epoch,
        confirmedIndex: i, strength: net / a, rangeExpansion: (Math.max(...candles.slice(s, i + 1).map(c => c.high)) - Math.min(...candles.slice(s, i + 1).map(c => c.low))) / a,
        directional: 1, status: 'confirmed',
      });
    }
  }
  events.sort((x, y) => x.index - y.index);
  return events;
}
