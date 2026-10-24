const EPSILON = 1e-12;
export const REGISTERED_PRACTICAL_THRESHOLD = 0.0005;
export const REGISTERED_PLANNING_EFFECT = 0.001;

export function logLoss(probabilities, actual) {
  return -Math.log(Math.max(probabilities[actual] ?? 0, EPSILON));
}

export function brierScore(probabilities, actual) {
  return probabilities.reduce((sum, probability, digit) =>
    sum + (probability - (digit === actual ? 1 : 0)) ** 2, 0);
}

export function summarizeForecasts(rows) {
  if (!rows.length) return { n: 0 };
  const candidateLoss = [], referenceLoss = [], candidateBrier = [], referenceBrier = [];
  let candidateHits = 0, referenceHits = 0;
  for (const row of rows) {
    candidateLoss.push(logLoss(row.candidate, row.actual));
    referenceLoss.push(logLoss(row.reference, row.actual));
    candidateBrier.push(brierScore(row.candidate, row.actual));
    referenceBrier.push(brierScore(row.reference, row.actual));
    if (argmax(row.candidate) === row.actual) candidateHits++;
    if (argmax(row.reference) === row.actual) referenceHits++;
  }
  const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const differences = candidateLoss.map((loss, i) => referenceLoss[i] - loss);
  return {
    n: rows.length,
    deltaLogLoss: mean(differences),
    pairedLogLossDifferences: differences,
    candidateLogLoss: mean(candidateLoss),
    referenceLogLoss: mean(referenceLoss),
    candidateBrier: mean(candidateBrier),
    referenceBrier: mean(referenceBrier),
    candidateHitRate: candidateHits / rows.length,
    referenceHitRate: referenceHits / rows.length,
    hitRateDifference: (candidateHits - referenceHits) / rows.length,
    candidateTopDigit: rows.filter((row) => argmax(row.candidate) === row.actual).length,
  };
}

function argmax(values) {
  let best = 0;
  for (let i = 1; i < values.length; i++) if (values[i] > values[best]) best = i;
  return best;
}

export function holmAdjust(pValues) {
  if (!Array.isArray(pValues) || pValues.some((p) => !Number.isFinite(p) || p < 0 || p > 1)) {
    throw new Error("p-values must be finite numbers between zero and one");
  }
  const order = pValues.map((p, index) => ({ p, index })).sort((a, b) => a.p - b.p || a.index - b.index);
  const adjusted = Array(pValues.length).fill(1);
  let running = 0;
  for (let rank = 0; rank < order.length; rank++) {
    running = Math.max(running, Math.min(1, (order.length - rank) * order[rank].p));
    adjusted[order[rank].index] = running;
  }
  return adjusted;
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export function stationaryBootstrapCI(values, {
  meanBlockLength = 50, replicates = 20000, seed = 11, confidence = 0.95,
} = {}) {
  if (!values.length || !Number.isInteger(meanBlockLength) || meanBlockLength < 1 ||
      !Number.isInteger(replicates) || replicates < 100 || !(confidence > 0 && confidence < 1)) {
    throw new Error("invalid stationary bootstrap arguments");
  }
  const n = values.length, random = seededRandom(seed), means = new Array(replicates);
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + values[i];
  const circularSum = (start, length) => {
    const end = start + length;
    return end <= n ? prefix[end] - prefix[start] : prefix[n] - prefix[start] + prefix[end - n];
  };
  const restartProbability = 1 / meanBlockLength;
  for (let replicate = 0; replicate < replicates; replicate++) {
    let sum = 0, sampled = 0;
    while (sampled < n) {
      const start = Math.floor(random() * n);
      const uniform = Math.max(random(), Number.MIN_VALUE);
      const block = restartProbability === 1 ? 1 : Math.floor(Math.log(uniform) / Math.log(1 - restartProbability)) + 1;
      const length = Math.min(block, n - sampled);
      sum += circularSum(start, length);
      sampled += length;
    }
    means[replicate] = sum / n;
  }
  means.sort((a, b) => a - b);
  const tail = (1 - confidence) / 2;
  return [means[Math.floor(tail * replicates)], means[Math.min(replicates - 1, Math.ceil((1 - tail) * replicates) - 1)]];
}

function normalCdf(x) {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * z);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return 0.5 * (1 + sign * erf);
}

function normalQuantile(p) {
  if (!(p > 0 && p < 1)) throw new Error("normal quantile requires a probability strictly between zero and one");
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const low = 0.02425, high = 1 - low;
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > high) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function neweyWestTest(values, lag = 200) {
  if (values.length < 2 || !Number.isInteger(lag) || lag < 0) throw new Error("invalid Newey-West test arguments");
  const center = mean(values), n = values.length;
  let longRunVariance = values.reduce((sum, value) => sum + (value - center) ** 2, 0) / n;
  const maxLag = Math.min(lag, n - 1);
  for (let k = 1; k <= maxLag; k++) {
    let covariance = 0;
    for (let i = k; i < n; i++) covariance += (values[i] - center) * (values[i - k] - center);
    covariance /= n;
    longRunVariance += 2 * (1 - k / (maxLag + 1)) * covariance;
  }
  longRunVariance = Math.max(longRunVariance, EPSILON);
  const standardError = Math.sqrt(longRunVariance / n);
  const z = center / standardError;
  return { mean: center, standardError, z, pValueOneSided: 1 - normalCdf(z), longRunVariance, lag: maxLag };
}

export function bonferroniInterval(meanValue, standardError, alpha = 0.05, familySize = 1) {
  if (!(standardError >= 0) || !(alpha > 0 && alpha < 1) || !Number.isInteger(familySize) || familySize < 1) {
    throw new Error("invalid Bonferroni interval arguments");
  }
  const critical = normalQuantile(1 - alpha / (2 * familySize));
  return [meanValue - critical * standardError, meanValue + critical * standardError];
}

export function promotionPower({
  varianceA, varianceB, covariance, sampleSize, planningEffect = REGISTERED_PLANNING_EFFECT,
  effectToDetect = planningEffect, practicalThreshold = REGISTERED_PRACTICAL_THRESHOLD,
  alpha = 0.05, familySize = 180, simulations = 100000, seed = 71,
}) {
  if (sampleSize < 2 || varianceA < 0 || varianceB < 0 || familySize < 1 || simulations < 1000) {
    throw new Error("invalid power calculation arguments");
  }
  if (planningEffect !== REGISTERED_PLANNING_EFFECT ||
      ![REGISTERED_PLANNING_EFFECT, REGISTERED_PRACTICAL_THRESHOLD].includes(effectToDetect) ||
      practicalThreshold !== REGISTERED_PRACTICAL_THRESHOLD || alpha !== 0.05) {
    throw new Error("power inputs must match the registered planning effect, practical threshold, and alpha");
  }
  const random = seededRandom(seed);
  const seA = Math.sqrt(varianceA / sampleSize), seB = Math.sqrt(varianceB / sampleSize);
  const correlation = seA && seB ? Math.max(-0.999, Math.min(0.999, covariance / Math.sqrt(varianceA * varianceB))) : 0;
  const critical = normalQuantile(1 - alpha / (2 * familySize));
  let passed = 0;
  for (let i = 0; i < simulations; i++) {
    const u1 = Math.max(random(), EPSILON), u2 = random();
    const z1 = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const u3 = Math.max(random(), EPSILON), u4 = random();
    const independent = Math.sqrt(-2 * Math.log(u3)) * Math.cos(2 * Math.PI * u4);
    const z2 = correlation * z1 + Math.sqrt(1 - correlation * correlation) * independent;
    const estimateA = effectToDetect + seA * z1, estimateB = effectToDetect + seB * z2;
    if (estimateA >= practicalThreshold && estimateB >= practicalThreshold &&
        estimateA - critical * seA > 0 && estimateB - critical * seB > 0) passed++;
  }
  return { power: passed / simulations, planningEffect, effectToDetect, practicalThreshold, sampleSize, familySize, critical };
}

export function splitChronologically(total, {
  tuningShare = 0.2, developmentShare = 0.55, holdoutShare = 0.25, purgeTicks = 10,
} = {}) {
  if (!Number.isInteger(total) || total < 1 || Math.abs(tuningShare + developmentShare + holdoutShare - 1) > 1e-9 ||
      !Number.isInteger(purgeTicks) || purgeTicks < 0) throw new Error("invalid chronological split");
  const first = Math.floor(total * tuningShare), second = Math.floor(total * (tuningShare + developmentShare));
  const segments = {
    tuning: [0, Math.max(0, first - purgeTicks)],
    development: [Math.min(total, first + purgeTicks), Math.max(Math.min(total, first + purgeTicks), second - purgeTicks)],
    holdout: [Math.min(total, second + purgeTicks), total],
  };
  return { segments, boundaries: [first, second], purgeTicks };
}

export function pairedCovariance(a, b) {
  if (a.length !== b.length || a.length < 2) throw new Error("paired arrays must have equal length of at least two");
  const meanA = mean(a), meanB = mean(b);
  return a.reduce((sum, value, index) => sum + (value - meanA) * (b[index] - meanB), 0) / a.length;
}

export function longRunCovariance(a, b, lag = 200) {
  if (a.length !== b.length || a.length < 2 || !Number.isInteger(lag) || lag < 0) {
    throw new Error("paired arrays must have equal length and a valid covariance lag");
  }
  const n = a.length, meanA = mean(a), meanB = mean(b), maxLag = Math.min(lag, n - 1);
  let covariance = 0;
  for (let i = 0; i < n; i++) covariance += (a[i] - meanA) * (b[i] - meanB);
  covariance /= n;
  for (let k = 1; k <= maxLag; k++) {
    let forward = 0, backward = 0;
    for (let i = k; i < n; i++) {
      forward += (a[i] - meanA) * (b[i - k] - meanB);
      backward += (b[i] - meanB) * (a[i - k] - meanA);
    }
    covariance += (1 - k / (maxLag + 1)) * (forward + backward) / n;
  }
  return covariance;
}
