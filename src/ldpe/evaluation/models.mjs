const DIGITS = 10;
const UNIFORM = Object.freeze(Array(DIGITS).fill(0.1));
const LOG_HALF = Math.log(0.5);
const KT_ALPHA = 0.1;

export function normalizeProbabilities(values) {
  if (!Array.isArray(values) || values.length !== DIGITS) return null;
  if (values.some((value) => !Number.isFinite(value) || value < 0)) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  return total > 0 ? values.map((value) => value / total) : null;
}

function countDigits(digits) {
  const counts = Array(DIGITS).fill(0);
  for (const digit of digits) {
    if (!Number.isInteger(digit) || digit < 0 || digit >= DIGITS) throw new Error("digit must be an integer from 0 to 9");
    counts[digit]++;
  }
  return counts;
}

function logGamma(z) {
  const coefficients = [
    676.5203681218851, -1259.1392167224028, 771.3234287776531,
    -176.6150291621406, 12.507343278686905, -0.13857109526572012,
    9.984369578019572e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * z)) - logGamma(1 - z);
  const x0 = z - 1;
  let x = 0.9999999999998099;
  for (let i = 0; i < coefficients.length; i++) x += coefficients[i] / (x0 + i + 1);
  const t = x0 + coefficients.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (x0 + 0.5) * Math.log(t) - t + Math.log(x);
}

function logDirichletMultinomial(counts, prior) {
  const total = counts.reduce((sum, value) => sum + value, 0);
  const priorTotal = prior.reduce((sum, value) => sum + value, 0);
  let result = logGamma(priorTotal) - logGamma(priorTotal + total);
  for (let digit = 0; digit < DIGITS; digit++) {
    result += logGamma(prior[digit] + counts[digit]) - logGamma(prior[digit]);
  }
  return result;
}

export function fitTuningParameters(digits, horizon) {
  if (!Number.isInteger(horizon) || horizon < 1 || horizon > 10) throw new Error("horizon must be from 1 to 10");
  const split = Math.floor(digits.length / 2);
  const baseCounts = countDigits(digits.slice(0, split));
  const base = normalizeProbabilities(baseCounts.map((count) => count + 1));
  const validationCounts = countDigits(digits.slice(split));
  const concentrations = [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
  let alpha = concentrations[0], bestLikelihood = -Infinity;
  for (const concentration of concentrations) {
    const likelihood = logDirichletMultinomial(validationCounts, base.map((probability) => probability * concentration));
    if (likelihood > bestLikelihood) { alpha = concentration; bestLikelihood = likelihood; }
  }

  const discounts = [0.99, 0.995, 0.998, 0.999];
  let discount = discounts[0], bestLoss = Infinity;
  for (const candidate of discounts) {
    const counts = Array(DIGITS).fill(0);
    for (let i = 0; i < split; i++) {
      for (let d = 0; d < DIGITS; d++) counts[d] *= candidate;
      counts[digits[i]]++;
    }
    let loss = 0, scored = 0;
    for (let origin = split; origin < digits.length - horizon; origin++) {
      const probabilities = normalizeProbabilities(counts.map((count) => count + 0.5));
      loss -= Math.log(Math.max(probabilities[digits[origin + horizon]], 1e-12));
      scored++;
      for (let d = 0; d < DIGITS; d++) counts[d] *= candidate;
      counts[digits[origin]]++;
    }
    if (scored && loss / scored < bestLoss) { discount = candidate; bestLoss = loss / scored; }
  }
  return { hierarchicalAlpha: alpha, hierarchicalBase: base, discount, tuningSplit: split };
}

function gammaPredictive(counts) {
  return normalizeProbabilities(counts.map((count) => count + KT_ALPHA));
}

function keyFor(digits, end, length) {
  if (length === 0) return "";
  if (end - length + 1 < 0) return null;
  return digits.slice(end - length + 1, end + 1).join("");
}

function logAdd(a, b) {
  const high = Math.max(a, b);
  return high + Math.log(Math.exp(a - high) + Math.exp(b - high));
}

export class CandidateForecaster {
  constructor(family, horizon, fitted = {}) {
    if (!["hdm", "ddir", "ctw", "inc", "lag"].includes(family)) throw new Error(`unknown candidate family: ${family}`);
    if (!Number.isInteger(horizon) || horizon < 1 || horizon > 10) throw new Error("horizon must be from 1 to 10");
    this.family = family;
    this.horizon = horizon;
    this.fitted = fitted;
    this.digits = [];
    this.segmentStart = 0;
    this.counts = Array(DIGITS).fill(0);
    this.discounted = Array(DIGITS).fill(0);
    this.incrementCounts = Array.from({ length: DIGITS }, () => Array(DIGITS).fill(0));
    this.lastIncrement = null;
    this.ctwNodes = Array.from({ length: 4 }, () => new Map());
    this.lagCounts = Array.from({ length: 5 }, () => new Map());
  }

  observe(digit) {
    if (!Number.isInteger(digit) || digit < 0 || digit >= DIGITS) throw new Error("digit must be an integer from 0 to 9");
    const index = this.digits.length;
    const previous = this.digits[index - 1];
    this.digits.push(digit);
    this.counts[digit]++;
    const discount = this.fitted.discount ?? 0.995;
    for (let d = 0; d < DIGITS; d++) this.discounted[d] *= discount;
    this.discounted[digit]++;

    if (previous !== undefined && index > this.segmentStart) {
      const increment = (digit - previous + DIGITS) % DIGITS;
      if (this.lastIncrement !== null) this.incrementCounts[this.lastIncrement][increment]++;
      this.lastIncrement = increment;
    }

    const origin = index - this.horizon;
    if (origin >= this.segmentStart) {
      for (let depth = 0; depth <= 3; depth++) {
        if (origin - depth + 1 < this.segmentStart) break;
        const key = keyFor(this.digits, origin, depth);
        if (key === null) continue;
        let node = this.ctwNodes[depth].get(key);
        if (!node) {
          node = { counts: Array(DIGITS).fill(0), total: 0, logKT: 0, logWeighted: 0 };
          this.ctwNodes[depth].set(key, node);
        }
        node.logKT += Math.log((node.counts[digit] + KT_ALPHA) / (node.total + DIGITS * KT_ALPHA));
        node.counts[digit]++;
        node.total++;
      }
      const maximumDepth = Math.min(3, origin - this.segmentStart + 1);
      for (let depth = maximumDepth; depth >= 0; depth--) {
        const key = keyFor(this.digits, origin, depth);
        if (key === null) continue;
        const node = this.ctwNodes[depth].get(key);
        if (depth === 3) {
          node.logWeighted = node.logKT;
        } else {
          let childEvidence = 0;
          for (let older = 0; older < DIGITS; older++) {
            childEvidence += this.ctwNodes[depth + 1].get(`${older}${key}`)?.logWeighted || 0;
          }
          node.logWeighted = logAdd(LOG_HALF + node.logKT, LOG_HALF + childEvidence);
        }
      }

      for (let lag = 0; lag <= 4; lag++) {
        const contextIndex = origin - lag;
        if (contextIndex < this.segmentStart) continue;
        const contextDigit = this.digits[contextIndex];
        let counts = this.lagCounts[lag].get(contextDigit);
        if (!counts) { counts = Array(DIGITS).fill(0); this.lagCounts[lag].set(contextDigit, counts); }
        counts[digit]++;
      }
    }
  }

  markDiscontinuity() {
    this.segmentStart = this.digits.length;
    this.lastIncrement = null;
  }

  predict() {
    if (!this.digits.length) return [...UNIFORM];
    switch (this.family) {
      case "hdm": {
        const base = this.fitted.hierarchicalBase || UNIFORM;
        const alpha = this.fitted.hierarchicalAlpha ?? 10;
        return normalizeProbabilities(this.counts.map((count, d) => count + alpha * base[d]));
      }
      case "ddir":
        return normalizeProbabilities(this.discounted.map((count) => count + 0.5));
      case "ctw":
        return this.#ctwPrediction();
      case "inc":
        return this.#incrementPrediction();
      case "lag":
        return this.#lagPrediction();
      default:
        throw new Error(`unhandled candidate family: ${this.family}`);
    }
  }

  #ctwPrediction() {
    const digits = this.digits;
    const nodeAt = (depth, key) => this.ctwNodes[depth].get(key) || { counts: Array(DIGITS).fill(0), logKT: 0, logWeighted: 0 };
    const predictAt = (depth, key, end) => {
      const node = nodeAt(depth, key), local = gammaPredictive(node.counts);
      if (depth === 3 || end - depth < this.segmentStart) return local;
      let childrenLog = 0;
      for (let older = 0; older < DIGITS; older++) childrenLog += nodeAt(depth + 1, `${older}${key}`).logWeighted;
      const totalLog = node.logWeighted;
      const stopWeight = Math.exp(LOG_HALF + node.logKT - totalLog);
      const splitWeight = Math.exp(LOG_HALF + childrenLog - totalLog);
      const older = digits[end - depth];
      const child = predictAt(depth + 1, `${older}${key}`, end);
      return normalizeProbabilities(local.map((probability, d) => stopWeight * probability + splitWeight * child[d]));
    };
    return predictAt(0, "", digits.length - 1);
  }

  #incrementPrediction() {
    const incrementPrior = Array(DIGITS).fill(0);
    for (const row of this.incrementCounts) for (let next = 0; next < DIGITS; next++) incrementPrior[next] += row[next];
    const first = this.lastIncrement === null
      ? normalizeProbabilities(incrementPrior.map((count) => count + 0.5))
      : normalizeProbabilities(this.incrementCounts[this.lastIncrement].map((count) => count + 0.5));
    let current = Array.from({ length: DIGITS }, () => Array(DIGITS).fill(0));
    for (let increment = 0; increment < DIGITS; increment++) current[increment][increment] = first[increment];
    for (let step = 1; step < this.horizon; step++) {
      const next = Array.from({ length: DIGITS }, () => Array(DIGITS).fill(0));
      for (let previous = 0; previous < DIGITS; previous++) {
        const transition = normalizeProbabilities(this.incrementCounts[previous].map((count) => count + 0.5));
        for (let sum = 0; sum < DIGITS; sum++) if (current[previous][sum]) {
          for (let increment = 0; increment < DIGITS; increment++) {
            next[increment][(sum + increment) % DIGITS] += current[previous][sum] * transition[increment];
          }
        }
      }
      current = next;
    }
    const sumDistribution = Array(DIGITS).fill(0);
    for (const row of current) for (let sum = 0; sum < DIGITS; sum++) sumDistribution[sum] += row[sum];
    const currentDigit = this.digits[this.digits.length - 1];
    const result = Array(DIGITS).fill(0);
    for (let increment = 0; increment < DIGITS; increment++) result[(currentDigit + increment) % DIGITS] = sumDistribution[increment];
    return normalizeProbabilities(result);
  }

  #lagPrediction() {
    const vectors = [];
    for (let lag = 0; lag <= 4; lag++) {
      const contextIndex = this.digits.length - 1 - lag;
      if (contextIndex < 0) continue;
      const counts = this.lagCounts[lag].get(this.digits[contextIndex]);
      if (!counts || counts.reduce((sum, count) => sum + count, 0) < 200) continue;
      vectors.push(normalizeProbabilities(counts.map((count) => count + 1)));
    }
    if (!vectors.length) return [...UNIFORM];
    const pooled = Array(DIGITS).fill(0);
    for (let d = 0; d < DIGITS; d++) {
      pooled[d] = Math.exp(vectors.reduce((sum, vector) => sum + Math.log(Math.max(vector[d], 1e-12)), 0) / vectors.length);
    }
    return normalizeProbabilities(pooled);
  }
}

const REGRESSION_LAGS = 4;
const REGRESSION_GAP_OFFSET = 1 + REGRESSION_LAGS * DIGITS;
const REGRESSION_RUN_OFFSET = REGRESSION_GAP_OFFSET + DIGITS;
const REGRESSION_FREQ_OFFSET = REGRESSION_RUN_OFFSET + DIGITS;
const REGRESSION_FEATURES = REGRESSION_FREQ_OFFSET + DIGITS;

function regressionFeatures(digits) {
  const features = [[0, 1]];
  for (let lag = 1; lag <= REGRESSION_LAGS; lag++) {
    const digit = digits[digits.length - lag];
    if (digit !== undefined) features.push([1 + (lag - 1) * DIGITS + digit, 1]);
  }

  const gaps = Array(DIGITS).fill(digits.length + 1);
  let unseen = DIGITS;
  for (let i = digits.length - 1; i >= 0; i--) {
    if (gaps[digits[i]] === digits.length + 1) {
      gaps[digits[i]] = digits.length - i;
      if (--unseen === 0) break;
    }
  }
  for (let digit = 0; digit < DIGITS; digit++) {
    features.push([REGRESSION_GAP_OFFSET + digit, Math.min(gaps[digit] / 122, 1)]);
  }

  const last = digits.at(-1);
  if (last !== undefined) {
    let runLength = 0;
    for (let i = digits.length - 1; i >= 0 && digits[i] === last; i--) runLength++;
    features.push([REGRESSION_RUN_OFFSET + last, Math.min(runLength / 5, 1)]);
  }

  const recent = digits.slice(-100);
  const counts = Array(DIGITS).fill(0);
  for (const digit of recent) counts[digit]++;
  for (let digit = 0; digit < DIGITS; digit++) {
    features.push([REGRESSION_FREQ_OFFSET + digit, counts[digit] / Math.max(1, recent.length) - 0.1]);
  }
  return features;
}

function regressionProbabilities(weights, features) {
  const logits = Array(DIGITS).fill(0);
  for (let digit = 0; digit < DIGITS; digit++) {
    const offset = digit * REGRESSION_FEATURES;
    for (const [feature, value] of features) logits[digit] += weights[offset + feature] * value;
  }
  const maximum = Math.max(...logits);
  return normalizeProbabilities(logits.map((value) => Math.exp(value - maximum)));
}

function isValidProbabilityVector(values) {
  if (!Array.isArray(values) || values.length !== DIGITS ||
      values.some((value) => !Number.isFinite(value) || value < 0)) return false;
  return Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) <= 1e-8;
}

export class SoftmaxRegressionForecaster {
  constructor(horizon, { learningRate = 0.03, l2 = 0.0005 } = {}) {
    if (!Number.isInteger(horizon) || horizon < 1 || horizon > 10) throw new Error("horizon must be from 1 to 10");
    if (!(learningRate > 0) || !Number.isFinite(learningRate)) throw new Error("learningRate must be positive");
    if (!(l2 >= 0) || !Number.isFinite(l2)) throw new Error("l2 must be non-negative");
    this.horizon = horizon;
    this.learningRate = learningRate;
    this.l2 = l2;
    this.digits = [];
    this.originFeatures = [];
    this.weights = new Float64Array(DIGITS * REGRESSION_FEATURES);
    this.currentFeatures = [[0, 1]];
  }

  observe(digit) {
    if (!Number.isInteger(digit) || digit < 0 || digit >= DIGITS) throw new Error("digit must be an integer from 0 to 9");
    this.digits.push(digit);
    const origin = this.digits.length - 1 - this.horizon;
    if (origin >= 0) this.#learn(this.originFeatures[origin], digit);
    this.currentFeatures = regressionFeatures(this.digits);
    this.originFeatures.push(this.currentFeatures);
  }

  predict() {
    return regressionProbabilities(this.weights, this.currentFeatures);
  }

  #learn(features, actual) {
    if (!features) return;
    const probabilities = regressionProbabilities(this.weights, features);
    for (let digit = 0; digit < DIGITS; digit++) {
      const error = (digit === actual ? 1 : 0) - probabilities[digit];
      const offset = digit * REGRESSION_FEATURES;
      for (const [feature, value] of features) {
        const index = offset + feature;
        this.weights[index] += this.learningRate * (error * value - this.l2 * this.weights[index]);
      }
    }
  }
}

export class GapRampForecaster {
  constructor(horizon, limit = 122) {
    if (!Number.isInteger(horizon) || horizon < 1 || horizon > 10) throw new Error("horizon must be from 1 to 10");
    if (!(limit > 0) || !Number.isFinite(limit)) throw new Error("limit must be positive");
    this.horizon = horizon;
    this.limit = limit;
    this.digits = [];
  }

  observe(digit) {
    if (!Number.isInteger(digit) || digit < 0 || digit >= DIGITS) throw new Error("digit must be an integer from 0 to 9");
    this.digits.push(digit);
  }

  predict() {
    const gaps = Array(DIGITS).fill(this.digits.length + 1);
    let unseen = DIGITS;
    for (let i = this.digits.length - 1; i >= 0; i--) {
      const digit = this.digits[i];
      if (gaps[digit] === this.digits.length + 1) {
        gaps[digit] = this.digits.length - i;
        if (--unseen === 0) break;
      }
    }
    return normalizeProbabilities(gaps.map((gap) => 1 + Math.min(gap / this.limit, 1)));
  }
}

export class EarnedWeightMixture {
  constructor(clusters, { eta = 0.02, uniformFloor = 0.05, clusterCap = 0.4 } = {}) {
    if (!clusters || typeof clusters !== "object" || !Object.keys(clusters).length) {
      throw new Error("at least one named model cluster is required");
    }
    const names = Object.keys(clusters);
    if (names.some((name) => typeof clusters[name] !== "string" || !clusters[name])) {
      throw new Error("every model must have a non-empty cluster name");
    }
    const clusterCount = new Set(Object.values(clusters)).size;
    if (!(eta > 0) || !Number.isFinite(eta)) throw new Error("eta must be positive");
    if (!(uniformFloor >= 0 && uniformFloor < 1) || !Number.isFinite(uniformFloor)) {
      throw new Error("uniformFloor must be in [0, 1)");
    }
    if (!(clusterCap > 0 && clusterCap <= 1) || clusterCount * clusterCap < 1) {
      throw new Error("clusterCap must be positive and provide enough total cluster capacity");
    }
    this.clusters = { ...clusters };
    this.eta = eta;
    this.uniformFloor = uniformFloor;
    this.clusterCap = clusterCap;
    this.relativeLoss = Object.fromEntries(names.map((name) => [name, 0]));
  }

  getWeights() {
    const names = Object.keys(this.clusters);
    const minimum = Math.min(...names.map((name) => this.relativeLoss[name]));
    const raw = Object.fromEntries(names.map((name) =>
      [name, Math.exp(Math.max(-700, -this.eta * (this.relativeLoss[name] - minimum)))]));
    const clusterRaw = new Map();
    for (const name of names) {
      const cluster = this.clusters[name];
      clusterRaw.set(cluster, (clusterRaw.get(cluster) || 0) + raw[name]);
    }

    const clusterWeights = new Map();
    let active = [...clusterRaw.keys()];
    let remaining = 1;
    while (active.length) {
      const total = active.reduce((sum, cluster) => sum + clusterRaw.get(cluster), 0);
      const capped = active.filter((cluster) => remaining * clusterRaw.get(cluster) / total > this.clusterCap);
      if (!capped.length) {
        for (const cluster of active) clusterWeights.set(cluster, remaining * clusterRaw.get(cluster) / total);
        break;
      }
      for (const cluster of capped) {
        clusterWeights.set(cluster, this.clusterCap);
        remaining -= this.clusterCap;
      }
      active = active.filter((cluster) => !capped.includes(cluster));
    }

    const weights = {};
    for (const name of names) {
      const cluster = this.clusters[name];
      const withinCluster = raw[name] / clusterRaw.get(cluster);
      weights[name] = clusterWeights.get(cluster) * withinCluster;
    }
    return weights;
  }

  predict(forecasts) {
    const names = Object.keys(this.clusters);
    const invalid = !forecasts ? names : names.filter((name) => !isValidProbabilityVector(forecasts[name]));
    if (invalid.length) {
      throw new Error(`mixture requires valid forecast vectors; invalid: ${invalid.join(", ")}`);
    }
    const weights = this.getWeights();
    const result = Array(DIGITS).fill(0);
    for (const name of names) {
      for (let digit = 0; digit < DIGITS; digit++) result[digit] += weights[name] * forecasts[name][digit];
    }
    return normalizeProbabilities(result.map((probability) =>
      (1 - this.uniformFloor) * probability + this.uniformFloor / DIGITS));
  }

  observe(forecasts, actual) {
    if (!Number.isInteger(actual) || actual < 0 || actual >= DIGITS) {
      throw new Error("actual digit must be an integer from 0 to 9");
    }
    const names = Object.keys(this.clusters);
    const invalid = !forecasts ? names : names.filter((name) => !isValidProbabilityVector(forecasts[name]));
    if (invalid.length) {
      throw new Error(`mixture update requires valid forecast vectors; invalid: ${invalid.join(", ")}`);
    }
    for (const name of names) {
      this.relativeLoss[name] += -Math.log(Math.max(forecasts[name][actual], 1e-12)) - Math.log(10);
    }
  }
}
