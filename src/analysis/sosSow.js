// SOS / SOW detection on the latest CLOSED candle of any timeframe (pure; the page adds scanning and trading).
// SOS (sign of strength): close above the prior 20-candle range with a body of at least 1.5 ATR -> Rise.
// SOW (sign of weakness): close below that range with the same body size -> Fall.
// The definitions are the app's existing wyckoffEvents(); this module only decides which events are fresh enough to act on.
import { atrSeries } from './core.js';
import { wyckoffEvents } from './patterns.js';

export const GRANULARITIES = Object.freeze([60, 120, 180, 300, 900, 1800, 3600, 14400]);
export const MIN_CLOSED = 36;
export const tfLabel = (g) => (g >= 3600 ? g / 3600 + 'h' : g / 60 + 'm');
export const contractFor = (kind) => (kind === 'SOS' ? 'CALL' : kind === 'SOW' ? 'PUT' : null);

// Last boundary (epoch seconds) at which a candle of granularity g closed.
export const lastBoundary = (g, nowSec) => Math.floor(nowSec / g) * g;

// candles: ascending {epoch,open,high,low,close}; a candle still forming at nowSec is ignored.
// Returns the SOS/SOW that is on the last closed candle and closed no more than freshSec ago, else null.
export function detectFresh(candles, g, nowSec, freshSec = 45) {
  if (!Array.isArray(candles)) return null;
  const closed = candles.filter((c) => Number.isFinite(c.epoch) && c.epoch + g <= nowSec);
  if (closed.length < MIN_CLOSED) return null;
  const last = closed[closed.length - 1], closeAt = last.epoch + g;
  if (nowSec - closeAt > freshSec) return null;
  const ev = wyckoffEvents(closed, atrSeries(closed)).find((e) => e.index === closed.length - 1 && (e.kind === 'SOS' || e.kind === 'SOW'));
  if (!ev) return null;
  return { kind: ev.kind, dir: ev.dir, contractType: contractFor(ev.kind), g, tf: tfLabel(g), candleEpoch: last.epoch, closeAt, level: ev.level, close: last.close };
}
