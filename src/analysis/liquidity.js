import { DEFAULTS, atrSeries, dayId, weekId } from './core.js';
import { detectPivots } from './pivots.js';

// Previous-day / previous-week high & low as reference levels. Active for the whole following period.
export function referenceLevels(candles, periods = ['day', 'week']) {
  const out = [];
  const idOf = { day: dayId, week: weekId };
  const startOf = { day: (id) => id * 86400, week: (id) => (id * 7 - 3) * 86400 };
  const tag = { day: 'D', week: 'W' };
  if (candles.length < 2) return out;
  const gaps = candles.slice(1).map((c, i) => c.epoch - candles[i].epoch).sort((a, b) => a - b);
  const interval = gaps[Math.floor(gaps.length / 2)] || 60;
  for (const per of periods) {
    const f = idOf[per];
    const buckets = [];
    for (let i = 0; i < candles.length; i++) {
      const id = f(candles[i].epoch);
      const b = buckets[buckets.length - 1];
      if (b && b.id === id) { b.high = Math.max(b.high, candles[i].high); b.low = Math.min(b.low, candles[i].low); b.end = i; }
      else buckets.push({ id, start: i, end: i, high: candles[i].high, low: candles[i].low });
    }
    for (let k = 1; k < buckets.length; k++) {
      const prev = buckets[k - 1], cur = buckets[k];
      // the previous period is only meaningful if it directly precedes the current one in time
      const partial = k === 1 && candles[prev.start].epoch - startOf[per](prev.id) > interval;
      for (const [side, name, level] of [['buy', 'PREVIOUS_HIGH', prev.high], ['sell', 'PREVIOUS_LOW', prev.low]]) {
        out.push({
          source: `P${tag[per]}${side === 'buy' ? 'H' : 'L'}`, side, level, period: per, name,
          startIndex: cur.start, periodId: cur.id, partial,
        });
      }
    }
  }
  return out;
}

// Sequential liquidity engine. Pools are clustered equal highs/lows (ATR tolerance) plus reference levels.
// Lifecycle: identified (pool) -> sweep candidate (wick through, close back inside)
//            -> sweep confirmed (stays inside for confirmBars more closes) -> reaction (matures later).
export function analyzeLiquidity(candles, opts = {}) {
  const atr = opts.atr || atrSeries(candles, opts.atrPeriod ?? DEFAULTS.atrPeriod);
  const tolMult = opts.eqTolAtr ?? DEFAULTS.eqTolAtr;
  const confirmBars = opts.sweepConfirmBars ?? DEFAULTS.sweepConfirmBars;
  const maxAge = opts.poolMaxAge ?? DEFAULTS.poolMaxAge;
  const reactionBars = opts.reactionBars ?? DEFAULTS.reactionBars;
  const pivots = (opts.pivots || detectPivots(candles, opts.pivotWindow ?? DEFAULTS.internalPivot)).confirmed;
  const refs = opts.referenceLevels || referenceLevels(candles);

  const byConfirm = new Map();
  for (const p of pivots) { if (!byConfirm.has(p.confirmedIndex)) byConfirm.set(p.confirmedIndex, []); byConfirm.get(p.confirmedIndex).push(p); }
  const refAt = new Map();
  for (const r of refs) { if (!refAt.has(r.startIndex)) refAt.set(r.startIndex, []); refAt.get(r.startIndex).push(r); }

  const periodOf = { day: dayId, week: weekId };
  const pools = [];
  const events = [];
  const poolSnapshots = opts.captureSnapshots ? [] : null;
  const identityDiagnostics = opts.captureSnapshots ? [] : null;
  const diagnostics = [];
  const deferredPivots = [];
  let nextId = 1;

  const addEvent = (e) => {
    if (identityDiagnostics && e.kind === 'sweep-confirmed') {
      const candidate = candles[e.index], confirmation = candles[e.confirmedIndex];
      const valid = e.confirmedIndex === e.index + 1 && (e.side === 'buy'
        ? candidate.high > e.level && candidate.close < e.level && confirmation.close < e.level
        : candidate.low < e.level && candidate.close > e.level && confirmation.close > e.level);
      if (valid) {
        const extreme = e.side === 'buy' ? candidate.high : candidate.low;
        const groupId = JSON.stringify([e.side, e.index, e.confirmedIndex, extreme]);
        Object.defineProperties(e, {
          extreme: { value: extreme, enumerable: true },
          groupId: { value: groupId, enumerable: true },
          id: { value: JSON.stringify(['pool-sweep', e.poolId, groupId]), enumerable: true },
          eligible: { value: e.side === 'buy' ? confirmation.high <= extreme : confirmation.low >= extreme, enumerable: true },
        });
      } else {
        identityDiagnostics.push(Object.freeze({ code: 'unverified-sweep-confirmation', poolId: e.poolId,
          index: e.index, confirmedIndex: e.confirmedIndex }));
      }
    }
    events.push(e); return e;
  };

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];

    for (const pool of pools) {
      if (pool.status !== 'active') continue;
      const expired = pool.period ? periodOf[pool.period](c.epoch) !== pool.periodId : i - pool.formedIndex > maxAge;
      if (expired && !pool.pending) { pool.status = 'expired'; continue; }
      const above = pool.side === 'buy';
      const through = above ? c.high > pool.level : c.low < pool.level;
      const inside = above ? c.close < pool.level : c.close > pool.level;
      const outside = above ? c.close > pool.level : c.close < pool.level;

      if (pool.pending) {
        if (outside) {
          pool.pending.stage = 'failed';
          addEvent({ kind: 'sweep-failed', poolId: pool.id, side: pool.side, level: pool.level, index: pool.pending.index, confirmedIndex: i });
          pool.status = 'invalidated'; pool.pending = null; continue;
        }
        if (!inside) {
          pool.pending = null;
          continue;
        }
        if (i - pool.pending.index >= confirmBars) {
          const ev = addEvent({
            kind: 'sweep-confirmed', poolId: pool.id, source: pool.source, side: pool.side, level: pool.level,
            index: pool.pending.index, epoch: candles[pool.pending.index].epoch, confirmedIndex: i, confirmedEpoch: c.epoch,
            excess: pool.pending.excess, equal: pool.pending.equal, touches: pool.pending.touches, majorLiquidity: pool.pending.majorLiquidity, reaction: null,
          });
          pool.status = 'swept'; pool.sweptIndex = i; pool.pending = null; ev.reactionDue = i + reactionBars;
        }
        continue;
      }
      if (through && inside) {
        const excess = above ? c.high - pool.level : pool.level - c.low;
        pool.pending = { index: i, excess, equal: pool.equal, touches: pool.touches, majorLiquidity: pool.source !== 'pivot' || pool.equal || pool.touches > 1 };
        addEvent({ kind: 'sweep-candidate', poolId: pool.id, source: pool.source, side: pool.side, level: pool.level, index: i, epoch: c.epoch, confirmedIndex: i, excess, equal: pool.equal, touches: pool.touches, majorLiquidity: pool.source !== 'pivot' || pool.equal || pool.touches > 1 });
        if (confirmBars === 0) {
          pool.pending = { index: i, excess, equal: pool.equal, touches: pool.touches, majorLiquidity: pool.source !== 'pivot' || pool.equal || pool.touches > 1 };
          const ev = addEvent({ kind: 'sweep-confirmed', poolId: pool.id, source: pool.source, side: pool.side, level: pool.level, index: i, epoch: c.epoch, confirmedIndex: i, confirmedEpoch: c.epoch, excess, equal: pool.equal, touches: pool.touches, majorLiquidity: pool.source !== 'pivot' || pool.equal || pool.touches > 1, reaction: null });
          pool.status = 'swept'; pool.sweptIndex = i; pool.pending = null; ev.reactionDue = i + reactionBars;
        }
      } else if (through && outside) {
        pool.status = 'invalidated'; pool.brokenIndex = i;
      }
    }
    const confirmedNow = [...(byConfirm.get(i) || [])].sort((a, b) =>
      a.confirmedIndex - b.confirmedIndex || a.index - b.index ||
      (a.type === b.type ? 0 : a.type === 'high' ? -1 : 1));
    if (!Number.isFinite(atr[i])) {
      for (const pivot of confirmedNow) {
        deferredPivots.push(pivot);
        diagnostics.push(Object.freeze({ code: 'pivot-pool-assignment-awaiting-atr',
          index: pivot.index, confirmedIndex: pivot.confirmedIndex, type: pivot.type }));
      }
    }
    const deferred = Number.isFinite(atr[i]) ? deferredPivots.splice(0).sort((a, b) =>
      a.confirmedIndex - b.confirmedIndex || a.index - b.index ||
      (a.type === b.type ? 0 : a.type === 'high' ? -1 : 1)) : [];
    const eligibleDeferred = deferred.filter((pivot) => {
      const crossed = candles.slice(pivot.confirmedIndex + 1, i + 1).some((bar) =>
        pivot.type === 'high' ? bar.high > pivot.price : bar.low < pivot.price);
      if (crossed) diagnostics.push(Object.freeze({ code: 'deferred-pivot-traded-through',
        index: pivot.index, confirmedIndex: pivot.confirmedIndex, type: pivot.type, processedIndex: i }));
      return !crossed;
    });
    const assignable = Number.isFinite(atr[i]) ? [...eligibleDeferred, ...confirmedNow] : [];
    for (const p of assignable) {
      const side = p.type === 'high' ? 'buy' : 'sell';
      const tol = atr[i] * tolMult;
      let pool = pools.filter(q => q.source === 'pivot' && q.side === side && q.status === 'active' && !q.pending
        && Math.abs(q.level - p.price) <= tol)
        .sort((a, b) => Math.abs(a.level - p.price) - Math.abs(b.level - p.price) || a.id - b.id)[0];
      if (pool) {
        pool.touches++; pool.pivotIndices.push(p.index); pool.lastTouchIndex = p.index;
        pool.level = side === 'buy' ? Math.max(pool.level, p.price) : Math.min(pool.level, p.price);
        pool.equal = true; pool.updatedIndex = i;
      } else {
        pool = {
          id: nextId++, source: 'pivot', side, level: p.price, touches: 1, equal: false,
          pivotIndices: [p.index], lastTouchIndex: p.index, formedIndex: i, formedEpoch: c.epoch,
          updatedIndex: i, status: 'active', pending: null, period: null, periodId: null,
        };
        pools.push(pool);
      }
    }
    for (const r of refAt.get(i) || []) {
      pools.push({
        id: nextId++, source: r.source, side: r.side, level: r.level, touches: 1, equal: false,
        pivotIndices: [], lastTouchIndex: null, formedIndex: i, formedEpoch: c.epoch, updatedIndex: i,
        status: 'active', pending: null, period: r.period, periodId: r.periodId, partial: r.partial,
      });
    }
    if (poolSnapshots) {
      const snapshotPools = pools.map((pool) => Object.freeze({
        ...pool,
        pivotIndices: Object.freeze([...pool.pivotIndices]),
        pending: pool.pending ? Object.freeze({ ...pool.pending }) : null,
      }));
      poolSnapshots.push(Object.freeze({ index: i, epoch: c.epoch, pools: Object.freeze(snapshotPools) }));
    }
  }

  // Reactions: favourable excursion (in ATR) over `reactionBars` after confirmation; null until matured.
  for (const ev of events) {
    if (ev.kind !== 'sweep-confirmed') continue;
    const end = ev.confirmedIndex + reactionBars;
    if (end <= candles.length - 1 && atr[ev.confirmedIndex]) {
      const base = candles[ev.confirmedIndex].close;
      let best = 0;
      for (let k = ev.confirmedIndex + 1; k <= end; k++) {
        best = Math.max(best, ev.side === 'buy' ? base - candles[k].low : candles[k].high - base);
      }
      ev.reaction = { bars: reactionBars, matureIndex: end, atrMove: best / atr[ev.confirmedIndex] };
    }
  }
  return { pools, events, referenceLevels: refs, diagnostics: Object.freeze(diagnostics),
    ...(poolSnapshots ? { poolSnapshots: Object.freeze(poolSnapshots), identityDiagnostics: Object.freeze(identityDiagnostics) } : {}) };
}
