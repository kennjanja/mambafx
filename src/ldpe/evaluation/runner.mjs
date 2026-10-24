import { Ldpe, validVector } from "../engine.js";
import { CandidateForecaster, fitTuningParameters, normalizeProbabilities } from "./models.mjs";
import { EVALUATION_SYMBOLS, dateCoverage, validateDatasetRows } from "./data.mjs";
import {
  bonferroniInterval, holmAdjust, longRunCovariance, neweyWestTest, promotionPower,
  splitChronologically, stationaryBootstrapCI,
} from "./statistics.mjs";

export const CANDIDATE_FAMILIES = Object.freeze(["hdm", "ddir", "ctw", "inc", "lag"]);
export const FORECAST_HORIZONS = Object.freeze([1, 5, 10]);
export const PRIMARY_REFERENCES = Object.freeze(["uniform", "ensemble"]);
export const MIN_DEVELOPMENT_FORECASTS = 100000;
export const PRACTICAL_THRESHOLD = 0.0005;
export const PLANNING_EFFECT = 0.001;
export const REGISTERED_COMPARISONS = 180;

const UNIFORM = Object.freeze(Array(10).fill(0.1));
const MAX_BRIER_DEGRADATION = 0.001;
const MAX_ECE_DEGRADATION = 0.01;
const MIN_POSITIVE_DAY_FRACTION = 0.7;
const MAX_SINGLE_DAY_GAIN_SHARE = 0.5;
const DEFAULT_EVALUATION_OPTIONS = Object.freeze({
  tuningShare: 0.2, developmentShare: 0.55, holdoutShare: 0.25, purgeTicks: 10,
  minimumTicks: 100, neweyWestLag: 200, primaryBlockLength: 50,
  sensitivityBlockLengths: [10, 200], bootstrapReplicates: 20000,
  powerSimulations: 100000,
});

function newAccumulator() {
  return {
    n: 0, delta: [], candidateLoss: 0, referenceLoss: 0, candidateBrier: 0, referenceBrier: 0,
    candidateHits: 0, referenceHits: 0,
    candidateBins: Array.from({ length: 10 }, () => ({ n: 0, p: 0, y: 0 })),
    referenceBins: Array.from({ length: 10 }, () => ({ n: 0, p: 0, y: 0 })),
    byDay: new Map(), byPeriod: new Map(), confidenceBins: Array(10).fill(0),
    confidenceSum: 0, byDigit: Array.from({ length: 10 }, () => ({ n: 0, sum: 0 })),
  };
}

function newModuleAccumulator() {
  return { n: 0, logLoss: 0, brier: 0, hits: 0, weight: 0, losses: [], ensembleLosses: [] };
}

function pearsonCorrelation(a, b) {
  if (a.length !== b.length || a.length < 2) return null;
  const meanA = a.reduce((sum, value) => sum + value, 0) / a.length;
  const meanB = b.reduce((sum, value) => sum + value, 0) / b.length;
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) {
    const da = a[i] - meanA, db = b[i] - meanB;
    ab += da * db; aa += da * da; bb += db * db;
  }
  return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : null;
}

function moduleEvaluationSummary(modules) {
  return Object.fromEntries(Object.entries(modules).map(([name, acc]) => [name, {
    n: acc.n,
    logLoss: acc.n ? acc.logLoss / acc.n : null,
    brier: acc.n ? acc.brier / acc.n : null,
    top1: acc.n ? acc.hits / acc.n : null,
    meanEnsembleWeight: acc.n ? acc.weight / acc.n : null,
    lossCorrelationWithEnsemble: pearsonCorrelation(acc.losses, acc.ensembleLosses),
    inference: "descriptive only; not an additional registered hypothesis",
  }]));
}

function updateCalibration(acc, probabilities, actual) {
  for (let digit = 0; digit < 10; digit++) {
    const bin = Math.min(9, Math.floor(probabilities[digit] * 10));
    const record = acc.bins[bin];
    record.n++;
    record.p += probabilities[digit];
    record.y += digit === actual ? 1 : 0;
  }
}

function addComparison(acc, candidate, reference, actual, referenceKind, day, period) {
  const candidateLoss = -Math.log(Math.max(candidate[actual], 1e-12));
  const referenceLoss = referenceKind === "uniform" ? Math.log(10) : -Math.log(Math.max(reference[actual], 1e-12));
  const candidateBrier = candidate.reduce((sum, p, d) => sum + (p - (d === actual ? 1 : 0)) ** 2, 0);
  const referenceBrier = referenceKind === "uniform"
    ? 0.9
    : reference.reduce((sum, p, d) => sum + (p - (d === actual ? 1 : 0)) ** 2, 0);
  const candidateHit = candidate.indexOf(Math.max(...candidate)) === actual ? 1 : 0;
  const referenceHit = referenceKind === "uniform" ? 0.1 : (reference.indexOf(Math.max(...reference)) === actual ? 1 : 0);
  acc.n++;
  acc.delta.push(referenceLoss - candidateLoss);
  acc.candidateLoss += candidateLoss;
  acc.referenceLoss += referenceLoss;
  acc.candidateBrier += candidateBrier;
  acc.referenceBrier += referenceBrier;
  acc.candidateHits += candidateHit;
  acc.referenceHits += referenceHit;
  updateCalibration({ bins: acc.candidateBins }, candidate, actual);
  updateCalibration({ bins: acc.referenceBins }, reference, actual);
  const confidence = Math.max(...candidate);
  acc.confidenceSum += confidence;
  acc.confidenceBins[Math.min(9, Math.floor(confidence * 10))]++;
  const daily = acc.byDay.get(day) || { n: 0, sum: 0 };
  daily.n++;
  daily.sum += referenceLoss - candidateLoss;
  acc.byDay.set(day, daily);
  const timed = acc.byPeriod.get(period) || { n: 0, sum: 0 };
  timed.n++;
  timed.sum += referenceLoss - candidateLoss;
  acc.byPeriod.set(period, timed);
  const byDigit = acc.byDigit[actual];
  byDigit.n++;
  byDigit.sum += referenceLoss - candidateLoss;
}

function calibrationSummary(bins) {
  const total = bins.reduce((sum, bin) => sum + bin.n, 0);
  if (!total) return { expectedCalibrationError: null, bins: [] };
  const summarizedBins = bins.map((bin, index) => ({
    bin: index,
    n: bin.n,
    meanProbability: bin.n ? bin.p / bin.n : null,
    observedFrequency: bin.n ? bin.y / bin.n : null,
  }));
  const ece = bins.reduce((sum, bin) => sum + (bin.n ? bin.n / total * Math.abs(bin.p / bin.n - bin.y / bin.n) : 0), 0);
  return { expectedCalibrationError: ece, bins: summarizedBins };
}

function dailySummary(acc) {
  return [...acc.byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, item]) => ({
    day, n: item.n, meanDeltaLogLoss: item.sum / item.n,
  }));
}

function periodSummary(acc) {
  return [...acc.byPeriod.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([period, item]) => ({
    period, n: item.n, meanDeltaLogLoss: item.sum / item.n,
  }));
}

function stabilitySummary(days) {
  const eligibleDays = days.filter((day) => day.n >= 1000);
  const positiveDays = eligibleDays.filter((day) => day.meanDeltaLogLoss > 0).length;
  const positiveGain = eligibleDays.reduce((sum, day) => sum + Math.max(0, day.meanDeltaLogLoss * day.n), 0);
  const largestGain = eligibleDays.reduce((max, day) => Math.max(max, Math.max(0, day.meanDeltaLogLoss * day.n)), 0);
  const positiveFraction = eligibleDays.length ? positiveDays / eligibleDays.length : 0;
  const largestShare = positiveGain ? largestGain / positiveGain : 1;
  return {
    eligibleDays: eligibleDays.length,
    positiveDays,
    positiveDayFraction: positiveFraction,
    largestSingleDayPositiveGainShare: largestShare,
    passes: eligibleDays.length >= 7 && positiveFraction >= MIN_POSITIVE_DAY_FRACTION &&
      largestShare <= MAX_SINGLE_DAY_GAIN_SHARE,
  };
}

function finalizeComparison(acc, family, symbol, horizon, referenceKind, {
  inference = false, familySize = REGISTERED_COMPARISONS, options = DEFAULT_EVALUATION_OPTIONS,
} = {}) {
  if (!acc.n) return {
    family, symbol, horizon, reference: referenceKind, n: 0, deltaLogLoss: null,
    status: "no eligible paired forecasts", pValue: 1, ordinaryCI: null, simultaneousCI: null,
  };
  const n = acc.n, meanDelta = acc.delta.reduce((sum, value) => sum + value, 0) / n;
  const model = {
    family, symbol, horizon, reference: referenceKind, n, deltaLogLoss: meanDelta,
    candidateLogLoss: acc.candidateLoss / n, referenceLogLoss: acc.referenceLoss / n,
    candidateBrier: acc.candidateBrier / n, referenceBrier: acc.referenceBrier / n,
    candidateHitRate: acc.candidateHits / n, referenceHitRate: acc.referenceHits / n,
    hitRateDifference: (acc.candidateHits - acc.referenceHits) / n,
    calibration: {
      candidate: calibrationSummary(acc.candidateBins),
      reference: calibrationSummary(acc.referenceBins),
      brierDegradation: acc.candidateBrier / n - acc.referenceBrier / n,
    },
    meanTopDigitProbability: acc.confidenceSum / n,
    topDigitProbabilityBins: acc.confidenceBins,
    byDay: dailySummary(acc),
    byTimePeriodUtc4Hours: periodSummary(acc),
    stability: stabilitySummary(dailySummary(acc)),
    byDigit: acc.byDigit.map((item, digit) => ({ digit, n: item.n, meanDeltaLogLoss: item.n ? item.sum / item.n : null })),
    status: "evaluated",
    rawPValue: null,
    adjustedPValueHolm: null,
    ordinaryCI: null,
    simultaneousCI: null,
    blockSensitivity: [],
  };
  if (inference && n >= 2) {
    const nw = neweyWestTest(acc.delta, options.neweyWestLag);
    model.rawPValue = nw.pValueOneSided;
    model.neweyWest = nw;
    model.ordinaryCI = stationaryBootstrapCI(acc.delta, {
      meanBlockLength: options.primaryBlockLength, replicates: options.bootstrapReplicates,
      seed: seedFor(symbol, horizon, family, referenceKind, options.primaryBlockLength),
    });
    model.blockSensitivity = [options.primaryBlockLength, ...options.sensitivityBlockLengths].map((blockLength) => {
      const ci = blockLength === options.primaryBlockLength ? model.ordinaryCI : stationaryBootstrapCI(acc.delta, {
        meanBlockLength: blockLength, replicates: options.bootstrapReplicates,
        seed: seedFor(symbol, horizon, family, referenceKind, blockLength),
      });
      return { meanBlockLength: blockLength, interval: ci };
    });
    model.simultaneousCI = bonferroniInterval(meanDelta, nw.standardError, 0.05, familySize);
  }
  return model;
}

function seedFor(symbol, horizon, family, referenceKind, blockLength) {
  const text = `${symbol}:${horizon}:${family}:${referenceKind}:${blockLength}`;
  let seed = 2166136261;
  for (let i = 0; i < text.length; i++) seed = Math.imul(seed ^ text.charCodeAt(i), 16777619);
  return seed >>> 0;
}

function makeAccumulators(families = CANDIDATE_FAMILIES) {
  const output = {};
  for (const family of families) output[family] = { uniform: newAccumulator(), ensemble: newAccumulator() };
  return output;
}

function segmentFor(index, segments) {
  if (index >= segments.tuning[0] && index < segments.tuning[1]) return "tuning";
  if (index >= segments.development[0] && index < segments.development[1]) return "development";
  if (index >= segments.holdout[0] && index < segments.holdout[1]) return "holdout";
  return null;
}

function collectCellData(ticks, symbol, horizon, segments, {
  stage, families = CANDIDATE_FAMILIES, fitted = null, minimumTicks = 100,
} = {}) {
  const tuningDigits = ticks.slice(segments.tuning[0], segments.tuning[1]).map((tick) => tick.digit);
  const params = fitted || fitTuningParameters(tuningDigits, horizon);
  const candidates = Object.fromEntries(families.map((family) => [family, new CandidateForecaster(family, horizon, params)]));
  const engine = new Ldpe({ horizon, minTicks: minimumTicks });
  engine.historyMax = 2000;
  const pending = new Map(), accumulators = {
    tuning: makeAccumulators(families),
    development: makeAccumulators(families),
    holdout: makeAccumulators(families),
  };
  const moduleAccumulators = { tuning: {}, development: {}, holdout: {} };
  const latency = Object.fromEntries(families.map((family) => [family, { totalNs: 0, maxNs: 0, forecasts: 0 }]));
  const exclusions = { invalidReference: 0, invalidCandidate: 0, discontinuousTarget: 0, purgedBoundary: 0, warmup: 0 };
  const maximumIndex = stage === "development" ? segments.development[1] : segments.holdout[1];
  for (let index = 0; index < maximumIndex; index++) {
    const tick = ticks[index];
    if (tick.gapBefore) {
      engine.markDiscontinuity(symbol);
      for (const candidate of Object.values(candidates)) candidate.markDiscontinuity();
    }
    const result = engine.ingest(symbol, tick);
    if (!result.accepted) continue;
    const seq = engine.state(symbol).seq;
    const matured = pending.get(seq);
    if (matured) {
      pending.delete(seq);
      if (!engine.contiguous(symbol, matured.madeAtSeq, matured.targetSeq)) {
        exclusions.discontinuousTarget++;
      } else {
        const targetStage = segmentFor(index, segments);
        const recordStage = stage === "development"
          ? (targetStage === "tuning" || targetStage === "development" ? targetStage : null)
          : targetStage === "holdout" ? "holdout" : null;
        if (targetStage === matured.stage && recordStage) {
          const day = new Date(Number(tick.epoch) * 1000).toISOString().slice(0, 10);
          const hour = new Date(Number(tick.epoch) * 1000).getUTCHours();
          const period = `${day}T${String(Math.floor(hour / 4) * 4).padStart(2, "0")}:00Z`;
          for (const family of families) {
            const candidate = matured.vectors[family];
            if (!validVector(candidate)) { exclusions.invalidCandidate++; continue; }
            addComparison(accumulators[recordStage][family].uniform, candidate, UNIFORM, result.digit, "uniform", day, period);
            addComparison(accumulators[recordStage][family].ensemble, candidate, matured.ensemble, result.digit, "ensemble", day, period);
          }
          const ensembleLoss = -Math.log(Math.max(matured.ensemble[result.digit], 1e-12));
          for (const [name, vector] of Object.entries(matured.modules || {})) {
            if (!validVector(vector)) continue;
            const acc = moduleAccumulators[recordStage][name] || (moduleAccumulators[recordStage][name] = newModuleAccumulator());
            const loss = -Math.log(Math.max(vector[result.digit], 1e-12));
            const brier = vector.reduce((sum, p, d) => sum + (p - (d === result.digit ? 1 : 0)) ** 2, 0);
            acc.n++;
            acc.logLoss += loss;
            acc.brier += brier;
            acc.hits += vector.indexOf(Math.max(...vector)) === result.digit ? 1 : 0;
            acc.weight += matured.weights?.[name] ?? 0;
            acc.losses.push(loss);
            acc.ensembleLosses.push(ensembleLoss);
          }
        }
      }
    }
    for (const candidate of Object.values(candidates)) candidate.observe(result.digit);
    const forecast = result.forecast;
    if (!forecast?.warmup?.complete) { exclusions.warmup++; continue; }
    const ensemble = forecast.vectors?.ensemble;
    if (!validVector(ensemble)) { exclusions.invalidReference++; continue; }
    const originStage = segmentFor(index, segments);
    const targetIndex = index + horizon;
    const collectOrigin = stage === "development"
      ? originStage === "tuning" || originStage === "development"
      : originStage === "holdout";
    if (!collectOrigin || targetIndex >= maximumIndex ||
        segmentFor(targetIndex, segments) !== originStage) {
      if (collectOrigin) exclusions.purgedBoundary++;
      continue;
    }
    const vectors = {};
    let valid = true;
    for (const family of families) {
      const start = process.hrtime.bigint();
      const vector = candidates[family].predict();
      const elapsed = Number(process.hrtime.bigint() - start);
      const cost = latency[family];
      cost.totalNs += elapsed; cost.maxNs = Math.max(cost.maxNs, elapsed); cost.forecasts++;
      if (!validVector(vector)) { exclusions.invalidCandidate++; valid = false; }
      vectors[family] = vector;
    }
    if (valid) pending.set(forecast.targetSeq, {
      madeAtSeq: forecast.madeAtSeq, targetSeq: forecast.targetSeq, stage: originStage,
      ensemble, vectors, modules: forecast.vectors.modules, weights: forecast.weights,
    });
  }
  return { params, accumulators, moduleAccumulators, latency, exclusions };
}

function incrementDiagnostics(ticks) {
  const increments = [];
  for (let i = 1; i < ticks.length; i++) {
    if (ticks[i].gapBefore) continue;
    increments.push((ticks[i].digit - ticks[i - 1].digit + 10) % 10);
  }
  const counts = Array(10).fill(0);
  increments.forEach((increment) => counts[increment]++);
  const probabilities = normalizeProbabilities(counts.map((count) => count + 0.5));
  let cosine = 0, sine = 0;
  for (let i = 0; i < 10; i++) {
    cosine += probabilities[i] * Math.cos(2 * Math.PI * i / 10);
    sine += probabilities[i] * Math.sin(2 * Math.PI * i / 10);
  }
  const resultant = Math.sqrt(cosine * cosine + sine * sine);
  const subdivisions = [];
  for (let part = 0; part < 4; part++) {
    const start = Math.floor(increments.length * part / 4), end = Math.floor(increments.length * (part + 1) / 4);
    const local = Array(10).fill(0);
    for (let i = start; i < end; i++) local[increments[i]]++;
    const n = end - start;
    subdivisions.push({
      n,
      probabilities: local.map((count) => (count + 0.5) / (n + 5)),
      totalVariationFromFull: local.reduce((sum, count, d) =>
        sum + Math.abs((count + 0.5) / (n + 5) - probabilities[d]), 0) / 2,
    });
  }
  let dependentPairs = 0;
  for (let i = 1; i < increments.length; i++) if (increments[i] === increments[i - 1]) dependentPairs++;
  return {
    n: increments.length,
    counts,
    probabilities,
    circularStandardDeviationRadians: resultant > 0 ? Math.sqrt(-2 * Math.log(resultant)) : null,
    lag1SameIncrementRate: increments.length > 1 ? dependentPairs / (increments.length - 1) : null,
    subdivisions,
  };
}

function tunePower(accumulators, sampleSize, options) {
  const uniform = accumulators.uniform.delta, ensemble = accumulators.ensemble.delta;
  if (sampleSize < 2 || uniform.length < 2 || ensemble.length !== uniform.length) return null;
  const testA = neweyWestTest(uniform, options.neweyWestLag);
  const testB = neweyWestTest(ensemble, options.neweyWestLag);
  const covariance = longRunCovariance(uniform, ensemble, options.neweyWestLag);
  return {
    varianceUniform: testA.longRunVariance,
    varianceEnsemble: testB.longRunVariance,
    covariance,
    estimateAtPlanningEffect: promotionPower({
      varianceA: testA.longRunVariance, varianceB: testB.longRunVariance, covariance,
      sampleSize, planningEffect: PLANNING_EFFECT, familySize: REGISTERED_COMPARISONS,
      simulations: options.powerSimulations,
    }),
    estimateAtPracticalThreshold: promotionPower({
      varianceA: testA.longRunVariance, varianceB: testB.longRunVariance, covariance,
      sampleSize, planningEffect: PLANNING_EFFECT, effectToDetect: PRACTICAL_THRESHOLD,
      familySize: REGISTERED_COMPARISONS, simulations: options.powerSimulations, seed: 72,
    }),
  };
}

function comparisonEligible(result, minimumCount = MIN_DEVELOPMENT_FORECASTS) {
  return result.n >= minimumCount && result.deltaLogLoss >= PRACTICAL_THRESHOLD &&
    result.adjustedPValueHolm <= 0.05 && result.simultaneousCI?.[0] > 0 &&
    result.dataQualityPass !== false &&
    result.calibration.brierDegradation <= MAX_BRIER_DEGRADATION &&
    result.calibration.candidate.expectedCalibrationError <= result.calibration.reference.expectedCalibrationError + MAX_ECE_DEGRADATION &&
    result.stability.passes;
}

function passesDataQuality(quality) {
  return quality.malformed === 0 && quality.precisionMismatch === 0 &&
    quality.duplicates === 0 && quality.outOfOrder === 0;
}

function qualityForRange(rows, symbol, firstTick, lastTick, fallback) {
  if (!firstTick || !lastTick) return fallback;
  const firstEpoch = Number(firstTick.epoch), lastEpoch = Number(lastTick.epoch);
  return validateDatasetRows(rows.filter((row) =>
    Number(row.epoch) >= firstEpoch && Number(row.epoch) <= lastEpoch), symbol).quality;
}

function registeredResultSlots() {
  const slots = [];
  for (const symbol of EVALUATION_SYMBOLS) for (const horizon of FORECAST_HORIZONS) {
    for (const family of CANDIDATE_FAMILIES) for (const reference of PRIMARY_REFERENCES) {
      slots.push({ family, symbol, horizon, reference });
    }
  }
  return slots;
}

export function evaluateDevelopment(datasets, options = {}) {
  const config = { ...DEFAULT_EVALUATION_OPTIONS, ...options };
  const results = [], cellData = {};
  for (const symbol of EVALUATION_SYMBOLS) {
    const sourceRows = datasets[symbol];
    if (!Array.isArray(sourceRows) || !sourceRows.length) continue;
    const validated = validateDatasetRows(sourceRows, symbol);
    const ticks = validated.rows;
    const split = splitChronologically(ticks.length, config);
    const devQuality = qualityForRange(
      sourceRows, symbol,
      ticks[split.segments.development[0]],
      ticks[split.segments.development[1] - 1],
      { received: 0, malformed: 0, precisionMismatch: 0, duplicates: 0, outOfOrder: 0, gaps: 0, missingIntervals: 0, accepted: 0 },
    );
    const qualityPass = passesDataQuality(devQuality);
    const daysBeforeHoldout = dateCoverage(ticks.slice(0, split.segments.holdout[0])).length;
    for (const horizon of FORECAST_HORIZONS) {
      const cell = collectCellData(ticks, symbol, horizon, split.segments, {
        stage: "development", minimumTicks: config.minimumTicks,
      });
      const fitPower = {};
      for (const family of CANDIDATE_FAMILIES) {
        const developmentCount = cell.accumulators.development[family].ensemble.n;
        fitPower[family] = tunePower(cell.accumulators.tuning[family], developmentCount, config);
        for (const reference of PRIMARY_REFERENCES) {
          results.push(finalizeComparison(cell.accumulators.development[family][reference], family, symbol, horizon, reference, {
            inference: true, familySize: REGISTERED_COMPARISONS, options: config,
          }));
        }
      }
      cellData[`${symbol}:${horizon}`] = {
        symbol, horizon, sampleCounts: {
          tuning: split.segments.tuning[1] - split.segments.tuning[0],
          developmentOrigins: Object.fromEntries(CANDIDATE_FAMILIES.map((family) => [
            family, cell.accumulators.development[family].ensemble.n,
          ])),
          holdoutOrigins: split.segments.holdout[1] - split.segments.holdout[0] - horizon,
        },
        segments: split.segments,
        calendarDaysBeforeHoldout: daysBeforeHoldout,
        dataQualityPass: qualityPass,
        dataQualityDevelopmentOnly: devQuality,
        tuningParameters: cell.params,
        incrementDiagnosticsTuningOnly: incrementDiagnostics(ticks.slice(split.segments.tuning[0], split.segments.tuning[1])),
        existingModuleEvaluationDevelopment: moduleEvaluationSummary(cell.moduleAccumulators.development),
        developmentPowerByFamily: fitPower,
        latencyNs: Object.fromEntries(Object.entries(cell.latency).map(([family, cost]) => [family, {
          mean: cost.forecasts ? cost.totalNs / cost.forecasts : null,
          max: cost.maxNs,
          n: cost.forecasts,
        }])),
        exclusions: cell.exclusions,
        tuningForPower: Object.fromEntries(CANDIDATE_FAMILIES.map((family) => [family, {
          uniform: cell.accumulators.tuning[family].uniform.delta,
          ensemble: cell.accumulators.tuning[family].ensemble.delta,
        }])),
      };
    }
  }

  const existingKeys = new Set(results.map((result) => `${result.symbol}:${result.horizon}:${result.family}:${result.reference}`));
  for (const slot of registeredResultSlots()) {
    const key = `${slot.symbol}:${slot.horizon}:${slot.family}:${slot.reference}`;
    if (!existingKeys.has(key)) results.push({
      ...slot, n: 0, deltaLogLoss: null, pValue: 1, rawPValue: 1,
      adjustedPValueHolm: null, ordinaryCI: null, simultaneousCI: null,
      status: "symbol data unavailable",
    });
  }
  const pValues = results.map((result) => result.rawPValue ?? 1);
  const adjusted = holmAdjust(pValues);
  results.forEach((result, index) => { result.adjustedPValueHolm = adjusted[index]; });
  for (const result of results) {
    const cell = cellData[`${result.symbol}:${result.horizon}`];
    if (cell) result.dataQualityPass = cell.dataQualityPass;
  }
  const byCell = new Map();
  for (const result of results) {
    const key = `${result.symbol}:${result.horizon}:${result.family}`;
    const cell = byCell.get(key) || {};
    cell[result.reference] = result;
    byCell.set(key, cell);
  }
  const eligible = [];
  for (const [key, comparison] of byCell) {
    const data = cellData[key.split(":").slice(0, 2).join(":")];
    const family = key.split(":")[2];
    const power = data?.developmentPowerByFamily?.[family]?.estimateAtPlanningEffect?.power;
    if (data?.calendarDaysBeforeHoldout < 7 || !data?.dataQualityPass || power === undefined || power < 0.7) continue;
    if (comparisonEligible(comparison.uniform) && comparisonEligible(comparison.ensemble)) {
      eligible.push({
        id: key, family, symbol: data.symbol, horizon: data.horizon,
        rankingValue: Math.min(comparison.uniform.simultaneousCI[0], comparison.ensemble.simultaneousCI[0]),
        deltaMinimum: Math.min(comparison.uniform.deltaLogLoss, comparison.ensemble.deltaLogLoss),
        power,
      });
    }
  }
  eligible.sort((a, b) => b.rankingValue - a.rankingValue || b.deltaMinimum - a.deltaMinimum || a.id.localeCompare(b.id));
  const selected = eligible.slice(0, 3);
  const selectedIds = new Set(selected.map((item) => item.id));
  const classifications = [];
  for (const { family, symbol, horizon } of registeredResultSlots().filter((slot) => slot.reference === "uniform")) {
    const id = `${symbol}:${horizon}:${family}`;
    const comparison = byCell.get(id) || {};
    const data = cellData[`${symbol}:${horizon}`];
    const count = comparison.uniform?.n || 0;
    const power = data?.developmentPowerByFamily?.[family]?.estimateAtPlanningEffect?.power ?? null;
    let classification, reason;
    if (!data || count < MIN_DEVELOPMENT_FORECASTS || data.calendarDaysBeforeHoldout < 7 || power === null || power < 0.7) {
      classification = "inconclusive or underpowered";
      reason = !data ? "symbol data unavailable" : "sample, calendar coverage, or power gate not met";
    } else if (!data.dataQualityPass || !comparison.uniform?.stability?.passes || !comparison.ensemble?.stability?.passes) {
      classification = "fails data-quality or stability requirements";
      reason = "registered data-quality or day-stability gate failed";
    } else {
      const supportedBoth = [comparison.uniform, comparison.ensemble].every((item) =>
        item?.adjustedPValueHolm <= 0.05 && item?.simultaneousCI?.[0] > 0);
      const practicalBoth = [comparison.uniform, comparison.ensemble].every((item) =>
        item?.deltaLogLoss >= PRACTICAL_THRESHOLD);
      const calibratedBoth = [comparison.uniform, comparison.ensemble].every((item) =>
        item?.calibration?.brierDegradation <= MAX_BRIER_DEGRADATION &&
        item?.calibration?.candidate?.expectedCalibrationError <= item?.calibration?.reference?.expectedCalibrationError + MAX_ECE_DEGRADATION);
      if (!calibratedBoth) {
        classification = "fails data-quality or stability requirements";
        reason = "registered calibration non-degradation gate failed";
      } else if (!supportedBoth) {
        classification = "no supported improvement";
        reason = "adjusted statistical criteria were not met";
      } else if (!practicalBoth) {
        classification = "statistically supported but below practical threshold";
        reason = "at least one reference comparison is below the registered DeltaLL threshold";
      } else if (selectedIds.has(id)) {
        classification = "eligible for locked holdout";
        reason = "passed development criteria; not yet holdout-validated";
      } else {
        classification = "development-eligible but not selected for holdout";
        reason = "ranked outside the maximum of three holdout cells";
      }
    }
    classifications.push({ id, family, symbol, horizon, n: count, powerAtPlanningEffect: power, classification, reason });
  }
  const holdoutProjections = selected.map((candidate) => {
    const data = cellData[`${candidate.symbol}:${candidate.horizon}`];
    const powerData = data?.developmentPowerByFamily?.[candidate.family];
    const tuning = data?.tuningForPower?.[candidate.family];
    const sampleSize = data?.sampleCounts?.holdoutOrigins || 0;
    if (!powerData || !tuning || sampleSize < 2) return { ...candidate, power: null };
    const projected = promotionPower({
      varianceA: powerData.varianceUniform, varianceB: powerData.varianceEnsemble,
      covariance: powerData.covariance, sampleSize, planningEffect: PLANNING_EFFECT,
      familySize: selected.length * 2, simulations: config.powerSimulations, seed: 91,
    });
    return { ...candidate, holdoutPower: projected.power, projectedSampleSize: sampleSize };
  });
  const holdoutMayOpen = selected.length > 0 && holdoutProjections.length === selected.length &&
    holdoutProjections.every((item) => item.holdoutPower >= 0.7) &&
    selected.every((item) => (cellData[`${item.symbol}:${item.horizon}`]?.calendarDaysBeforeHoldout || 0) >= 7);
  return {
    manifestVersion: "2.2.0",
    stage: "development-evaluation",
    holdoutAccessed: false,
    registeredHypotheses: REGISTERED_COMPARISONS,
    registeredCells: REGISTERED_COMPARISONS / 2,
    data: Object.fromEntries(Object.entries(cellData).map(([key, value]) => {
      const { tuningForPower, ...publicValue } = value;
      return [key, publicValue];
    })),
    results,
    selection: { eligible, selected, classifications, holdoutProjections, holdoutMayOpen },
  };
}

export function evaluateSelectedHoldout(datasets, developmentReport, options = {}) {
  if (!developmentReport?.selection?.holdoutMayOpen) {
    throw new Error("holdout is locked: no selected cell passed the registered development and holdout power gates");
  }
  const config = { ...DEFAULT_EVALUATION_OPTIONS, ...options };
  const selected = developmentReport.selection.selected;
  const results = [];
  for (const cell of selected) {
    const sourceRows = datasets[cell.symbol];
    if (!Array.isArray(sourceRows) || !sourceRows.length) throw new Error(`holdout data unavailable for ${cell.symbol}`);
    const validated = validateDatasetRows(sourceRows, cell.symbol);
    const ticks = validated.rows;
    const split = splitChronologically(ticks.length, config);
    const holdout = collectCellData(ticks, cell.symbol, cell.horizon, split.segments, {
      stage: "holdout", families: [cell.family], minimumTicks: config.minimumTicks,
    });
    for (const reference of PRIMARY_REFERENCES) {
      const result = finalizeComparison(holdout.accumulators.holdout[cell.family][reference], cell.family, cell.symbol, cell.horizon, reference, {
        inference: true, familySize: selected.length * 2, options: config,
      });
      const holdoutQuality = qualityForRange(
        sourceRows, cell.symbol,
        ticks[split.segments.holdout[0]],
        ticks[split.segments.holdout[1] - 1],
        validated.quality,
      );
      result.dataQuality = holdoutQuality;
      result.dataQualityPass = passesDataQuality(holdoutQuality);
      results.push(result);
    }
  }
  const adjusted = holmAdjust(results.map((result) => result.rawPValue ?? 1));
  results.forEach((result, index) => { result.adjustedPValueHolm = adjusted[index]; });
  return {
    manifestVersion: "2.2.0",
    stage: "locked-final-holdout",
    registeredHypotheses: selected.length * 2,
    results,
    classifications: selected.map((cell) => {
      const comparisons = results.filter((result) => result.symbol === cell.symbol && result.horizon === cell.horizon && result.family === cell.family);
      const pass = comparisons.length === 2 && comparisons.every((result) => comparisonEligible(result, 1));
      return { ...cell, classification: pass ? "passes practical and statistical gates" : "fails holdout promotion criteria" };
    }),
  };
}
