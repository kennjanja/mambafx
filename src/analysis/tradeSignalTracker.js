// Trade Signal outcome tracking. Outcomes are decided only at the predicted period end.
// Targets are informational; no stop, target, or opposing reversal ends a record early.

export const HORIZON_SEC = 1800;
export const RESOLUTION_GRANULARITY = 60;
export const ENTRY_GRANULARITY = 300;

export function openTracked(sig, nowSec) {
  if (!sig || sig.status !== 'signal' || !(sig.dir === 1 || sig.dir === -1) || !(sig.price > 0)) return null;
  const hold = sig.holdSec > 0 ? sig.holdSec : HORIZON_SEC;
  return {
    id: sig.symbol + '|' + (sig.profile || 'intraday') + '@' + nowSec,
    profile: sig.profile || 'intraday', profileName: sig.profileName || 'Intraday', holdLabel: sig.holdLabel || '30 min', entryG: sig.entryG || ENTRY_GRANULARITY,
    trigger: sig.trigger ? sig.trigger.label : null, exitOn: sig.exitOn || null,
    model_id: sig.model_id ?? sig.primaryModel?.model_id ?? null, model_context: sig.model_context ?? sig.primaryModel?.context ?? null,
    primaryModel: sig.primaryModel || null, secondaryModels: sig.secondaryModels || [], qualifyingModelIds: sig.qualifyingModelIds || [], inducementEvents: sig.inducementEvents || [],
    entryEvidence: sig.entry || null, evidenceSnapshot: sig.evidenceSnapshot || [], familyValues: sig.familyValues || null, overallBalance: sig.overallBalance ?? null,
    lifecycleState: sig.lifecycleState || null, lifecycleHistory: sig.lifecycleHistory || [],
    symbol: sig.symbol, label: sig.label, dir: sig.dir, action: sig.action, headline: sig.headline,
    entry: sig.price, confirmedAt: sig.confirmedAt ?? null, detectedAt: sig.detectedAt ?? nowSec, entryAt: nowSec,
    target: sig.target && sig.target.price != null ? sig.target.price : null,
    invalidation: sig.invalidation && sig.invalidation.price != null ? sig.invalidation.price : null,
    openedAt: nowSec, expiresAt: nowSec + hold,
    hit: null, hitAt: null, targetHit: false, rule: 'end', last: sig.price, state: 'open',
    resolution_method: 'post-entry-1m-close', gaps: [], duplicateCandles: [],
  };
}

export function deduplicateOpenRecords(records = []) {
  const output = [], active = new Set();
  for (const record of records) {
    if (!record || record.state !== 'open') { if (record) output.push(record); continue; }
    const key = `${record.symbol}|${record.profile || 'intraday'}`;
    if (active.has(key)) continue;
    active.add(key); output.push(record);
  }
  return output;
}

function validCandle(c) {
  return c && Number.isFinite(c.epoch) && Number.isFinite(c.open) && Number.isFinite(c.high) && Number.isFinite(c.low) && Number.isFinite(c.close)
    && c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close) && c.high >= c.low;
}

function collectCandles(rec, candles, nowSec) {
  const first = Math.floor(rec.openedAt / RESOLUTION_GRANULARITY) * RESOLUTION_GRANULARITY + RESOLUTION_GRANULARITY;
  const byEpoch = new Map(), duplicates = new Set();
  for (const c of candles) {
    if (!validCandle(c) || c.epoch < first || c.epoch + RESOLUTION_GRANULARITY > rec.expiresAt || c.epoch + RESOLUTION_GRANULARITY > nowSec) continue;
    if (byEpoch.has(c.epoch)) { duplicates.add(c.epoch); byEpoch.delete(c.epoch); }
    else if (!duplicates.has(c.epoch)) byEpoch.set(c.epoch, c);
  }
  const bars = [...byEpoch.values()].sort((a, b) => a.epoch - b.epoch);
  const expected = [];
  for (let t = first; t + RESOLUTION_GRANULARITY <= rec.expiresAt; t += RESOLUTION_GRANULARITY) expected.push(t);
  const gaps = expected.filter((t) => !byEpoch.has(t));
  rec.duplicateCandles = [...duplicates].sort((a, b) => a - b);
  rec.gaps = gaps;
  for (const c of bars) {
    const up = rec.dir === 1;
    if (rec.target != null && (up ? c.high >= rec.target : c.low <= rec.target)) rec.targetHit = true;
  }
  return { bars, expected, byEpoch, duplicates };
}

/**
 * Advance a record using ascending post-entry 1-minute candles and/or timestamped ticks.
 * `price` is accepted only when its `nowSec` is exactly the expiry timestamp.
 * Missing/ambiguous expiry data leaves the record open; no stale close is substituted.
 */
export function updateTracked(rec, { candles = [], ticks = [], price = null, nowSec }) {
  if (rec.state !== 'open') return rec;
  const { bars, expected, byEpoch, duplicates } = collectCandles(rec, candles, Math.min(nowSec, rec.expiresAt));
  if (bars.length) rec.last = bars[bars.length - 1].close;
  if (Array.isArray(ticks)) {
    const usable = ticks.filter((t) => t && Number.isFinite(t.epoch) && Number.isFinite(t.quote) && t.epoch > rec.openedAt && t.epoch <= rec.expiresAt).sort((a, b) => a.epoch - b.epoch);
    for (const tick of usable) {
      const up = rec.dir === 1;
      if (rec.target != null && (up ? tick.quote >= rec.target : tick.quote <= rec.target)) rec.targetHit = true;
    }
  }
  if (nowSec < rec.expiresAt) return rec;

  const exactTick = Array.isArray(ticks) ? ticks.filter((t) => t && Number.isFinite(t.epoch) && Number.isFinite(t.quote) && t.epoch > rec.openedAt && t.epoch <= rec.expiresAt && rec.expiresAt - t.epoch <= 30).sort((a, b) => b.epoch - a.epoch)[0] : null;
  const exactPrice = price != null && nowSec === rec.expiresAt && Number.isFinite(price) ? { epoch: rec.expiresAt, quote: price } : null;
  const finalCandleEpoch = rec.expiresAt - RESOLUTION_GRANULARITY;
  const finalCandle = byEpoch.get(finalCandleEpoch);
  const ambiguousFinal = duplicates.has(finalCandleEpoch);
  let close = null;
  if (exactTick || exactPrice) {
    const sample = exactTick || exactPrice;
    close = sample.quote;
    rec.resolution_method = exactTick ? 'expiry-tick' : 'expiry-price-sample';
    rec.exitAt = sample.epoch;
  } else if (finalCandle && !ambiguousFinal && finalCandleEpoch + RESOLUTION_GRANULARITY === rec.expiresAt) {
    close = finalCandle.close;
    rec.resolution_method = 'post-entry-1m-close';
    rec.exitAt = rec.expiresAt;
  }
  if (close == null) {
    rec.resolutionPending = true;
    rec.resolutionIssue = ambiguousFinal ? 'ambiguous-expiry-candle' : expected.length && rec.gaps.includes(finalCandleEpoch) ? 'missing-expiry-candle' : 'no-expiry-price';
    return rec;
  }
  rec.last = close;
  rec.state = (close - rec.entry) * rec.dir > 0 ? 'correct' : 'wrong';
  rec.hit = 'none';
  rec.resolvedAt = rec.expiresAt;
  rec.resolutionPending = false;
  rec.resolutionIssue = null;
  return rec;
}

export function progress(rec, nowSec) {
  return Math.max(0, Math.min(1, (nowSec - rec.openedAt) / (rec.expiresAt - rec.openedAt)));
}

export function summarize(records) {
  const done = records.filter((r) => r.state === 'correct' || r.state === 'wrong');
  const correct = done.filter((r) => r.state === 'correct').length;
  return { open: records.length - done.length, resolved: done.length, correct, wrong: done.length - correct,
    hitRate: done.length ? correct / done.length : null };
}
