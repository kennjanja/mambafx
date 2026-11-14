// INCOMPLETE: do not use as a validation reference until STOP 1A is completed.
// Independent Batch 1 audit primitives. No production analysis modules are imported.
// Frozen definitions v1.0 SHA-256:
// 43bf546b876f5872d8985fce22ec13e9d95b89008806aaefd8439e168e251c8d

export const DEFINITION_VERSION = '1.0';
export const DEFINITION_SHA256 = '43bf546b876f5872d8985fce22ec13e9d95b89008806aaefd8439e168e251c8d';

export function closedCandles(candles, granularity, decisionTime) {
  if (!Number.isFinite(decisionTime) || !Number.isFinite(granularity) || granularity <= 0) {
    throw new TypeError('finite decision time and positive granularity required');
  }
  return candles.filter((c) => Number.isFinite(c.epoch) && c.epoch + granularity <= decisionTime);
}

export function pivots(candles, order) {
  const result = [];
  for (let i = order; i + order < candles.length; i++) {
    for (const [type, field] of [['high', 'high'], ['low', 'low']]) {
      const price = candles[i][field];
      let valid = true;
      for (let k = 1; k <= order; k++) {
        if (type === 'high'
          ? price <= candles[i - k][field] || price < candles[i + k][field]
          : price >= candles[i - k][field] || price > candles[i + k][field]) {
          valid = false;
          break;
        }
      }
      if (valid) result.push({ id: `${type}:${i}:${order}`, type, index: i, confirmedIndex: i + order, price });
    }
  }
  return result;
}

export function dealingRange(candles, order) {
  const points = pivots(candles, order);
  const high = points.filter((p) => p.type === 'high').at(-1);
  const low = points.filter((p) => p.type === 'low').at(-1);
  if (!high || !low || high.index === low.index || high.price <= low.price) return null;
  const midpoint = (high.price + low.price) / 2;
  const price = candles.at(-1).close;
  return {
    high, low, midpoint, price,
    confirmedIndex: Math.max(high.confirmedIndex, low.confirmedIndex),
    location: price < low.price || price > high.price ? 'out-of-range'
      : price === midpoint ? 'equilibrium' : price < midpoint ? 'discount' : 'premium',
    longEligible: price >= low.price && price < midpoint,
    shortEligible: price > midpoint && price <= high.price,
  };
}

export function zoneInteraction(previous, candle, zone) {
  const intersects = candle.high >= zone.bottom && candle.low <= zone.top;
  const invalidated = zone.dir === 1 ? candle.close < zone.bottom : candle.close > zone.top;
  const approach = previous.close > zone.top ? 'above' : previous.close < zone.bottom ? 'below' : 'inside';
  const correctApproach = zone.dir === 1 ? approach === 'above' : approach === 'below';
  return {
    intersects, invalidated, approach,
    retest: intersects && !invalidated && correctApproach,
    edge: zone.dir === 1 ? zone.top : zone.bottom,
  };
}

export function previousPeriod(candles, granularity, decisionTime, period) {
  if (!['day', 'week'].includes(period)) throw new TypeError('unsupported UTC period');
  const closed = closedCandles(candles, granularity, decisionTime);
  const duration = period === 'day' ? 86400 : 604800;
  const offset = period === 'day' ? 0 : 259200;
  if (duration % granularity !== 0) throw new RangeError('granularity must divide period');
  const currentStart = Math.floor((decisionTime + offset) / duration) * duration - offset;
  const previousStart = currentStart - duration;
  const expected = duration / granularity;
  const bucket = closed.filter((c) => c.epoch >= previousStart && c.epoch < currentStart);
  const timestamps = new Set(bucket.map((c) => c.epoch));
  const complete = bucket.length === expected && timestamps.size === expected &&
    Array.from({ length: expected }, (_, i) => previousStart + i * granularity).every((epoch) => timestamps.has(epoch));
  if (!complete) return { period, previousStart, currentStart, complete: false, high: null, low: null };
  return { period, previousStart, currentStart, complete: true,
    high: Math.max(...bucket.map((c) => c.high)), low: Math.min(...bucket.map((c) => c.low)) };
}

const priority = ['A', 'B', 'C', 'D', 'F', 'G', 'I', 'J'];
export function rankCandidates(candidates) {
  return [...candidates].sort((a, b) => b.matchedCount - a.matchedCount ||
    priority.indexOf(a.model) - priority.indexOf(b.model) || a.scenarioId.localeCompare(b.scenarioId));
}

export function assignModelASweeps(candles, sweeps, displacements) {
  const retired = new Set();
  const bindings = [];
  for (const d of [...displacements].sort((a, b) => a.endIndex - b.endIndex || a.id.localeCompare(b.id))) {
    const side = d.dir === 1 ? 'sell' : 'buy';
    const eligible = sweeps.filter((s) => !retired.has(s.id) && s.side === side && s.significant &&
      s.candidateIndex <= d.startIndex && s.confirmedIndex <= d.endIndex &&
      d.endIndex - s.confirmedIndex + 1 <= 30 &&
      !candles.slice(s.candidateIndex, d.endIndex + 1).some((c) =>
        side === 'buy' ? c.high > s.extreme : c.low < s.extreme));
    eligible.sort((a, b) => b.confirmedIndex - a.confirmedIndex ||
      (side === 'buy' ? b.extreme - a.extreme : a.extreme - b.extreme) ||
      a.poolId.localeCompare(b.poolId));
    if (!eligible.length) continue;
    for (const s of eligible) retired.add(s.id);
    bindings.push({ displacementId: d.id, sweepId: eligible[0].id, poolId: eligible[0].poolId, extreme: eligible[0].extreme });
  }
  return bindings;
}
