import { analyzeStructure } from './structure.js';
import { detectPivots } from './pivots.js';
import { detectDisplacement } from './displacement.js';
import { atrSeries, DEFAULTS } from './core.js';

// Bars counted from confirmedIndex/sweepIndex inclusively: age/window <= limit qualifies; limit+1 invalidates.
export const INDUCEMENT_MINOR_PIVOT_ORDER = 2;
export const INDUCEMENT_MAX_PIVOT_AGE_BARS = 20;
export const INDUCEMENT_MAX_SWEEP_TO_DISPLACEMENT_BARS = 3;
export const INDUCEMENT_MAJOR_PIVOT_ORDER = DEFAULTS.swingPivot;
export const INDUCEMENT_EQUAL_MAJOR_ATR_TOLERANCE = 0.1;
export const INDUCEMENT_LIQUIDITY_FAMILY_VALUE = 0.25;

/**
 * Classifies a sweep at the sweep candle's close only. Inputs are the closed candle, level/direction,
 * and causal structural evidence already confirmed by that close. The protected level always wins:
 * taking it is significant structural liquidity, never minor inducement. This does not predict the
 * sweep's later continuation; only a separate detector confirmation can qualify Model F.
 */
export function classifySweep(candle, { level, direction, protectedLevel = null, minorPivotConfirmed = false, majorLiquidity = false } = {}) {
  if (!candle || !Number.isFinite(level) || ![1, -1].includes(direction)) return { classification: 'none', reason: 'invalid input' };
  const swept = direction === 1 ? candle.low < level && candle.close >= level : candle.high > level && candle.close <= level;
  const broke = direction === 1 ? candle.close < level : candle.close > level;
  const protectedTaken = Number.isFinite(protectedLevel) && (direction === 1 ? candle.low < protectedLevel : candle.high > protectedLevel);
  if (protectedTaken) return { classification: 'significant-liquidity', reason: 'protected structural level taken', swept, broke, protectedTaken };
  if (broke) return { classification: 'none', reason: 'close-through is a break, not a sweep', swept: false, broke: true, protectedTaken: false };
  if (!swept) return { classification: 'none', reason: 'wick did not sweep and reclaim the level', swept: false, broke: false, protectedTaken: false };
  if (majorLiquidity) return { classification: 'significant-liquidity', reason: 'major/equal liquidity swept and reclaimed', swept: true, broke: false, protectedTaken: false };
  if (!minorPivotConfirmed) return { classification: 'none', reason: 'minor pivot confirmation unavailable', swept: true, broke: false, protectedTaken: false };
  return { classification: 'minor-inducement-liquidity', reason: 'minor pivot wicked and reclaimed at this candle close', swept: true, broke: false, protectedTaken: false };
}

const closeAt = (candles, index, granularity) => Number.isInteger(index) && candles[index] ? candles[index].epoch + granularity : null;

/** Causal inducement detector over closed entry-timeframe candles. */
export function detectInducements(candles = [], { granularity = 60, structure = null, atr = null, minorPivotOrder = INDUCEMENT_MINOR_PIVOT_ORDER,
  maxPivotAgeBars = INDUCEMENT_MAX_PIVOT_AGE_BARS, maxSweepToDisplacementBars = INDUCEMENT_MAX_SWEEP_TO_DISPLACEMENT_BARS,
  majorPivotOrder = INDUCEMENT_MAJOR_PIVOT_ORDER, equalMajorAtrTolerance = INDUCEMENT_EQUAL_MAJOR_ATR_TOLERANCE, minorPivots = null, majorPivots = null } = {}) {
  const trueAtr = atr || atrSeries(candles, DEFAULTS.atrPeriod);
  const analysis = structure || analyzeStructure(candles, { atr: trueAtr });
  const minor = minorPivots || detectPivots(candles, minorPivotOrder).confirmed;
  const major = majorPivots || analysis.swing?.pivots?.confirmed || detectPivots(candles, majorPivotOrder).confirmed;
  const displacements = analysis.displacement || detectDisplacement(candles, trueAtr);
  const bosEvents = (analysis.internal?.events || []).filter((event) => event.type === 'BOS' && event.status !== 'provisional');
  const opposingChoCh = (analysis.internal?.events || []).filter((event) => event.type === 'CHoCH' && event.status !== 'provisional');
  const output = [];
  const seen = new Set();
  for (const bos of bosEvents) {
    const dir = bos.dir, pivotType = dir === 1 ? 'low' : 'high';
    const impulse = displacements.filter((event) => event.dir === dir && event.index <= bos.index && event.index >= bos.index - 2)
      .sort((a, b) => b.index - a.index)[0];
    if (!impulse) continue;
    const protectedPivot = major.filter((pivot) => pivot.type === pivotType && pivot.confirmedIndex <= impulse.startIndex && pivot.index <= impulse.startIndex)
      .sort((a, b) => b.index - a.index)[0];
    if (!protectedPivot) continue;
    const pullbackPivots = minor.filter((pivot) => pivot.type === pivotType && pivot.index > bos.index && pivot.confirmedIndex > bos.index);
    for (const pivot of pullbackPivots) {
      const id = `${bos.index}:${pivot.index}:${dir}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const majorPivot = major.some((candidate) => candidate.type === pivotType && candidate.index === pivot.index && candidate.confirmedIndex <= pivot.confirmedIndex);
      if (majorPivot) continue;
      const majorEqual = major.some((candidate) => candidate.type === pivotType && candidate.index !== pivot.index && candidate.confirmedIndex <= pivot.confirmedIndex
        && Math.abs(candidate.price - pivot.price) <= (trueAtr[pivot.confirmedIndex] || 0) * equalMajorAtrTolerance);
      if (majorEqual) continue;
      if (opposingChoCh.some((candidate) => candidate.dir === -dir && candidate.confirmedIndex > bos.confirmedIndex && candidate.confirmedIndex <= pivot.confirmedIndex)) continue;
      const event = {
        id, direction: dir, level: pivot.price, protectedLevel: protectedPivot.price,
        bos: { index: bos.index, confirmedIndex: bos.confirmedIndex, level: bos.level, pivotIndex: bos.pivotIndex, confirmedAt: closeAt(candles, bos.confirmedIndex, granularity) },
        impulse: { index: impulse.index, startIndex: impulse.startIndex, confirmedIndex: impulse.confirmedIndex ?? impulse.index, confirmedAt: closeAt(candles, impulse.confirmedIndex ?? impulse.index, granularity) },
        minorPivot: { index: pivot.index, confirmedIndex: pivot.confirmedIndex, confirmedAt: closeAt(candles, pivot.confirmedIndex, granularity), price: pivot.price },
        sweepIndex: null, sweepConfirmedAt: null, displacementIndex: null, displacementConfirmedAt: null,
        protectedPivot: { index: protectedPivot.index, confirmedIndex: protectedPivot.confirmedIndex, price: protectedPivot.price },
        state: 'formed', stateHistory: [{ state: 'formed', index: pivot.confirmedIndex, confirmedAt: closeAt(candles, pivot.confirmedIndex, granularity) }],
        invalidationReason: null, invalidatedAt: null,
        limits: { minorPivotOrder, maxPivotAgeBars, maxSweepToDisplacementBars },
      };
      let sweptAt = null;
      for (let i = pivot.confirmedIndex + 1; i < candles.length; i++) {
        const candle = candles[i];
        const age = i - pivot.confirmedIndex;
        const choch = opposingChoCh.find((candidate) => candidate.dir === -dir && candidate.confirmedIndex === i && candidate.confirmedIndex > bos.confirmedIndex);
        const protectedTaken = dir === 1 ? candle.low < protectedPivot.price : candle.high > protectedPivot.price;
        if (protectedTaken) { invalidate(event, candles, i, granularity, 'protected structural level taken'); break; }
        if (choch) { invalidate(event, candles, i, granularity, 'confirmed opposing CHoCH'); break; }
        if (event.state === 'formed' && age > maxPivotAgeBars) { invalidate(event, candles, i, granularity, 'maximum pivot age exceeded'); break; }
        if (event.state === 'formed') {
          const closeThrough = dir === 1 ? candle.close < pivot.price : candle.close > pivot.price;
          if (closeThrough) { invalidate(event, candles, i, granularity, 'minor pivot close-through before sweep'); break; }
          const classification = classifySweep(candle, { level: pivot.price, direction: dir, protectedLevel: protectedPivot.price, minorPivotConfirmed: true });
          if (classification.classification === 'significant-liquidity') { invalidate(event, candles, i, granularity, 'protected structural liquidity taken'); break; }
          if (classification.classification === 'minor-inducement-liquidity') {
            event.state = 'swept'; event.sweepIndex = i; event.sweepConfirmedAt = closeAt(candles, i, granularity); sweptAt = i;
            event.sharedSweepClassification = classification;
            event.stateHistory.push({ state: 'swept', index: i, confirmedAt: event.sweepConfirmedAt });
          }
        } else if (event.state === 'swept') {
          const barsSinceSweep = i - sweptAt;
          if (barsSinceSweep > maxSweepToDisplacementBars) { invalidate(event, candles, i, granularity, 'maximum sweep-to-displacement bars exceeded'); break; }
          const displacement = displacements.find((candidate) => candidate.dir === dir && candidate.startIndex > sweptAt && candidate.index === i && (candidate.confirmedIndex ?? candidate.index) === i);
          if (displacement) {
            event.state = 'confirmed'; event.displacementIndex = displacement.index; event.displacementStartIndex = displacement.startIndex;
            event.displacementConfirmedAt = closeAt(candles, displacement.confirmedIndex ?? displacement.index, granularity);
            event.confirmedAt = event.displacementConfirmedAt;
            event.stateHistory.push({ state: 'confirmed', index: i, confirmedAt: event.confirmedAt });
            break;
          }
        }
      }
      output.push(event);
    }
  }
  return output;
}

function invalidate(event, candles, index, granularity, reason) {
  event.state = 'invalid'; event.invalidationReason = reason; event.invalidatedAt = closeAt(candles, index, granularity);
  event.stateHistory.push({ state: 'invalid', index, confirmedAt: event.invalidatedAt });
}
