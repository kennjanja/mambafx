// Synthetic stress test: the listed mechanisms are planted by construction.
// This does not estimate whether Deriv or any real market has these properties.
// Run: node tests/ldpe/evaluate-assumptions.mjs [ticks-per-seed] [seed-count] [oracle-origins] [oracle-paths]
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ldpe, validVector } from "../../src/ldpe/engine.js";
import {
  CandidateForecaster, EarnedWeightMixture, fitTuningParameters, GapRampForecaster,
  normalizeProbabilities, SoftmaxRegressionForecaster,
} from "../../src/ldpe/evaluation/models.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUTPUT = path.join(ROOT, "docs", "ldpe-assumption-stress-test.md");
const CSV_OUTPUT = path.join(ROOT, "docs", "ldpe-assumption-stress-test.csv");
const WEIGHTS_OUTPUT = path.join(ROOT, "docs", "ldpe-assumption-mixture-weights.csv");
const TICKS = Math.max(5000, Number(process.argv[2]) || 15000);
const SEEDS = Math.max(1, Number(process.argv[3]) || 3);
const ORACLE_ORIGINS = Math.max(2, Number(process.argv[4]) || 300);
const ORACLE_PATHS = Math.max(5000, Number(process.argv[5]) || 5000);
const SCENARIOS = [
  ["null-uniform", "Strength 0: i.i.d. uniform digits; oracle equals uniform"],
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
const ADDED_MODELS = ["softmaxRegression", "gapRamp"];
const MODEL_NAMES = ["uniform", "ensemble", ...CURRENT, ...CANDIDATES, ...ADDED_MODELS, "weightedMixture", "oracle"];
const CURRENT_GROUP = [...CURRENT, "ensemble"];
const NEW_GROUP = [...CANDIDATES, ...ADDED_MODELS, "weightedMixture"];
const EXPERT_CLUSTERS = {
  dirichlet: "frequency", freqShort: "frequency", freqLong: "frequency", decayed: "frequency",
  hdm: "frequency", ddir: "frequency",
  trans1: "sequential", trans2: "sequential", ctw: "sequential", inc: "sequential",
  lag: "sequential", softmaxRegression: "sequential",
  gap: "gap", gapRamp: "gap", streak: "streak",
};
const UNIFORM = Array(10).fill(0.1);
const HORIZONS = [1, 5, 10];
const comparisonKey = (left, right) => `${left}\u0000${right}`;

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
  const gaps = Array(10).fill(history.length + 1);
  let unseen = 10;
  for (let i = history.length - 1; i >= 0 && unseen; i--) {
    if (gaps[history[i]] === history.length + 1) {
      gaps[history[i]] = history.length - i;
      unseen--;
    }
  }
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

function hasExactMultiStepOracle(kind) {
  return ["null-uniform", "biased-frequency", "markov-dependence", "lag-memory",
    "streak-persistence", "increment-memory", "regime-shift"].includes(kind);
}

function makeOracleState(history) {
  const gaps = Array(10).fill(history.length + 1);
  let unseen = 10;
  for (let i = history.length - 1; i >= 0 && unseen; i--) {
    if (gaps[history[i]] === history.length + 1) {
      gaps[history[i]] = history.length - i;
      unseen--;
    }
  }
  const recent = history.slice(-100);
  const recentCounts = Array(10).fill(0);
  for (const digit of recent) recentCounts[digit]++;
  const last = history.at(-1);
  let runLength = 0;
  for (let i = history.length - 1; i >= 0 && history[i] === last; i--) runLength++;
  return {
    history: history.slice(-4), historyLength: history.length, gaps, recent, recentCounts, last,
    runLength,
  };
}

function cloneOracleState(state) {
  return {
    history: [...state.history], historyLength: state.historyLength,
    gaps: [...state.gaps], recent: [...state.recent], recentCounts: [...state.recentCounts],
    last: state.last, runLength: state.runLength,
  };
}

function nextOracleDigit(kind, state, origin, total, random) {
  const strength = kind === "combined-all" ? 0.4 : 1;
  const score = Array(10).fill(0);
  if (kind === "due-gap" || kind === "combined-all") {
    const oldest = state.gaps.indexOf(Math.max(...state.gaps));
    if (state.gaps[oldest] >= 10) score[oldest] += 2.5 * strength;
  }
  if (kind === "combined-all") {
    score[4] += 1.8 * strength;
    score[7] += 1.1 * strength;
    if (state.last !== undefined) score[state.last] += 2.2 * strength;
    if (state.historyLength >= 4) score[state.history[0]] += 2.2 * strength;
    if (state.last !== undefined && state.runLength >= 2) score[state.last] += 2.0 * strength;
    if (state.historyLength >= 3) {
      const lastIncrement = (state.history.at(-1) - state.history.at(-2) + 10) % 10;
      const priorIncrement = (state.history.at(-2) - state.history.at(-3) + 10) % 10;
      if (lastIncrement === priorIncrement) score[(state.last + lastIncrement) % 10] += 2.3 * strength;
    }
    score[origin + 1 < total / 2 ? 2 : 8] += 2.0 * strength;
    if (state.historyLength >= 10) {
      const n = Math.min(100, state.historyLength);
      for (let digit = 0; digit < 10; digit++) {
        score[digit] += 0.2 * Math.log((state.recentCounts[digit] + 1) / (n / 10 + 1));
      }
    }
  }
  const probabilities = softmax(score);
  const actual = draw(probabilities, random);
  for (let digit = 0; digit < 10; digit++) state.gaps[digit]++;
  state.gaps[actual] = 1;
  state.runLength = actual === state.last ? state.runLength + 1 : 1;
  state.last = actual;
  state.history.push(actual);
  if (state.history.length > 4) state.history.shift();
  if (state.recent.length === 100) state.recentCounts[state.recent.shift()]--;
  state.recent.push(actual);
  state.recentCounts[actual]++;
  state.historyLength++;
  return actual;
}

const exactTransitionTables = new Map();
function exactContextOracle(kind, history, origin, horizon, order) {
  const cacheKey = `${kind}:${order}`;
  let table = exactTransitionTables.get(cacheKey);
  if (!table) {
    const stateCount = 10 ** order, transitions = new Float64Array(stateCount * 10);
    const context = Array(order).fill(0);
    for (let state = 0; state < stateCount; state++) {
      let encoded = state;
      for (let i = order - 1; i >= 0; i--) {
        context[i] = encoded % 10;
        encoded = Math.floor(encoded / 10);
      }
      const probabilities = features(kind, context, 0, TICKS);
      for (let digit = 0; digit < 10; digit++) transitions[state * 10 + digit] = probabilities[digit];
    }
    table = { stateCount, suffixMod: 10 ** (order - 1), transitions };
    exactTransitionTables.set(cacheKey, table);
  }

  const initialContext = history.slice(-order);
  let initialState = 0;
  for (const digit of initialContext) initialState = initialState * 10 + digit;
  let states = new Float64Array(table.stateCount);
  states[initialState] = 1;
  for (let step = 1; step <= horizon; step++) {
    const nextStates = new Float64Array(table.stateCount);
    for (let state = 0; state < table.stateCount; state++) {
      const stateProbability = states[state];
      if (!stateProbability) continue;
      const suffix = (state % table.suffixMod) * 10;
      const rowOffset = state * 10;
      for (let digit = 0; digit < 10; digit++) {
        nextStates[suffix + digit] += stateProbability * table.transitions[rowOffset + digit];
      }
    }
    states = nextStates;
  }
  const result = Array(10).fill(0);
  for (let state = 0; state < table.stateCount; state++) result[state % 10] += states[state];
  return normalizeProbabilities(result);
}

function estimateHorizonOracle(kind, history, origin, horizon, seed) {
  if (horizon === 1) return { probabilities: features(kind, history, origin + 1, TICKS), logLossVariance: Array(10).fill(0) };
  if (kind === "null-uniform") return { probabilities: UNIFORM, logLossVariance: Array(10).fill(0) };
  if (kind === "biased-frequency" || kind === "regime-shift") {
    return { probabilities: features(kind, history, origin + horizon, TICKS), logLossVariance: Array(10).fill(0) };
  }
  if (kind === "markov-dependence") {
    return { probabilities: exactContextOracle(kind, history, origin, horizon, 1), logLossVariance: Array(10).fill(0) };
  }
  if (kind === "lag-memory") {
    return { probabilities: exactContextOracle(kind, history, origin, horizon, 4), logLossVariance: Array(10).fill(0) };
  }
  if (kind === "streak-persistence") {
    return { probabilities: exactContextOracle(kind, history, origin, horizon, 2), logLossVariance: Array(10).fill(0) };
  }
  if (kind === "increment-memory") {
    return { probabilities: exactContextOracle(kind, history, origin, horizon, 3), logLossVariance: Array(10).fill(0) };
  }

  const random = rng(seed), counts = Array(10).fill(0);
  const initialState = makeOracleState(history);
  for (let path = 0; path < ORACLE_PATHS; path++) {
    const state = cloneOracleState(initialState);
    for (let step = 1; step <= horizon; step++) {
      const actual = nextOracleDigit(kind, state, origin + step - 1, TICKS, random);
      if (step === horizon) counts[actual]++;
    }
  }
  const probabilities = normalizeProbabilities(counts.map((count) => count + 0.5));
  const logLossVariance = probabilities.map((probability) => (1 - probability) / (ORACLE_PATHS * probability));
  return { probabilities, logLossVariance };
}

function selectedOrigins(horizon) {
  const tuningEnd = Math.floor(TICKS * 0.2);
  const eligible = Math.max(0, TICKS - horizon - tuningEnd);
  const count = Math.min(ORACLE_ORIGINS, eligible);
  if (horizon === 1) return new Set(Array.from({ length: eligible }, (_, i) => tuningEnd + i));
  return new Set(Array.from({ length: count }, (_, i) =>
    tuningEnd + Math.floor((i + 0.5) * eligible / count)));
}

function bootstrapRandom(seed) {
  let state = seed >>> 0;
  return () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296);
}

function blockBootstrapIntervals(losses, pairs, { blockLength, seed, oracleVariances, replicates = 1000 }) {
  const names = [...new Set(pairs.flatMap(([left, right]) => [left, right]))];
  const n = losses[names[0]].length;
  if (n < 2 || names.some((name) => losses[name].length !== n)) {
    throw new Error("paired bootstrap losses must have equal length of at least two");
  }
  const prefix = Object.fromEntries(names.map((name) => {
    const values = losses[name], sums = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) sums[i + 1] = sums[i] + values[i];
    return [name, sums];
  }));
  const samples = new Map(pairs.map(([left, right]) => [`${left}\u0000${right}`, []]));
  const random = bootstrapRandom(seed);
  for (let replicate = 0; replicate < replicates; replicate++) {
    const totals = Object.fromEntries(names.map((name) => [name, 0]));
    let sampled = 0;
    while (sampled < n) {
      const start = Math.floor(random() * n);
      const length = Math.min(blockLength, n - sampled);
      const end = start + length;
      for (const name of names) {
        totals[name] += end <= n
          ? prefix[name][end] - prefix[name][start]
          : prefix[name][n] - prefix[name][start] + prefix[name][end - n];
      }
      sampled += length;
    }
    for (const [left, right] of pairs) {
      samples.get(`${left}\u0000${right}`).push((totals[left] - totals[right]) / n);
    }
  }
  const observed = (left, right) => prefix[left][n] / n - prefix[right][n] / n;
  const oracleKeys = pairs.filter(([, right]) => right === "oracle")
    .map(([left, right]) => comparisonKey(left, right));
  const maxOracleErrors = Array.from({ length: replicates }, (_, replicate) =>
    Math.max(...oracleKeys.map((key) => {
      const [left, right] = key.split("\u0000");
      return Math.abs(samples.get(key)[replicate] - observed(left, right));
    }))).sort((a, b) => a - b);
  const oracleMonteCarloMargin = 3.5 * Math.sqrt(oracleVariances.reduce((sum, variance) => sum + variance, 0)) / n;
  const simultaneousMargin = maxOracleErrors[Math.min(replicates - 1, Math.ceil(0.95 * replicates) - 1)]
    + oracleMonteCarloMargin;
  return Object.fromEntries([...samples].map(([key, values]) => {
    const [left, right] = key.split("\u0000");
    if (right === "oracle") {
      const center = observed(left, right);
      return [key, [center - simultaneousMargin, center + simultaneousMargin]];
    }
    values.sort((a, b) => a - b);
    const low = values[Math.floor(0.025 * replicates)];
    const high = values[Math.min(replicates - 1, Math.ceil(0.975 * replicates) - 1)];
    return [key, [low, high]];
  }));
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
  return Object.fromEntries(MODEL_NAMES.map((name) => [name, newScore()]));
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
  const scoredOrigins = selectedOrigins(horizon);
  const params = fitTuningParameters(series.digits.slice(0, tuningEnd), horizon);
  const candidates = Object.fromEntries(CANDIDATES.map((family) =>
    [family, new CandidateForecaster(family, horizon, params)]));
  const addedModels = {
    softmaxRegression: new SoftmaxRegressionForecaster(horizon),
    gapRamp: new GapRampForecaster(horizon, 122),
  };
  const mixture = new EarnedWeightMixture(EXPERT_CLUSTERS);
  const engine = new Ldpe({ horizon, minTicks: 100 });
  engine.historyMax = 2000;
  const scores = createScoreMap(), pending = new Map();
  const lossesByModel = Object.fromEntries(MODEL_NAMES.map((name) => [name, []]));
  const oracleVariances = [];
  const weightSums = Object.fromEntries(Object.keys(EXPERT_CLUSTERS).map((name) => [name, 0]));
  let weightCount = 0;

  for (let index = 0; index < TICKS; index++) {
    const actual = series.digits[index];
    const due = pending.get(index);
    if (due) {
      mixture.observe(due.experts, actual);
      if (index >= tuningEnd && due.scoreable) {
        for (const name of MODEL_NAMES) {
          if (name === "oracle") continue;
          addScore(scores[name], due[name], actual);
          lossesByModel[name].push(-Math.log(Math.max(due[name][actual], 1e-12)));
        }
        addScore(scores.oracle, due.oracle, actual);
        lossesByModel.oracle.push(-Math.log(Math.max(due.oracle[actual], 1e-12)));
        oracleVariances.push(due.oracleVariance);
      }
    }

    const ingested = engine.ingest("synthetic", {
      epoch: 1000 + index,
      quote: `100.0${actual}`,
      decimals: 2,
    });
    if (!ingested.accepted) throw new Error(`${kind}/${seed}: synthetic tick rejected at ${index}`);
    for (const candidate of Object.values(candidates)) candidate.observe(actual);
    for (const model of Object.values(addedModels)) model.observe(actual);

    const targetIndex = index + horizon;
    const forecast = ingested.forecast;
    const scoreable = scoredOrigins.has(index);
    if (targetIndex >= TICKS || !forecast ||
        CURRENT.some((name) => !forecast.vectors.modules[name])) continue;
    const vectors = {
      uniform: UNIFORM,
      ensemble: forecast.vectors.final,
    };
    let oracleVariance = 0;
    if (scoreable) {
      if (horizon === 1) vectors.oracle = series.truth[targetIndex];
      else {
        const oracle = estimateHorizonOracle(kind, series.digits.slice(0, index + 1), index, horizon,
          seed * 7919 + horizon * 131 + index * 104729);
        vectors.oracle = oracle.probabilities;
        oracleVariance = oracle.logLossVariance[series.digits[targetIndex]];
      }
    }
    for (const name of CURRENT) vectors[name] = forecast.vectors.modules[name];
    for (const family of CANDIDATES) vectors[family] = candidates[family].predict();
    for (const name of ADDED_MODELS) vectors[name] = addedModels[name].predict();
    const experts = Object.fromEntries(Object.keys(EXPERT_CLUSTERS).map((name) => [name, vectors[name]]));
    vectors.weightedMixture = mixture.predict(experts);
    if (scoreable) {
      const weights = mixture.getWeights();
      for (const name of Object.keys(weightSums)) weightSums[name] += weights[name];
      weightCount++;
    }
    pending.set(targetIndex, { ...vectors, experts, scoreable, oracleVariance });
  }
  const meanWeights = Object.fromEntries(Object.entries(weightSums).map(([name, sum]) =>
    [name, weightCount ? sum / weightCount : null]));
  return {
    scenario: kind, seed, horizon,
    metrics: Object.fromEntries(Object.entries(scores).map(([name, score]) => [name, summarize(score)])),
    lossesByModel,
    oracleVariances,
    oracleMethod: horizon === 1 || hasExactMultiStepOracle(kind) ? "exact" : `estimated; ${ORACLE_PATHS} Monte Carlo paths`,
    meanWeights,
  };
}

function aggregate(runs) {
  const out = {};
  for (const name of MODEL_NAMES) {
    const rows = runs.map((run) => run.metrics[name]).filter((row) => row.n);
    const n = rows.reduce((sum, row) => sum + row.n, 0);
    out[name] = n ? {
      n,
      logLoss: rows.reduce((sum, row) => sum + row.n * row.logLoss, 0) / n,
      brier: rows.reduce((sum, row) => sum + row.n * row.brier, 0) / n,
      top1: rows.reduce((sum, row) => sum + row.n * row.top1, 0) / n,
    } : null;
  }
  const weightTotals = Object.fromEntries(Object.keys(EXPERT_CLUSTERS).map((name) => [name, 0]));
  let weightRuns = 0;
  for (const run of runs) {
    if (!Object.values(run.meanWeights).every(Number.isFinite)) continue;
    for (const name of Object.keys(weightTotals)) weightTotals[name] += run.meanWeights[name];
    weightRuns++;
  }
  out.weightedMixtureWeights = Object.fromEntries(Object.entries(weightTotals).map(([name, sum]) =>
    [name, weightRuns ? sum / weightRuns : null]));
  return out;
}

function compareLosses(runs, scenarioIndex, horizon) {
  const losses = Object.fromEntries(MODEL_NAMES.map((name) => [
    name, runs.flatMap((run) => run.lossesByModel[name]),
  ]));
  const oracleVariances = runs.flatMap((run) => run.oracleVariances);
  const pairs = [
    ...MODEL_NAMES.filter((name) => name !== "uniform").map((name) => [name, "uniform"]),
    ...MODEL_NAMES.filter((name) => name !== "oracle").map((name) => [name, "oracle"]),
    ...CURRENT_GROUP.flatMap((current) => NEW_GROUP.map((fresh) => [current, fresh])),
  ];
  const n = losses.oracle.length;
  const intervals = blockBootstrapIntervals(losses, pairs, {
    blockLength: Math.min(Math.max(1, Math.floor(n / 3)), Math.max(50, horizon * 2)),
    seed: 48121 + scenarioIndex * 1009 + horizon * 37,
    oracleVariances,
  });
  return { losses, intervals };
}

function signed(value, digits = 3) {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

function ciText(interval) {
  return interval ? `[${signed(interval[0], 4)}, ${signed(interval[1], 4)}]` : "n/a";
}

const results = [];
for (let scenarioIndex = 0; scenarioIndex < SCENARIOS.length; scenarioIndex++) {
  const [scenario, description] = SCENARIOS[scenarioIndex];
  for (const horizon of HORIZONS) {
    const runs = [];
    for (let seed = 1; seed <= SEEDS; seed++) {
      const series = generate(scenario, seed * 7919 + horizon * 131);
      runs.push(evaluate(scenario, seed, horizon, series));
    }
    const comparison = compareLosses(runs, scenarioIndex, horizon);
    const strengths = scenario === "null-uniform" ? 0 : scenario === "combined-all" ? 0.4 : 1;
    results.push({
      scenario, description, strength: strengths, horizon, seeds: SEEDS,
      metrics: aggregate(runs), comparison, runs,
    });
    console.log(`${scenario} h=${horizon}: ${comparison.losses.ensemble.length} identical origins scored; oracle ${runs[0].oracleMethod}`);
  }
}

const modelNames = MODEL_NAMES;
const labels = {
  uniform: "Uniform baseline",   ensemble: "Current ensemble (final vector)", dirichlet: "Current Dirichlet",
  freqShort: "Current freqShort", freqLong: "Current freqLong", decayed: "Current decayed",
  trans1: "Current trans1", trans2: "Current trans2", gap: "Current gap", streak: "Current streak",
  hdm: "Candidate HDM", ddir: "Candidate discounted Dirichlet", ctw: "Candidate CTW-3",
  inc: "Candidate modular increment", lag: "Candidate lag tables", oracle: "True generator oracle",
  softmaxRegression: "New softmax regression", gapRamp: "New gapRamp (L=122)",
  weightedMixture: "New weighted mixture",
};
const oracleViolations = [];
const lines = [
  "# LDPE synthetic assumption-true comparison",
  "",
  "> **SYNTHETIC - not evidence about real markets**",
  "",
  `Generated ${new Date().toISOString()}. Each scenario used ${TICKS.toLocaleString()} ticks per seed, ${SEEDS} deterministic seeds, and horizons ${HORIZONS.join(", ")}. The first 20% was reserved for candidate tuning/warm-up. All models within a cell share the exact same scored origins and outcomes.`,
  "",
  `For horizon 1, the oracle uses the exact generator probabilities. At horizons 5 and 10, it is exact for the independent frequency/regime/null generators and for finite-context Markov, lag, streak, and increment generators; due-gap and combined use a conditional Monte Carlo oracle with ${ORACLE_PATHS.toLocaleString()} paths per selected origin and Jeffreys 0.5-count smoothing. Since that computation is expensive, horizons 5 and 10 use ${ORACLE_ORIGINS} evenly spaced scored origins per seed; horizon 1 scores every post-warmup origin. Oracle estimates are labeled in the tables, and model-vs-oracle bands include a conservative Monte Carlo uncertainty margin for the estimated oracle.`,
  "",
  "Log loss, Brier, and hit rate are forecast-count-weighted across seeds. Gain captured is `(LL_uniform - LL_model) / (LL_uniform - LL_oracle)`; it is not applicable when the oracle gain is zero. The reported 95% intervals use paired circular block bootstrap (1,000 replicates; block length is 50 or twice the horizon, capped at one-third of the sample). Model-vs-oracle intervals use a simultaneous max-deviation bootstrap band across all tested models.",
  "",
  "Hit rate splits credit equally across exact probability ties, so a uniform forecast scores 10%.",
  "",
  "The weighted mixture is prequential: it updates expert log-loss weights only after outcomes arrive, retains a 5% uniform floor, and caps each cluster at 40%. No live execution, thresholds, stakes, risk controls, network, or order placement are involved.",
  "",
  "| Scenario | Strength | Planted rule |",
  "|---|---:|---|",
  "| null-uniform | 0 | i.i.d. uniform; false-positive control and exact oracle = uniform. |",
  "| biased-frequency | 1 | Add 1.8 logit to digit 4 and 1.1 to digit 7 on every tick. |",
  "| markov-dependence | 1 | Add 2.2 logit to the immediately previous digit. |",
  "| lag-memory | 1 | Add 2.2 logit to the digit four positions before the next outcome. |",
  "| due-gap | 1 | Once the longest digit absence reaches 10 ticks, add 2.5 logit to that digit. |",
  "| streak-persistence | 1 | After a run reaches two ticks, add 2.0 logit to the run digit. |",
  "| increment-memory | 1 | When the last two modulo-10 increments match, add 2.3 logit to the repeated-increment prediction. |",
  "| regime-shift | 1 | Add 2.0 logit to digit 2 in the first half, then digit 8 in the second half. |",
  "| combined-all | 0.4 | All seven features at 40% strength, plus weaker 100-tick frequency feedback. |",
  "",
];

lines.push("## Summary: best current, ensemble, and best new", "");
lines.push("| Scenario | H | Oracle | Best current vs oracle (LL diff, 95% CI) | Ensemble vs oracle (LL diff, 95% CI) | Best new vs oracle (LL diff, 95% CI) | Best current vs best new (LL diff, 95% CI) |");
lines.push("|---|---:|---|---|---|---|---|");
const comparisonRows = [[
  "label", "record_type", "scenario", "strength", "horizon", "oracle_method", "model",
  "reference_model", "n", "log_loss", "brier", "hit_rate", "gain_captured",
  "delta_ll_vs_uniform", "delta_uniform_ci95_low", "delta_uniform_ci95_high",
  "delta_ll_vs_oracle", "delta_oracle_ci95_low", "delta_oracle_ci95_high",
  "difference_left_minus_right", "comparison_ci95_low", "comparison_ci95_high",
]];
const modelRows = [[
  ...comparisonRows[0],
]];
const weightRows = [["label", "scenario", "strength", "horizon", "model", "mean_weight"]];
for (const result of results) {
  const { metrics, comparison } = result;
  const bestCurrent = [...CURRENT].sort((a, b) => metrics[a].logLoss - metrics[b].logLoss)[0];
  const bestNew = [...NEW_GROUP].sort((a, b) => metrics[a].logLoss - metrics[b].logLoss)[0];
  const oracleMethod = result.runs[0].oracleMethod;
  const formatPair = (left, right) => {
    const diff = metrics[left].logLoss - metrics[right].logLoss;
    return `${labels[left] || left} − ${labels[right] || right}: ${signed(diff, 5)} ${ciText(comparison.intervals[comparisonKey(left, right)])}`;
  };
  lines.push(`| ${result.scenario} | ${result.horizon} | ${oracleMethod} | ${formatPair(bestCurrent, "oracle")} | ${formatPair("ensemble", "oracle")} | ${formatPair(bestNew, "oracle")} | ${formatPair(bestCurrent, bestNew)} |`);

  for (const name of modelNames) {
    const metric = metrics[name];
    const deltaUniform = metric.logLoss - metrics.uniform.logLoss;
    const deltaOracle = metric.logLoss - metrics.oracle.logLoss;
    const uniformCI = name === "uniform" ? [0, 0] : comparison.intervals[comparisonKey(name, "uniform")];
    const oracleCI = name === "oracle" ? [0, 0] : comparison.intervals[comparisonKey(name, "oracle")];
    const gainDenominator = metrics.uniform.logLoss - metrics.oracle.logLoss;
    const gain = Math.abs(gainDenominator) < 1e-12 ? null : (metrics.uniform.logLoss - metric.logLoss) / gainDenominator;
    modelRows.push([
      "SYNTHETIC - not evidence about real markets", "model", result.scenario, result.strength,
      result.horizon, oracleMethod, name, "", metric.n, metric.logLoss, metric.brier, metric.top1, gain,
      deltaUniform, uniformCI?.[0] ?? null, uniformCI?.[1] ?? null,
      deltaOracle, oracleCI?.[0] ?? null, oracleCI?.[1] ?? null, "", "", "",
    ]);
    if (name !== "oracle" && oracleCI?.[1] < 0) {
      oracleViolations.push(`${result.scenario}/h${result.horizon}: ${name} beats oracle; adjusted CI ${ciText(oracleCI)}`);
    }
  }

  lines.push("", `### ${result.scenario} — horizon ${result.horizon} (${oracleMethod})`, "");
  lines.push(result.description, "");
  lines.push("| Group | Model | N | Log loss | Brier | Hit rate | Gain captured | LL(model−oracle), 95% block CI |");
  lines.push("|---|---|---:|---:|---:|---:|---:|---:|");
  for (const name of modelNames) {
    const metric = metrics[name];
    const gainDenominator = metrics.uniform.logLoss - metrics.oracle.logLoss;
    const gain = Math.abs(gainDenominator) < 1e-12
      ? "n/a" : ((metrics.uniform.logLoss - metric.logLoss) / gainDenominator).toFixed(3);
    const interval = name === "oracle" ? [0, 0] : comparison.intervals[comparisonKey(name, "oracle")];
    const group = name === "uniform" ? "BASELINE" : name === "oracle" ? "ORACLE"
      : CURRENT_GROUP.includes(name) ? "CURRENT" : "NEW";
    lines.push(`| ${group} | ${labels[name] || name} | ${metric.n.toLocaleString()} | ${metric.logLoss.toFixed(6)} | ${metric.brier.toFixed(6)} | ${(metric.top1 * 100).toFixed(2)}% | ${gain} | ${signed(metric.logLoss - metrics.oracle.logLoss, 5)} ${ciText(interval)} |`);
  }
  lines.push("", "Mean earned mixture weights in the scored window:", "");
  lines.push("| Expert | Mean weight |");
  lines.push("|---|---:|");
  for (const [name, weight] of Object.entries(metrics.weightedMixtureWeights)) {
    lines.push(`| ${labels[name] || name} | ${(weight * 100).toFixed(2)}% |`);
    weightRows.push(["SYNTHETIC - not evidence about real markets", result.scenario, result.strength, result.horizon, name, weight]);
  }

  const recordComparison = (type, left, right) => {
    const diff = metrics[left].logLoss - metrics[right].logLoss;
    const interval = comparison.intervals[comparisonKey(left, right)];
    comparisonRows.push([
      "SYNTHETIC - not evidence about real markets", type, result.scenario, result.strength,
      result.horizon, oracleMethod, left, right, metrics[left].n,
      "", "", "", "", "", "", "", "", "", "", diff, interval[0], interval[1],
    ]);
  };
  for (const current of CURRENT_GROUP) recordComparison("current-vs-oracle", current, "oracle");
  for (const fresh of NEW_GROUP) recordComparison("new-vs-oracle", fresh, "oracle");
  for (const current of CURRENT_GROUP) for (const fresh of NEW_GROUP) {
    recordComparison("current-vs-new", current, fresh);
  }
}

lines.push("", "## Interpretation and oracle check", "");
lines.push(`- Oracle validation: ${oracleViolations.length ? `FAILED (${oracleViolations.length} adjusted intervals show a model beating the oracle)` : "passed; no model beat the oracle beyond the simultaneous 95% block-bootstrap interval"}.`, "");
lines.push("- The null-uniform row is strength 0: uniform and oracle coincide, and any apparent model advantage is sampling noise unless supported by the block-bootstrap interval.", "");
lines.push("- Positive gain captured means lower log loss than uniform; values above 1 can occur from sample variation or an estimated multi-step oracle and must be interpreted with its interval.", "");
lines.push("- Results are synthetic positive controls only, not evidence about real Deriv ticks or tradable performance. Production forecast and execution paths are unchanged.", "");

const csvEscape = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
await fs.writeFile(OUTPUT, `${lines.join("\n").trimEnd()}\n`, "utf8");
await fs.writeFile(CSV_OUTPUT, [
  ...modelRows.map((row) => row.map(csvEscape).join(",")),
  ...comparisonRows.slice(1).map((row) => row.map(csvEscape).join(",")),
].join("\n") + "\n", "utf8");
await fs.writeFile(WEIGHTS_OUTPUT, weightRows.map((row) => row.map(csvEscape).join(",")).join("\n") + "\n", "utf8");
console.log(`Report: ${OUTPUT}`);
console.log(`Metrics/comparisons CSV: ${CSV_OUTPUT}`);
console.log(`Mixture weight CSV: ${WEIGHTS_OUTPUT}`);
if (oracleViolations.length) {
  console.error("ORACLE CHECK FAILED: investigate these comparisons before treating the report as valid:");
  for (const violation of oracleViolations) console.error(`- ${violation}`);
  process.exitCode = 1;
}
