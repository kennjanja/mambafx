/**
 * src/bazu/stakeLadder3m.js  (pure)
 * Stake multiplier ladder: after a win the last stake is multiplied by `afterWin`, after a loss by `afterLoss`
 * (1 = unchanged). After `resetEvery` settled trades the stake returns to the base stake and the count restarts.
 * Ties keep the stake. This only computes the next stake; purchase limits still apply in the choke point.
 */
export const LADDER_DEFAULT = Object.freeze({ afterWin: 1, afterLoss: 1, resetEvery: 5 });

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };

export function normalizeLadder(o = {}) {
  return {
    afterWin: num(o.afterWin, 1),
    afterLoss: num(o.afterLoss, 1),
    resetEvery: Math.max(1, Math.floor(num(o.resetEvery, LADDER_DEFAULT.resetEvery))),
  };
}

export const ladderActive = (l) => l.afterWin !== 1 || l.afterLoss !== 1;

/**
 * Called once per settled trade. result: 'win' | 'loss' | anything else (tie/unknown).
 * Returns { stake, count } where count is the number of settled trades since the last reset.
 */
export function nextLadderStake({ ladder, base, lastStake, result, count }) {
  const l = normalizeLadder(ladder);
  const n = count + 1;
  if (n >= l.resetEvery) return { stake: base, count: 0, reset: true };
  const mult = result === "win" ? l.afterWin : result === "loss" ? l.afterLoss : 1;
  return { stake: +Math.max(0.35, lastStake * mult).toFixed(2), count: n, reset: false };
}
