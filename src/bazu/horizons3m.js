/**
 * src/bazu/horizons3m.js  (pure)
 * Fixed, pre-registered definition of "directionally correct" and the metrics used to judge every Bazu component.
 *
 * Outcome at horizon h (ticks): entry = the FIRST tick after the decision (index k+1), exit = tick k+1+h.
 * direction +1 correct when exit > entry, -1 correct when exit < entry; an unchanged price is a TIE (counted as incorrect,
 * as on Deriv) and reported separately. Excursions are measured from entry over the same window.
 */
import { wilson, brierScore, reliability } from './stats.js?v=15';

export const HORIZONS = Object.freeze([1, 3, 5, 10, 20]);

/** Outcome record for a decision at tick index k, or null while the data does not yet reach the horizon. */
export function outcomeAt(prices, k, dir, horizons = HORIZONS) {
  const e = k + 1; if (e >= prices.length) return null;
  const out = { entry: prices[e], h: {}, mfe: 0, mae: 0 };
  const last = Math.min(prices.length - 1, e + Math.max(...horizons));
  for (let t = e + 1; t <= last; t++) { const mv = (prices[t] - prices[e]) * dir; if (mv > out.mfe) out.mfe = mv; if (mv < out.mae) out.mae = mv; }
  for (const h of horizons) {
    const x = e + h; if (x >= prices.length) { out.h[h] = null; continue; }
    const mv = (prices[x] - prices[e]) * dir;
    out.h[h] = mv > 0 ? 'win' : mv < 0 ? 'loss' : 'tie';
  }
  return out;
}

/** Accuracy, balanced accuracy (Rise vs Fall) and Wilson interval. rows: [{ dir, result: 'win'|'loss'|'tie'|null, prob? }]. */
export function accuracy(rows) {
  const ev = rows.filter((r) => r.result);
  const side = (d) => { const s = ev.filter((r) => r.dir === d); return { n: s.length, wins: s.filter((r) => r.result === 'win').length }; };
  const up = side(1), dn = side(-1), n = ev.length, wins = up.wins + dn.wins;
  const rate = (s) => (s.n ? s.wins / s.n : null);
  const parts = [rate(up), rate(dn)].filter((x) => x != null);
  return {
    n, wins, ties: ev.filter((r) => r.result === 'tie').length, accuracy: n ? wins / n : null,
    balanced: parts.length ? parts.reduce((s, x) => s + x, 0) / parts.length : null, up, down: dn, ci95: n ? wilson(wins, n) : null,
  };
}

/** Group observations by a key and report accuracy per group at one horizon. obs: [{ dir, outcome, ...fields }]. */
export function byGroup(obs, keyFn, h) {
  const g = new Map();
  for (const o of obs) { const k = keyFn(o); if (k == null) continue; (g.get(k) || g.set(k, []).get(k)).push({ dir: o.dir, result: o.outcome?.h?.[h] ?? null, prob: o.prob }); }
  return Object.fromEntries([...g].map(([k, rows]) => [k, accuracy(rows)]));
}

/** Calibration of a reported probability/score against realised wins (Brier + reliability bins). */
export function calibration(rows, bins = 5) {
  const r = rows.filter((x) => x.result && x.result !== 'tie' && Number.isFinite(x.prob));
  if (!r.length) return { n: 0, brier: null, bins: [] };
  const probs = r.map((x) => x.prob), y = r.map((x) => (x.result === 'win' ? 1 : 0));
  return { n: r.length, brier: brierScore(probs, y), bins: reliability(probs, y, bins) };
}
