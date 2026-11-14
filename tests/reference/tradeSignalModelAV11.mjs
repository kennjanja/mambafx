export const FROZEN_SPEC_SHA256 = Object.freeze({
  v1: 'f4b226cfe8b970b77085d5fcc3288ebb693797f0c9c2c6a975c1cce6a8de5a86',
  v1_1: '58a441faf5495714d2e22b4136a8eb9431a5be16e63c3bfd54f2dbdac2fb4ab7',
  v1_2: '27c53e2dcfb75d68697dccac8d486f2168867d73ffca53c7b4536eb9cad9798f',
});

function diagnostic(code, details = {}) {
  return { code, ...details };
}

function isDeeplyFrozen(value, seen = new Set()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return true;
  seen.add(value);
  if (!Object.isFrozen(value)) return false;
  return Object.values(value).every((child) => isDeeplyFrozen(child, seen));
}

function validCandle(candle) {
  return candle
    && Number.isFinite(candle.epoch)
    && Number.isFinite(candle.open)
    && Number.isFinite(candle.high)
    && Number.isFinite(candle.low)
    && Number.isFinite(candle.close)
    && candle.high >= Math.max(candle.open, candle.close)
    && candle.low <= Math.min(candle.open, candle.close)
    && candle.high >= candle.low;
}

function confirmedPivot(candles, index, kind) {
  const pivot = candles[index];
  if (!pivot || index < 3 || index + 3 >= candles.length) return false;
  for (let offset = 1; offset <= 3; offset += 1) {
    const left = candles[index - offset];
    const right = candles[index + offset];
    if (kind === 'low') {
      if (!(pivot.low < left.low && pivot.low <= right.low)) return false;
    } else if (!(pivot.high > left.high && pivot.high >= right.high)) {
      return false;
    }
  }
  return true;
}

function failClosed(diagnostics, extra = {}) {
  return {
    springUpthrustConfirmed: false,
    poolAttributed: false,
    poolId: null,
    qualifyingConstituents: [],
    attributionCandidates: [],
    poolSweepEvidence: false,
    poolSweepId: null,
    diagnostics,
    ...extra,
  };
}

/**
 * Independent v1.1 spring/upthrust attribution oracle.
 *
 * IDs and pool state are inputs, not inferred from OHLC. The caller supplies a
 * deeply frozen pool snapshot and separately confirmed sweep records.
 */
export function attributeSpringUpthrustV11({
  candles,
  timeframeSeconds,
  asOfIndex,
  event,
  poolSnapshot,
  confirmedSweeps,
} = {}) {
  const diagnostics = [];
  if (!Array.isArray(candles)) {
    return failClosed([diagnostic('candles-missing')]);
  }
  if (!Number.isInteger(asOfIndex) || asOfIndex < 0 || asOfIndex >= candles.length) {
    return failClosed([diagnostic('as-of-index-invalid')]);
  }
  if (!Number.isFinite(timeframeSeconds) || timeframeSeconds <= 0) {
    return failClosed([diagnostic('timeframe-invalid')]);
  }

  const available = candles.slice(0, asOfIndex + 1);
  for (let index = 0; index < available.length; index += 1) {
    if (!validCandle(available[index])) {
      return failClosed([diagnostic('invalid-candle', { index })]);
    }
    if (index > 0 && available[index].epoch - available[index - 1].epoch !== timeframeSeconds) {
      return failClosed([diagnostic('non-contiguous-candles', { index })]);
    }
  }

  if (!event || !['spring', 'upthrust'].includes(event.type)
      || typeof event.id !== 'string' || event.id.length === 0
      || !Number.isInteger(event.eventIndex)
      || !Number.isInteger(event.confirmationIndex)
      || !Number.isInteger(event.windowStartIndex)) {
    return failClosed([diagnostic('event-identity-missing-or-invalid')]);
  }

  const index = event.eventIndex;
  const windowStart = index - 20;
  if (event.windowStartIndex !== windowStart) {
    return failClosed([diagnostic('event-window-identity-mismatch')]);
  }
  if (windowStart < 0 || index + 1 > asOfIndex) {
    return failClosed([diagnostic('event-not-available-as-of', { eventIndex: index })]);
  }
  if (event.confirmationIndex !== index + 1) {
    return failClosed([diagnostic('confirmation-not-immediate-next-close')]);
  }

  const isSpring = event.type === 'spring';
  const boundaryKind = isSpring ? 'low' : 'high';
  const boundary = isSpring
    ? Math.min(...available.slice(windowStart, index).map((candle) => candle.low))
    : Math.max(...available.slice(windowStart, index).map((candle) => candle.high));
  const eventCandle = available[index];
  const confirmCandle = available[index + 1];
  const candidate = isSpring
    ? eventCandle.low < boundary && eventCandle.close > boundary
    : eventCandle.high > boundary && eventCandle.close < boundary;
  if (!candidate) {
    return failClosed([diagnostic('strict-pattern-candidate-failed', { boundary })]);
  }
  const confirmed = isSpring
    ? confirmCandle.close > boundary
    : confirmCandle.close < boundary;
  if (!confirmed) {
    return failClosed([diagnostic('strict-next-close-confirmation-failed', { boundary })]);
  }

  const ties = [];
  for (let pivotIndex = windowStart; pivotIndex < index; pivotIndex += 1) {
    const price = boundaryKind === 'low'
      ? available[pivotIndex].low
      : available[pivotIndex].high;
    if (price === boundary) ties.push(pivotIndex);
  }
  const boundaryCandidates = ties
    .filter((pivotIndex) => (
      pivotIndex + 3 <= index - 1
      && confirmedPivot(available, pivotIndex, boundaryKind)
    ))
    .map((pivotIndex) => ({
      index: pivotIndex,
      kind: boundaryKind,
      price: boundary,
      confirmationIndex: pivotIndex + 3,
    }));

  const poolCandidates = [];
  if (poolSnapshot === undefined || poolSnapshot === null) {
    diagnostics.push(diagnostic('pool-snapshot-missing'));
  } else if (!isDeeplyFrozen(poolSnapshot)) {
    diagnostics.push(diagnostic('pool-snapshot-not-immutable'));
  } else if (poolSnapshot.asOfIndex !== index - 1 || !Array.isArray(poolSnapshot.pools)) {
    diagnostics.push(diagnostic('pool-snapshot-as-of-or-shape-invalid'));
  } else {
    const expectedPoolSide = isSpring ? 'sell' : 'buy';
    for (const pool of poolSnapshot.pools) {
      if (!pool || typeof pool.id !== 'string' || pool.id.length === 0
          || pool.status !== 'active' || pool.pending !== null
          || pool.side !== expectedPoolSide || pool.level !== boundary
          || !Array.isArray(pool.constituentPivots)) continue;
      const pivotIds = [];
      for (const { index: pivotIndex } of boundaryCandidates) {
        const constituent = pool.constituentPivots.find((pivot) => (
          pivot
          && typeof pivot.id === 'string'
          && pivot.id.length > 0
          && pivot.index === pivotIndex
          && pivot.kind === boundaryKind
          && pivot.price === boundary
          && pivot.confirmationIndex === pivotIndex + 3
          && pivot.confirmationIndex <= index - 1
        ));
        if (constituent) pivotIds.push(constituent.id);
      }
      if (pivotIds.length) {
        diagnostics.push(diagnostic('pool-attribution-candidate', { poolId: pool.id }));
        // Keep only supplied identities; no pool or pivot identity is synthesized.
        poolCandidates.push({ poolId: pool.id, pivotIds, snapshotStatus: pool.status });
      }
    }
  }

  return finishAttribution({
    diagnostics,
    poolCandidates,
    event,
    isSpring,
    index,
    boundary,
    boundaryCandidates,
    eventCandle,
    confirmedSweeps,
  });
}

function finishAttribution({
  diagnostics,
  poolCandidates,
  event,
  isSpring,
  index,
  boundary,
  boundaryCandidates,
  eventCandle,
  confirmedSweeps,
}) {
  const unambiguous = poolCandidates.length === 1;
  let selected = unambiguous ? poolCandidates[0] : null;
  const attributionCandidates = poolCandidates.map((candidate) => ({
    poolId: candidate.poolId,
    pivotIds: [...candidate.pivotIds],
    snapshotStatus: candidate.snapshotStatus,
  }));
  if (poolCandidates.length > 1) diagnostics.push(diagnostic('pool-attribution-ambiguous'));
  if (poolCandidates.length === 0) diagnostics.push(diagnostic('no-qualifying-pool-constituent'));

  let poolSweepEvidence = false;
  let poolSweepId = null;
  if (confirmedSweeps === undefined || confirmedSweeps === null) {
    diagnostics.push(diagnostic('confirmed-sweep-inputs-missing'));
  } else if (!Array.isArray(confirmedSweeps)) {
    diagnostics.push(diagnostic('confirmed-sweep-inputs-invalid'));
  } else if (!selected) {
    diagnostics.push(diagnostic('pool-sweep-evidence-unavailable-without-unique-pool'));
  } else {
    const side = isSpring ? 'sell' : 'buy';
    const extreme = isSpring ? eventCandle.low : eventCandle.high;
    const sameGroup = confirmedSweeps.filter((sweep) => (
      sweep
      && sweep.side === side
      && sweep.candidateIndex === index
      && sweep.confirmationIndex === index + 1
      && sweep.extreme === extreme
    ));
    const matchingPoolGroup = sameGroup.filter((sweep) => (
      sweep.poolId === selected.poolId
      || sweep.poolId === undefined
      || sweep.poolId === null
      || sweep.poolId === ''
    ));
    const independentlyEligible = matchingPoolGroup.filter((sweep) => (
      sweep.confirmed === true
      && sweep.eligible === true
      && sweep.invalidated !== true
      && sweep.retired !== true
    ));
    const missingIdentity = independentlyEligible.some((sweep) => (
      sweep.poolId !== selected.poolId
      || typeof sweep.id !== 'string'
      || sweep.id.length === 0
    ));
    const eligible = independentlyEligible.find((sweep) => (
      sweep.poolId === selected.poolId
      && typeof sweep.id === 'string'
      && sweep.id.length > 0
    ));
    if (missingIdentity) {
      diagnostics.push(diagnostic('matching-confirmed-sweep-identity-missing'));
      selected = null;
    } else if (eligible) {
      poolSweepEvidence = true;
      poolSweepId = eligible.id;
    } else if (matchingPoolGroup.length) {
      diagnostics.push(diagnostic('matching-pool-sweep-not-confirmed-and-eligible'));
    } else if (sameGroup.length) {
      diagnostics.push(diagnostic('pool-sweep-other-pool'));
    } else {
      diagnostics.push(diagnostic('pool-sweep-not-present'));
    }
  }

  return {
    springUpthrustConfirmed: true,
    eventId: event.id,
    eventType: event.type,
    eventIndex: index,
    confirmationIndex: index + 1,
    boundary,
    boundaryCandidates,
    poolAttributed: Boolean(selected),
    poolId: selected ? selected.poolId : null,
    poolSnapshotState: selected ? { status: selected.snapshotStatus, pending: false } : null,
    qualifyingConstituents: selected
      ? [...selected.pivotIds]
      : [],
    attributionCandidates,
    poolSweepEvidence,
    poolSweepId,
    diagnostics,
  };
}
