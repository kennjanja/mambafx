// Formation quality is separate from the existence of a three-candle gap.
// Percentages are ratios in [0, 1], not percentage points.
export function assessFvgFormation(first, third, direction) {
  const firstRange = first.high - first.low;
  const thirdRange = third.high - third.low;
  const firstBody = Math.abs(first.close - first.open);
  const thirdBody = Math.abs(third.close - third.open);
  const largerBody = Math.max(firstBody, thirdBody);
  const gap = direction === 1 ? third.low - first.high : first.low - third.high;
  if ((direction !== 1 && direction !== -1) || !(gap > 0) || !(firstRange > 0) || !(thirdRange > 0)) return null;

  const firstWick = direction === 1 ? first.high - Math.max(first.open, first.close) : Math.min(first.open, first.close) - first.low;
  const thirdWick = direction === 1 ? Math.min(third.open, third.close) - third.low : third.high - Math.max(third.open, third.close);
  const bodyDifference = largerBody > 0 ? Math.abs(firstBody - thirdBody) / largerBody : null;
  const firstWickRange = firstWick / firstRange;
  const thirdWickRange = thirdWick / thirdRange;
  const gapThirdRange = gap / thirdRange;
  return {
    gapThirdRange, firstWickRange, thirdWickRange, bodyDifference,
    firstWickBody: firstBody > 0 ? firstWick / firstBody : null,
    thirdWickBody: thirdBody > 0 ? thirdWick / thirdBody : null,
    qualified: gapThirdRange >= 0.5 && firstWickRange <= 0.35 && thirdWickRange <= 0.35 &&
      bodyDifference != null && bodyDifference <= 0.2,
  };
}

export function fvgCorrection(candles, confirmedIndex, direction, bottom, top, asOfIndex = candles.length - 1) {
  const end = Math.min(candles.length - 1, asOfIndex, confirmedIndex + 3);
  for (let i = confirmedIndex + 1; i <= end; i++) {
    const candle = candles[i];
    if (candle.low <= top && candle.high >= bottom) {
      return { index: i, depth: Math.max(0, Math.min(1, direction === 1 ?
        (top - candle.low) / (top - bottom) : (candle.high - bottom) / (top - bottom))) };
    }
  }
  return null;
}

export function fvgContext(direction, formationIndex, pivots, structureEvents, liquidityEvents) {
  const oppositeType = direction === 1 ? 'low' : 'high';
  const pivot = pivots.filter((p) => p.type === oppositeType && p.confirmedIndex <= formationIndex &&
    p.index <= formationIndex).sort((a, b) => b.index - a.index)[0];
  if (!pivot) return { tier: 'unknown', sweep: null, bos: null, legStart: null };
  const start = Math.max(pivot.index, formationIndex - 10);
  const inLeg = (event) => event.index >= start && event.index <= formationIndex &&
    (event.confirmedIndex ?? event.index) <= formationIndex;
  const sweep = liquidityEvents.some((event) => event.kind === 'sweep-confirmed' &&
    (event.side === 'sell' ? 1 : -1) === direction && inLeg(event));
  const bos = structureEvents.some((event) => event.type === 'BOS' && event.dir === direction && inLeg(event));
  return { tier: sweep && bos ? 'premium' : sweep || bos ? 'good' : 'basic', sweep, bos, legStart: start };
}

export function fvgSwingPosition(direction, formationIndex, midpoint, pivots, asOfIndex) {
  const startType = direction === 1 ? 'low' : 'high';
  const endType = direction === 1 ? 'high' : 'low';
  const available = pivots.filter((pivot) => pivot.confirmedIndex <= asOfIndex);
  const start = available.filter((pivot) => pivot.type === startType &&
    pivot.index < formationIndex && pivot.confirmedIndex <= formationIndex)
    .sort((a, b) => b.index - a.index)[0];
  if (!start) return null;
  const end = available.filter((pivot) => pivot.type === endType &&
    pivot.index > start.index && pivot.index >= formationIndex - 1)
    .sort((a, b) => a.index - b.index)[0];
  if (!end) return null;
  const low = direction === 1 ? start.price : end.price;
  const high = direction === 1 ? end.price : start.price;
  if (!(high > low) || midpoint < low || midpoint > high) return null;
  const position = (midpoint - low) / (high - low);
  return {
    low, high, position,
    zone: position < 0.5 ? 'discount' : position > 0.5 ? 'premium' : 'equilibrium',
    preferred: direction === 1 ? position <= 0.5 : position >= 0.5,
    confirmedIndex: Math.max(start.confirmedIndex, end.confirmedIndex),
  };
}

// Observations are reconstructed at the requested candle close; later fills,
// inversions and swing confirmations must not leak into historical scans.
export function eligibleFvgs(zones, corrections, positions, asOfIndex) {
  const result = [];
  for (const zone of zones) {
    if (zone.kind !== 'FVG' || !zone.fvgQuality?.qualified || zone.confirmedIndex > asOfIndex) continue;
    const correction = corrections.find((item) => item.zoneId === zone.id && item.confirmedIndex <= asOfIndex);
    if (!correction) continue;
    const inversion = zone.history.find((item) => item.status === 'inverted' && item.index <= asOfIndex);
    const invalidation = zone.history.find((item) => ['invalidated', 'expired'].includes(item.status) && item.index <= asOfIndex);
    if (invalidation && (!inversion || invalidation.index < inversion.index)) continue;
    const position = positions.find((item) => item.zoneId === zone.id && item.confirmedIndex <= asOfIndex) || null;
    const base = { zoneId: zone.id, bottom: zone.bottom, top: zone.top, mid: zone.mid,
      sizeAtr: zone.sizeAtr, createdIndex: zone.createdIndex, confirmedIndex: zone.confirmedIndex,
      correctionIndex: correction.confirmedIndex, quality: zone.fvgQuality, correction, position };
    if (!inversion) {
      result.push({ ...base, dir: zone.dir, kind: 'FVG' });
      continue;
    }
    const inverse = zones.find((item) => item.kind === 'IFVG' && item.parentId === zone.id);
    if (!inverse || inverse.firstMitigationIndex == null || inverse.firstMitigationIndex !== asOfIndex) continue;
    if (inverse.history.some((item) => ['invalidated', 'expired'].includes(item.status) && item.index <= asOfIndex)) continue;
    result.push({ ...base, dir: inverse.dir, kind: 'IFVG', inverseZoneId: inverse.id, inversionIndex: inversion.index,
      retestIndex: inverse.firstMitigationIndex });
  }
  return result;
}

export function compareFvgs(a, b) {
  const tier = { premium: 3, good: 2, basic: 1, unknown: 0 };
  return b.sizeAtr - a.sizeAtr ||
    Number(!!b.position?.preferred) - Number(!!a.position?.preferred) ||
    (tier[b.quality.tier] || 0) - (tier[a.quality.tier] || 0) ||
    Number(a.correction.deep) - Number(b.correction.deep) ||
    b.confirmedIndex - a.confirmedIndex || a.zoneId - b.zoneId;
}

export function fvgQuoteError(fvg, quote, nowSec) {
  if (!fvg || !Number.isFinite(fvg.bottom) || !Number.isFinite(fvg.top) || fvg.bottom >= fvg.top)
    return 'FVG boundaries are unavailable; trade blocked.';
  if (!quote || !Number.isFinite(quote.price) || !Number.isFinite(quote.epoch) ||
      nowSec - quote.epoch > 15 || quote.epoch > nowSec + 5)
    return 'No current market quote is available; FVG trade blocked.';
  if (!Number.isFinite(fvg.scanUntil) || nowSec >= fvg.scanUntil)
    return 'FVG analysis is stale; a new closed-candle scan is required.';
  if (fvg.kind === 'IFVG' && (!Number.isFinite(fvg.retestUntil) || nowSec >= fvg.retestUntil))
    return 'The first inverse FVG retest window has ended; trade blocked.';
  if (quote.price < fvg.bottom || quote.price > fvg.top)
    return 'Price has left the FVG; trade blocked.';
  return null;
}
