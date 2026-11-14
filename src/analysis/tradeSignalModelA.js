import { detectPivots } from './pivots.js';

export function assessModelASpring({ candles, candidateIndex, kind, poolSnapshot, sweeps, asOfIndex }) {
  if (!Array.isArray(candles) || !Number.isInteger(candidateIndex) || !Number.isInteger(asOfIndex)
    || candidateIndex < 20 || asOfIndex >= candles.length || !['spring', 'upthrust'].includes(kind)) {
    throw new TypeError('invalid Model A spring/upthrust assessment input');
  }

  const confirmationIndex = candidateIndex + 1;
  if (asOfIndex < confirmationIndex) return null;
  const isSpring = kind === 'spring';
  const field = isSpring ? 'low' : 'high';
  const side = isSpring ? 'sell' : 'buy';
  const window = candles.slice(candidateIndex - 20, candidateIndex);
  const boundary = isSpring ? Math.min(...window.map((c) => c.low)) : Math.max(...window.map((c) => c.high));
  const candidate = candles[candidateIndex], confirmation = candles[confirmationIndex];
  if (isSpring
    ? !(candidate.low < boundary && candidate.close > boundary && confirmation.close > boundary)
    : !(candidate.high > boundary && candidate.close < boundary && confirmation.close < boundary)) return null;

  const pivots = detectPivots(candles.slice(0, candidateIndex), 3).confirmed;
  const confirmedPivotKeys = new Set(pivots.map((pivot) => `${pivot.type}:${pivot.index}`));
  const eligible = pivots.filter((pivot) => pivot.type === field && pivot.index >= candidateIndex - 20
    && pivot.price === boundary && pivot.confirmedIndex < candidateIndex);
  const diagnostics = [];
  const snapshotAvailable = poolSnapshot && poolSnapshot.index === candidateIndex - 1
    && poolSnapshot.epoch === candles[candidateIndex - 1].epoch && Object.isFrozen(poolSnapshot)
    && Array.isArray(poolSnapshot.pools) && Object.isFrozen(poolSnapshot.pools)
    && poolSnapshot.pools.every((pool) => Object.isFrozen(pool) && Array.isArray(pool.pivotIndices)
      && Object.isFrozen(pool.pivotIndices) && typeof pool.status === 'string'
      && Object.hasOwn(pool, 'pending') && (pool.pending === null || Object.isFrozen(pool.pending))
      && (pool.source !== 'pivot' || (['buy', 'sell'].includes(pool.side)
        && pool.pivotIndices.every((index) =>
          confirmedPivotKeys.has(`${pool.side === 'buy' ? 'high' : 'low'}:${index}`)))));
  if (!snapshotAvailable) diagnostics.push('missing-or-invalid-point-in-time-pool-snapshot');
  if (!Array.isArray(sweeps)) diagnostics.push('missing-sweep-event-records');
  const pools = snapshotAvailable ? poolSnapshot.pools : [];
  const matches = pools.flatMap((pool) => {
    if (pool.source !== 'pivot' || pool.status !== 'active' || pool.pending !== null
      || pool.side !== side || pool.level !== boundary || !Array.isArray(pool.pivotIndices)) return [];
    const constituents = eligible.filter((pivot) => pool.pivotIndices.includes(pivot.index));
    return constituents.length ? [{ pool, constituents }] : [];
  });
  let match = matches.length === 1 && Array.isArray(sweeps) ? matches[0] : null;
  const matchingSweeps = match ? sweeps.filter((event) => event.kind === 'sweep-confirmed' && event.eligible === true
    && event.poolId === match.pool.id && event.side === side && event.index === candidateIndex
    && event.confirmedIndex === confirmationIndex && event.extreme === candidate[field]) : [];
  const expectedGroupId = JSON.stringify([side, candidateIndex, confirmationIndex, candidate[field]]);
  if (matchingSweeps.some((event) => event.groupId !== expectedGroupId
    || event.id !== JSON.stringify(['pool-sweep', event.poolId, event.groupId]))) {
    diagnostics.push('missing-or-invalid-confirmed-sweep-event-id');
    match = null;
  }
  const sweep = match && matchingSweeps[0];

  return {
    kind, index: candidateIndex, confirmedIndex: confirmationIndex, side, level: boundary,
    extreme: candidate[field], sweptLevelId: `${isSpring ? 'SPR' : 'UPT'}|20|${candidateIndex - 20}|${candidateIndex}`,
    poolAttributed: !!match, poolId: match ? match.pool.id : null,
    matchCount: snapshotAvailable ? matches.length : null,
    attributionAmbiguous: snapshotAvailable ? matches.length !== 1 : null,
    poolSnapshotState: match ? { status: match.pool.status, pending: false } : null,
    constituentIndices: match ? match.constituents.map((pivot) => pivot.index) : [],
    attributionCandidates: matches.map(({ pool, constituents }) =>
      ({ poolId: pool.id, snapshotStatus: pool.status, constituentIndices: constituents.map((pivot) => pivot.index) })),
    poolSweepEventId: sweep ? sweep.id : null,
    diagnostics,
  };
}

export function modelASpringEvent({ candles, candidateIndex, kind, liquidity, asOfIndex }) {
  const assessed = assessModelASpring({ candles, candidateIndex, kind,
    poolSnapshot: liquidity?.poolSnapshots?.[candidateIndex - 1], sweeps: liquidity?.events, asOfIndex });
  if (!assessed) return null;
  const groupId = JSON.stringify([assessed.side, candidateIndex, assessed.confirmedIndex, assessed.extreme]);
  const sweepRecords = Array.isArray(liquidity?.events) ? liquidity.events : [];
  const snapshotPools = liquidity?.poolSnapshots?.[candidateIndex - 1]?.pools || [];
  const coSweptPools = sweepRecords.filter((event) => event.kind === 'sweep-confirmed'
    && event.groupId === groupId && event.confirmedIndex <= asOfIndex).map((event) => ({
    poolId: event.poolId, source: event.source, level: event.level, sweepEventId: event.id ?? null,
    eligible: event.eligible === true,
    snapshotStatus: snapshotPools.find((pool) => pool.id === event.poolId)?.status ?? null,
    snapshotPending: snapshotPools.find((pool) => pool.id === event.poolId)?.pending != null,
  }));
  return { ...assessed, eventId: assessed.sweptLevelId, groupId, modelAGroupId: groupId, groupMemberKind: kind,
    groupMemberKinds: [kind], coSweptPools, type: 'significant-sweep', dir: kind === 'spring' ? 1 : -1,
    context: 'range', classification: 'significant-liquidity', label: kind };
}
