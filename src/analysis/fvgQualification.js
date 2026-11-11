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
