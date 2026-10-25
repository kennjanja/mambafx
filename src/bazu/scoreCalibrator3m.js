/**
 * src/bazu/scoreCalibrator3m.js  (pure)
 * Maps Bazu's composite score (0..1, a consensus score, NOT a probability) to an observed win frequency.
 * Equal-width score bins; each bin holds wins/n from labelled outcomes (horizons3m.outcomeAt, ties count as losses).
 * prob() uses a Beta(1,1) posterior mean for the bin, then enforces monotonicity (pool-adjacent-violators) so a higher
 * score never maps to a lower probability. Until `minN` labelled outcomes exist the result is flagged uncalibrated.
 */
const clamp01 = (x) => Math.max(0, Math.min(1, x));

export function createScoreCalibrator({ bins = 10, minN = 200 } = {}) {
  const wins = new Array(bins).fill(0), n = new Array(bins).fill(0);
  const binOf = (s) => Math.min(bins - 1, Math.floor(clamp01(s) * bins));
  const curve = () => {
    // pool adjacent violators over bin posterior means, weighted by n
    const blocks = [];
    for (let i = 0; i < bins; i++) {
      blocks.push({ w: wins[i] + 1, t: n[i] + 2, from: i, to: i });
      while (blocks.length > 1 && blocks.at(-2).w / blocks.at(-2).t > blocks.at(-1).w / blocks.at(-1).t) {
        const b = blocks.pop(), a = blocks.pop();
        blocks.push({ w: a.w + b.w, t: a.t + b.t, from: a.from, to: b.to });
      }
    }
    const out = new Array(bins);
    for (const b of blocks) for (let i = b.from; i <= b.to; i++) out[i] = b.w / b.t;
    return out;
  };
  return {
    add(score, won) { if (!Number.isFinite(score)) return; const b = binOf(score); n[b]++; if (won) wins[b]++; },
    total: () => n.reduce((s, x) => s + x, 0),
    prob(score) {
      const total = n.reduce((s, x) => s + x, 0);
      if (!Number.isFinite(score)) return { p: null, n: total, calibrated: false };
      const b = binOf(score);
      return { p: curve()[b], n: total, binN: n[b], calibrated: total >= minN && n[b] >= 20 };
    },
    table: () => { const c = curve(); return c.map((p, i) => ({ lo: i / bins, hi: (i + 1) / bins, n: n[i], observed: n[i] ? wins[i] / n[i] : null, calibrated: p })); },
    toJSON: () => ({ bins, minN, wins: [...wins], n: [...n] }),
    load(o) { if (o && o.bins === bins) for (let i = 0; i < bins; i++) { wins[i] = o.wins[i] | 0; n[i] = o.n[i] | 0; } return this; },
  };
}
