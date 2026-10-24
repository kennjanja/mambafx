// Synthetic stress test: the listed mechanisms are planted by construction.
// This does not estimate whether Deriv or any real market has these properties.
// Run: node tests/ldpe/evaluate-assumptions.mjs [ticks-per-seed] [seed-count]
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ldpe, validVector } from "../../src/ldpe/engine.js";
import {
  CandidateForecaster, fitTuningParameters, normalizeProbabilities,
} from "../../src/ldpe/evaluation/models.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUTPUT = path.join(ROOT, "docs", "ldpe-assumption-stress-test.md");
const TICKS = Math.max(5000, Number(process.argv[2]) || 15000);
const SEEDS = Math.max(1, Number(process.argv[3]) || 3);
const SCENARIOS = [
  ["biased-frequency", "A stable non-uniform marginal digit distribution"],
  ["markov-dependence", "The next digit depends strongly on the previous digit"],
  ["lag-memory", "A digit from four ticks earlier predicts the next digit"],
  ["due-gap", "The longest-absent digit becomes more likely after a threshold"],
  ["streak-persistence", "A current digit run is likely to continue"],
  ["increment-memory", "Modulo-10 increments tend to repeat"],
  ["regime-shift", "The favored digit changes halfway through the series"],
  ["combined-all", "All of the above mechanisms act together, plus recent-frequency feedback"],
];
const CURRENT = ["dirichlet", "freqShort", "freqLong", "decayed", "trans1", "trans2", "gap", "streak"];
const CANDIDATES = ["hdm", "ddir", "ctw", "inc", "lag"];
const UNIFORM = Array(10).fill(0.1);
const HORIZONS = [1, 5];

function rng(seed) {
  let a = seed | 0;
  return () => {
    a |= 0;
    a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function softmax(logits) {
  const max = Math.max(...logits);
  return normalizeProbabilities(logits.map((value) => Math.exp(value - max)));
}

function digitGap(history, digit) {
  for (let i = history.length - 1; i >= 0; i--) if (history[i] === digit) return history.length - i;
  return history.length + 1;
}

function features(kind, history, index, total) {
  const score = Array(10).fill(0);
  const strength = kind === "combined-all" ? 0.4 : 1;
  const last = history.at(-1);
  const run = history.length && history.slice().reverse().findIndex((digit) => digit !== last);
  const runLength = last === undefined ? 0 : (run < 0 ? history.length : run);
  const gaps = Array.from({ length: 10 }, (_, digit) => digitGap(history, digit));
  const oldest = gaps.indexOf(Math.max(...gaps));
  const lastIncrement = history.length > 1
    ? (history.at(-1) - history.at(-2) + 10) % 10 : null;
  const previousIncrement = history.length > 2
    ? (history.at(-2) - history.at(-3) + 10) % 10 : null;
  const apply = (feature) => {
    if (feature === "frequency") {
      score[4] += 1.8 * strength; score[7] += 1.1 * strength;
    }
    if (feature === "markov" && last !== undefined) score[last] += 2.2 * strength;
    if (feature === "memory" && history.length >= 4) score[history.at(-4)] += 2.2 * strength;
    if (feature === "gap" && oldest >= 0 && gaps[oldest] >= 10) score[oldest] += 2.5 * strength;
    if (feature === "streak" && last !== undefined && runLength >= 2) score[last] += 2.0 * strength;
    if (feature === "increment" && lastIncrement !== null && previousIncrement !== null &&
        lastIncrement === previousIncrement && last !== undefined) {
      score[(last + lastIncrement) % 10] += 2.3 * strength;
    }
    if (feature === "regime") score[index < total / 2 ? 2 : 8] += 2.0 * strength;
  };

  const single = {
    "biased-frequency": ["frequency"],
    "markov-dependence": ["markov"],
    "lag-memory": ["memory"],
    "due-gap": ["gap"],
    "streak-persistence": ["streak"],
    "increment-memory": ["increment"],
    "regime-shift": ["regime"],
  }[kind];
  if (single) single.forEach(apply);
  if (kind === "combined-all") {
    ["frequency", "markov", "memory", "gap", "streak", "increment", "regime"].forEach(apply);
    if (history.length >= 10) {
      const recent = Array(10).fill(0);
      for (const digit of history.slice(-100)) recent[digit]++;
      const n = Math.min(100, history.length);
      for (let digit = 0; digit < 10; digit++) {
        score[digit] += 0.2 * Math.log((recent[digit] + 1) / (n / 10 + 1));
      }
    }
  }
  return softmax(score);
}

function draw(probabilities, random) {
  let value = random();
  for (let digit = 0; digit < probabilities.length - 1; digit++) {
    value -= probabilities[digit];
    if (value < 0) return digit;
  }
  return probabilities.length - 1;
}

function generate(kind, seed) {
  const random = rng(seed), digits = [], truth = [];
  for (let index = 0; index < TICKS; index++) {
    const probabilities = features(kind, digits, index, TICKS);
    truth.push(probabilities);
    digits.push(draw(probabilities, random));
  }
  return { digits, truth };
}

function newScore() {
  return { n: 0, logLoss: 0, brier: 0, hits: 0 };
}

function addScore(score, probabilities, actual) {
  if (!validVector(probabilities, 1e-8)) throw new Error("model emitted an invalid probability vector");
  score.n++;
  score.logLoss -= Math.log(Math.max(probabilities[actual], 1e-12));
  score.brier += probabilities.reduce((sum, value, digit) =>
    sum + (value - (digit === actual ? 1 : 0)) ** 2, 0);
  const maximum = Math.max(...probabilities);
  const tied = probabilities.filter((value) => Math.abs(value - maximum) <= 1e-12).length;
  if (Math.abs(probabilities[actual] - maximum) <= 1e-12) score.hits += 1 / tied;
}

function createScoreMap() {
  return Object.fromEntries(["uniform", "ensemble", ...CURRENT, ...CANDIDATES, "oracle"].map(
    (name) => [name, newScore()],
  ));
}

function summarize(score) {
  if (!score.n) return { n: 0, logLoss: null, brier: null, top1: null };
  return {
    n: score.n,
    logLoss: score.logLoss / score.n,
    brier: score.brier / score.n,
    top1: score.hits / score.n,
  };
}

function evaluate(kind, seed, horizon, series) {
  const tuningEnd = Math.floor(TICKS * 0.2);
  const params = fitTuningParameters(series.digits.slice(0, tuningEnd), horizon);
  const candidates = Object.fromEntries(CANDIDATES.map((family) =>
    [family, new CandidateForecaster(family, horizon, params)]));
  const engine = new Ldpe({ horizon, minTicks: 100 });
  engine.historyMax = 2000;
  const scores = createScoreMap(), pending = new Map();
  const metrics = new Map();

  for (let index = 0; index < TICKS; index++) {
    const actual = series.digits[index];
    const due = pending.get(index);
    if (due && index >= tuningEnd) {
      for (const name of ["uniform", "ensemble", ...CURRENT, ...CANDIDATES]) {
        if (due[name]) addScore(scores[name], due[name], actual);
      }
      if (horizon === 1) addScore(scores.oracle, due.oracle, actual);
    }

    const ingested = engine.ingest("synthetic", {
      epoch: 1000 + index,
      quote: `100.0${actual}`,
      decimals: 2,
    });
    if (!ingested.accepted) throw new Error(`${kind}/${seed}: synthetic tick rejected at ${index}`);
    for (const candidate of Object.values(candidates)) candidate.observe(actual);

    const targetIndex = index + horizon;
    if (targetIndex >= TICKS || index < tuningEnd) continue;
    const forecast = ingested.forecast;
    const vectors = {
      uniform: UNIFORM,
      ensemble: forecast.vectors.ensemble,
      oracle: series.truth[targetIndex],
    };
    for (const name of CURRENT) vectors[name] = forecast.vectors.modules[name];
    for (const family of CANDIDATES) vectors[family] = candidates[family].predict();
    pending.set(targetIndex, vectors);
  }
  for (const [name, score] of Object.entries(scores)) metrics.set(name, summarize(score));
  return { scenario: kind, seed, horizon, metrics: Object.fromEntries(metrics) };
}

function aggregate(runs) {
  const out = {};
  for (const name of ["uniform", "ensemble", ...CURRENT, ...CANDIDATES, "oracle"]) {
    const rows = runs.map((run) => run.metrics[name]).filter((row) => row.n);
    const n = rows.reduce((sum, row) => sum + row.n, 0);
    out[name] = n ? {
      n,
      logLoss: rows.reduce((sum, row) => sum + row.n * row.logLoss, 0) / n,
      brier: rows.reduce((sum, row) => sum + row.n * row.brier, 0) / n,
      top1: rows.reduce((sum, row) => sum + row.n * row.top1, 0) / n,
    } : null;
  }
  return out;
}

function signed(value, digits = 3) {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

const results = [];
for (const [scenario, description] of SCENARIOS) {
  for (const horizon of HORIZONS) {
    const runs = [];
    for (let seed = 1; seed <= SEEDS; seed++) {
      const series = generate(scenario, seed * 7919 + horizon * 131);
      runs.push(evaluate(scenario, seed, horizon, series));
    }
    results.push({ scenario, description, horizon, seeds: SEEDS, metrics: aggregate(runs), runs });
    console.log(`${scenario} h=${horizon}: ${runs.reduce((sum, run) => sum + run.metrics.ensemble.n, 0)} paired ensemble forecasts complete`);
  }
}

const modelNames = ["uniform", "ensemble", ...CURRENT, ...CANDIDATES, "oracle"];
const labels = {
  uniform: "Uniform baseline", ensemble: "Current ensemble", dirichlet: "Current Dirichlet",
  freqShort: "Current freqShort", freqLong: "Current freqLong", decayed: "Current decayed",
  trans1: "Current trans1", trans2: "Current trans2", gap: "Current gap", streak: "Current streak",
  hdm: "Candidate HDM", ddir: "Candidate discounted Dirichlet", ctw: "Candidate CTW-3",
  inc: "Candidate modular increment", lag: "Candidate lag tables", oracle: "Generator oracle (h=1)",
};
const lines = [
  "# LDPE synthetic assumption stress test",
  "",
  `Generated ${new Date().toISOString()}. Each scenario used ${TICKS.toLocaleString()} ticks per seed, ${SEEDS} deterministic seeds, and horizons ${HORIZONS.join(" and ")}. The first 20% was reserved for candidate tuning/warm-up; scores are from subsequent forecasts.`,
  "",
  "> **Synthetic data only.** These mechanisms were deliberately planted by the generator. This tests whether models can exploit known synthetic dependencies; it is not evidence that Deriv indices have these properties or that any edge is tradable.",
  "",
  "At horizon 1, the generator's exact conditional distribution is also scored as an oracle upper bound. At horizon 5, the oracle column is omitted because this benchmark does not compute the exact five-step conditional distribution. Model estimates use the observed prefix only. All models are scored on the same target outcomes within each scenario and horizon.",
  "",
  "Scores are forecast-count-weighted across seeds. ΔLL is `log loss of reference - log loss of model`, in millinats per forecast; positive is better. Top-1 handles exact probability ties by splitting credit equally across tied digits (so a uniform forecast scores 10%, not whichever digit happens to be first). Brier and top-1 are descriptive. This benchmark does not make a production promotion decision.",
  "",
  "The current LDPE has eight model modules (Dirichlet, freqShort, freqLong, decayed, trans1, trans2, gap, streak); all eight are included, alongside the current ensemble and all five new candidate families.",
  "",
  "The generator samples each next digit from a softmax distribution over additive feature scores. Standalone mechanism strengths are intentionally strong positive controls; the combined scenario scales each feature to 40% and adds weaker recent-frequency feedback so it remains stochastic.",
  "",
  "| Scenario | Planted conditional rule |",
  "|---|---|",
  "| biased-frequency | Add 1.8 logit to digit 4 and 1.1 to digit 7 on every tick. |",
  "| markov-dependence | Add 2.2 logit to the immediately previous digit. |",
  "| lag-memory | Add 2.2 logit to the digit four positions before the next outcome. |",
  "| due-gap | Once the longest digit absence reaches 10 ticks, add 2.5 logit to that digit. |",
  "| streak-persistence | After a run reaches two ticks, add 2.0 logit to the run digit. |",
  "| increment-memory | When the last two modulo-10 increments match, add 2.3 logit to the digit predicted by repeating that increment. |",
  "| regime-shift | Add 2.0 logit to digit 2 in the first half, then digit 8 in the second half. |",
  "| combined-all | Apply all seven features at 40% strength; also add `0.2 × ln((recentCount + 1)/(recentWindowSize/10 + 1))` from the most recent 100 digits. |",
  "",
];

lines.push("## At a glance", "");
lines.push("| Scenario | Horizon | Best current module vs uniform | ΔLL | Best candidate vs uniform | ΔLL |", "");
lines.push("|---|---:|---|---:|---|---:|", "");
for (const result of results) {
  const metricDelta = (name) => (result.metrics.uniform.logLoss - result.metrics[name].logLoss) * 1000;
  const bestCurrent = [...CURRENT].sort((a, b) => metricDelta(b) - metricDelta(a))[0];
  const bestCandidate = [...CANDIDATES].sort((a, b) => metricDelta(b) - metricDelta(a))[0];
  lines.push(`| ${result.scenario} | ${result.horizon} | ${labels[bestCurrent]} | ${signed(metricDelta(bestCurrent))} | ${labels[bestCandidate]} | ${signed(metricDelta(bestCandidate))} |`);
}
lines.push("");

for (const result of results) {
  const reference = result.metrics.uniform;
  lines.push(`## ${result.scenario} — horizon ${result.horizon}`);
  lines.push("", result.description, "");
  lines.push("| Model | N | Log loss | Brier | Top-1 | ΔLL vs uniform (millinats) | ΔLL vs ensemble (millinats) |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|");
  for (const name of modelNames) {
    if (name === "oracle" && result.horizon !== 1) continue;
    const metric = result.metrics[name];
    if (!metric) continue;
    const deltaUniform = (reference.logLoss - metric.logLoss) * 1000;
    const deltaEnsemble = (result.metrics.ensemble.logLoss - metric.logLoss) * 1000;
    lines.push(`| ${labels[name]} | ${metric.n.toLocaleString()} | ${metric.logLoss.toFixed(6)} | ${metric.brier.toFixed(6)} | ${(metric.top1 * 100).toFixed(2)}% | ${signed(deltaUniform)} | ${signed(deltaEnsemble)} |`);
  }
  lines.push("");
}

lines.push("## Interpretation guide", "");
lines.push("- A planted-mechanism scenario is a positive control: the generator is deliberately informative. A model beating uniform there demonstrates recovery of that synthetic signal only.", "");
lines.push("- The combined scenario is intentionally difficult: mechanisms may reinforce or conflict. Individual mechanisms are reported separately so a composite score cannot hide which assumptions a model handles.", "");
lines.push("- The “oracle” is the exact next-digit distribution used by the generator, not an implementable forecast model.", "");
lines.push("- No real tick data, accounts, order placement, or production LDPE paths are used or changed.", "");
await fs.writeFile(OUTPUT, `${lines.join("\n")}\n`, "utf8");
console.log(`Report: ${OUTPUT}`);
