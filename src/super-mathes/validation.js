import { brier, logLoss } from "../ldpe/engine.js";
import { frequencyDistribution, rankDistribution, UNIFORM } from "./models.js";

// Expanding-window forecasts: each outcome is scored before it enters the training prefix.
export function walkForward(digits, { warmup = 100 } = {}) {
  if (!Number.isInteger(warmup) || warmup < 1) throw new Error("Invalid warmup");
  frequencyDistribution(digits);
  const rows = [];
  const counts = Array(10).fill(1);
  for (const digit of digits.slice(0, warmup)) counts[digit]++;
  for (let i = warmup; i < digits.length; i++) {
    const candidate = counts.map(count => count / (i + 10));
    const ranking = rankDistribution(candidate);
    const actual = digits[i];
    rows.push({
      trainingSize: i, actual, candidate, uniform: [...UNIFORM],
      top1: ranking[0].digit === actual, top2: ranking.slice(0, 2).some(x => x.digit === actual),
      top3: ranking.slice(0, 3).some(x => x.digit === actual),
      logLoss: logLoss(candidate, actual), uniformLogLoss: logLoss(UNIFORM, actual),
      brier: brier(candidate, actual), uniformBrier: brier(UNIFORM, actual),
    });
    counts[actual]++;
  }
  if (!rows.length) return { status: "Insufficient Evidence", n: 0, rows };
  const mean = f => rows.reduce((sum, row) => sum + f(row), 0) / rows.length;
  return {
    status: "Under Validation", n: rows.length, rows,
    top1: mean(r => Number(r.top1)), top2: mean(r => Number(r.top2)), top3: mean(r => Number(r.top3)),
    logLoss: mean(r => r.logLoss), uniformLogLoss: mean(r => r.uniformLogLoss),
    brier: mean(r => r.brier), uniformBrier: mean(r => r.uniformBrier),
  };
}
