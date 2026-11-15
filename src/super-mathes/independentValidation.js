import { brier, logLoss } from "./math.js";
import { rankDistribution, UNIFORM } from "./models.js?v=3";

const BLOCK = 100;
const PERIODS = 3;
const MIN_BLOCKS = 30;
const REPLICATES = 500;
const MODELS = ["frequency", "markov", "combined"];

function metric() { return { n: 0, observed: 0, predicted: 0 }; }
function add(target, actual, predicted) {
  target.n++;
  target.observed += actual;
  target.predicted += predicted;
}
function combine(blocks, key) {
  const result = metric();
  for (const block of blocks) {
    const m = block[key];
    if (m) { result.n += m.n; result.observed += m.observed; result.predicted += m.predicted; }
  }
  return result;
}
function summarize(blocks, key) {
  const total = combine(blocks, key);
  if (!total.n) return { n: 0, observed: null, predicted: null, confidence95: null };
  let state = 0x4d415448;
  const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
  const byPeriod = Array.from({ length: PERIODS }, (_, period) => blocks.filter(b => b.period === period));
  const values = [];
  if (blocks.length >= MIN_BLOCKS && byPeriod.every(group => group.length)) {
    for (let r = 0; r < REPLICATES; r++) {
      let n = 0, sum = 0;
      for (const group of byPeriod) {
        for (let j = 0; j < group.length; j++) {
          const m = group[Math.floor(random() * group.length)][key];
          if (m) { n += m.n; sum += m.observed; }
        }
      }
      if (n) values.push(sum / n);
    }
  }
  values.sort((a, b) => a - b);
  return {
    n: total.n, observed: total.observed / total.n, predicted: total.predicted / total.n,
    confidence95: values.length === REPLICATES ? [values[Math.floor(REPLICATES * 0.025)], values[Math.floor(REPLICATES * 0.975)]] : null,
  };
}
function addMetric(block, key, actual, predicted = 0) {
  if (!block[key]) block[key] = metric();
  add(block[key], actual, predicted);
}
function uniqueTop(vector) {
  const ranks = rankDistribution(vector);
  return ranks[0].probability === ranks[1].probability ? null : ranks[0].digit;
}
function topKScore(vector, digit, k) {
  const p = vector[digit];
  const higher = vector.filter(value => value > p).length;
  const tied = vector.filter(value => value === p).length;
  return Math.max(0, Math.min(1, (k - higher) / tied));
}
function checkObservations(observations) {
  if (!Array.isArray(observations) || !observations.length) throw new Error("A single source segment is required");
  const first = observations[0];
  for (let i = 0; i < observations.length; i++) {
    const row = observations[i], previous = observations[i - 1];
    if (typeof row.source !== "string" || !row.source || row.source !== first.source ||
        !Number.isSafeInteger(row.segment) || row.segment < 1 || row.segment !== first.segment ||
        !Number.isSafeInteger(row.sequence) || row.sequence < 1 || !Number.isSafeInteger(row.epoch) || row.epoch < 0 ||
        !Number.isInteger(row.digit) || row.digit < 0 || row.digit > 9 ||
        (previous && (row.sequence !== previous.sequence + 1 || row.epoch <= previous.epoch))) {
      throw new Error("Observations must be a consecutive, ordered single-source segment");
    }
  }
}

// Fixed protocol: chronological rolling prefixes, three test periods, and
// non-overlapping 100-observation bootstrap blocks. No model selection occurs.
export function independentValidation(observations, { warmup = 500, windowSize = 1000, frequencyWeight = 0.5 } = {}) {
  checkObservations(observations);
  if (!Number.isInteger(warmup) || warmup < 500) throw new Error("Independent validation requires at least 500 training observations");
  if (!Number.isInteger(windowSize) || windowSize < 20 || windowSize > 10000) throw new Error("Invalid model window");
  if (!Number.isFinite(frequencyWeight) || frequencyWeight <= 0 || frequencyWeight >= 1) throw new Error("Both model weights must be positive");
  const available = Math.max(0, observations.length - warmup);
  const periodLength = Math.floor(available / PERIODS / BLOCK) * BLOCK;
  const totalBlocks = PERIODS * periodLength / BLOCK;
  const protocol = {
    warmup, windowSize, frequencyWeight, minimumTransitions: 5, periods: PERIODS, periodLength, blockSize: BLOCK, blocks: totalBlocks,
    availableTestObservations: available, evaluatedObservations: periodLength * PERIODS,
    discardedTail: available - periodLength * PERIODS, bootstrapReplicates: REPLICATES,
    confidenceMethod: "Stratified 100-observation block bootstrap; assumes blocks are sufficiently weakly dependent.",
    note: "Exploratory research, not a significance or superiority claim; test periods share rolling training history.",
  };
  if (!totalBlocks) return { status: "Insufficient Evidence", protocol, models: null };
  const counts = Array(10).fill(1), transitions = Array.from({ length: 10 }, () => Array(10).fill(1));
  const digits = observations.map(row => row.digit);
  const start = Math.max(0, warmup - windowSize);
  for (let i = start; i < warmup; i++) {
    counts[digits[i]]++;
    if (i > start) transitions[digits[i - 1]][digits[i]]++;
  }
  const blocks = Array.from({ length: totalBlocks }, (_, i) => ({ period: Math.floor(i / (periodLength / BLOCK)) }));
  const calibration = Object.fromEntries([...MODELS, "uniform"].map(model => [model,
    Array.from({ length: 10 }, () => ({ n: 0, probability: 0, observed: 0 }))]));
  const periodCalibration = Object.fromEntries([...MODELS, "uniform"].map(model => [model,
    Array.from({ length: PERIODS }, () => Array.from({ length: 10 }, () => ({ n: 0, probability: 0, observed: 0 })))]));
  const immediate = Object.fromEntries(MODELS.map(model => [model, ["top1", "top2", "top3", "logLoss", "brier",
    "uniformLogLossGain", "frequencyLogLossGain", "markovLogLossGain", "uniformBrierGain", "frequencyBrierGain", "markovBrierGain"]]));
  const recurrenceKeys = [
    ...[2, 3, 4, 5].map(n => `within${n}`),
    ...[1, 2, 3, 4, 5].map(n => `exact${n}`),
    ...[1, 2, 3, 4, 5].map(n => `conditional${n}`), "none5",
  ];
  let distributionDifference = 0, distributionCount = 0;
  const end = warmup + periodLength * PERIODS;
  for (let i = warmup; i < end; i++) {
    const block = blocks[Math.floor((i - warmup) / BLOCK)];
    const frequency = counts.map(c => c / (Math.min(i, windowSize) + 10));
    const row = transitions[digits[i - 1]], rowTotal = row.reduce((a, b) => a + b, 0);
    const vectors = { frequency, markov: row.map(c => c / rowTotal), uniform: UNIFORM };
    if (rowTotal - 10 >= 5) {
      const combined = frequency.map((p, d) => frequencyWeight * p + (1 - frequencyWeight) * vectors.markov[d]);
      if (uniqueTop(combined) !== null) vectors.combined = combined;
    }
    const actual = digits[i];
    distributionDifference += vectors.markov.reduce((sum, p, d) => sum + Math.abs(p - frequency[d]), 0) / 2;
    distributionCount++;
    for (const [model, vector] of Object.entries(vectors)) {
      for (let k = 1; k <= 3; k++) {
        if (k === 1 && model !== "uniform" && uniqueTop(vector) === null) continue;
        addMetric(block, `${model}:top${k}`, topKScore(vector, actual, k));
      }
      const loss = logLoss(vector, actual), score = brier(vector, actual);
      addMetric(block, `${model}:logLoss`, loss);
      addMetric(block, `${model}:brier`, score);
      if (model !== "uniform") {
        addMetric(block, `${model}:uniformLogLossGain`, logLoss(UNIFORM, actual) - loss);
        addMetric(block, `${model}:frequencyLogLossGain`, logLoss(frequency, actual) - loss);
        addMetric(block, `${model}:markovLogLossGain`, logLoss(vectors.markov, actual) - loss);
        addMetric(block, `${model}:uniformBrierGain`, brier(UNIFORM, actual) - score);
        addMetric(block, `${model}:frequencyBrierGain`, brier(frequency, actual) - score);
        addMetric(block, `${model}:markovBrierGain`, brier(vectors.markov, actual) - score);
      }
      vector.forEach((p, digit) => {
        const bin = calibration[model][Math.min(9, Math.floor(p * 10))];
        bin.n++; bin.probability += p; bin.observed += Number(digit === actual);
        const periodBin = periodCalibration[model][block.period][Math.min(9, Math.floor(p * 10))];
        periodBin.n++; periodBin.probability += p; periodBin.observed += Number(digit === actual);
      });
    }
    if ((i - warmup) % 5 === 0) {
      for (const model of MODELS) {
        if (!vectors[model]) continue;
        const selected = uniqueTop(vectors[model]);
        if (selected === null) continue;
        const outcomes = digits.slice(i, i + 5), hit = outcomes.indexOf(selected) + 1;
        const hazards = { model: vectors[model][selected], uniform: 0.1, frequency: frequency[selected] };
        for (const [baseline, p] of Object.entries(hazards)) {
          const prefix = `${model}:rec:${baseline}:`;
          for (let n = 2; n <= 5; n++) addMetric(block, `${prefix}within${n}`, Number(hit > 0 && hit <= n), 1 - (1 - p) ** n);
          for (let n = 1; n <= 5; n++) {
            addMetric(block, `${prefix}exact${n}`, Number(hit === n), (1 - p) ** (n - 1) * p);
            if (hit === 0 || hit >= n) addMetric(block, `${prefix}conditional${n}`, Number(hit === n), p);
          }
          addMetric(block, `${prefix}none5`, Number(hit === 0), (1 - p) ** 5);
        }
      }
    }
    counts[actual]++;
    transitions[digits[i - 1]][actual]++;
    if (i + 1 > windowSize) {
      const dropped = i - windowSize;
      counts[digits[dropped]]--;
      transitions[digits[dropped]][digits[dropped + 1]]--;
    }
  }
  const output = {};
  for (const model of MODELS) {
    const metrics = Object.fromEntries(immediate[model].map(key => [key, summarize(blocks, `${model}:${key}`)]));
    const periods = Array.from({ length: PERIODS }, (_, period) => {
      const subset = blocks.filter(b => b.period === period);
      return Object.fromEntries(["top1", "top2", "top3", "logLoss", "brier"].map(key => {
        const v = combine(subset, `${model}:${key}`);
        return [key, v.n ? v.observed / v.n : null];
      }));
    });
    const recurrence = {};
    for (const baseline of ["model", "uniform", "frequency"]) {
      recurrence[baseline] = Object.fromEntries(recurrenceKeys.map(key => [key, summarize(blocks, `${model}:rec:${baseline}:${key}`)]));
    }
    output[model] = { immediate: metrics, periods, recurrence };
  }
  const baseline = Object.fromEntries(["uniform", "frequency"].map(model => [model,
    Object.fromEntries(["top1", "top2", "top3", "logLoss", "brier"].map(key => [key, summarize(blocks, `${model}:${key}`)]))]));
  const formatBins = bins => bins.map(bin => ({
      n: bin.n, meanProbability: bin.n ? bin.probability / bin.n : null, observedRate: bin.n ? bin.observed / bin.n : null,
    }));
  for (const model of Object.keys(calibration)) {
    calibration[model] = formatBins(calibration[model]);
    periodCalibration[model] = periodCalibration[model].map(formatBins);
  }
  return {
    status: totalBlocks < MIN_BLOCKS ? "Insufficient Evidence" : "Under Validation", protocol, models: output, baselines: baseline, calibration, periodCalibration,
    meanTotalVariationBetweenModels: distributionDifference / distributionCount,
    rankTiePolicy: "Top-1 and recurrence exclude tied model leaders; top-2/3 and uniform baseline use expected random tie-breaking.",
  };
}
