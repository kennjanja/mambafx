// Follows each Trade Signal until its predicted time lapses, then marks it correct or wrong.
// Pure functions (no DOM / network) so the scoring rules can be tested.
//
// Rules (all fixed when the signal opens, never tuned afterwards):
//  - horizon: the signal's profile hold time (default 1800 s) from the moment the signal was first seen

//  - only prices after the signal opened count: scan price samples plus 5 min candles that start after it opened
//  - END-OF-WINDOW RULE (like a Rise/Fall contract): only the price at the END of the predicted period decides. A BUY is correct
//    if the last price is above the entry, wrong if it is at or below it; a SELL mirrors it. Dips beyond the entry during the window
//    do not lose the signal. Exactly at the entry is not "above" (a tie loses).
//  - the target and invalidation levels are shown for information (`targetHit`) and do not decide the result
//  - a record resolves only at the lapse (no early exit); interim state is shown as progress

export const HORIZON_SEC = 1800;
export const ENTRY_GRANULARITY = 300;

export function openTracked(sig, nowSec) {
  if (!sig || sig.status !== 'signal' || !(sig.dir === 1 || sig.dir === -1) || !(sig.price > 0)) return null;
  const hold = sig.holdSec > 0 ? sig.holdSec : HORIZON_SEC;
  return {
    id: sig.symbol + '|' + (sig.profile || 'intraday') + '@' + nowSec,
    profile: sig.profile || 'intraday', profileName: sig.profileName || 'Intraday', holdLabel: sig.holdLabel || '30 min', entryG: sig.entryG || ENTRY_GRANULARITY, trigger: sig.trigger ? sig.trigger.label : null, exitOn: sig.exitOn || null,
    symbol: sig.symbol, label: sig.label, dir: sig.dir, action: sig.action,
    headline: sig.headline,
    entry: sig.price,
    target: sig.target && sig.target.price != null ? sig.target.price : null,
    invalidation: sig.invalidation && sig.invalidation.price != null ? sig.invalidation.price : null,
    openedAt: nowSec, expiresAt: nowSec + hold,
    hit: null, hitAt: null, targetHit: false, rule: 'end', last: sig.price, state: 'open',
  };
}

function touch(rec, hi, lo) {
  const up = rec.dir === 1;
  if (rec.target != null && (up ? hi >= rec.target : lo <= rec.target)) rec.targetHit = true;
}

/** Advance a record with new market data. candles: ascending 5 min candles; price: latest sample. Returns the record (mutated). */
export function updateTracked(rec, { candles = [], price = null, nowSec, reversal = null }) {
  if (rec.state !== 'open') return rec;
  const end = Math.min(nowSec, rec.expiresAt);
  // a bar is usable only if it starts after the signal opened (the bar containing the open also holds pre-signal prices)
  const g = rec.entryG || ENTRY_GRANULARITY;
  const firstBar = (Math.floor(rec.openedAt / g) + 1) * g;
  let lastClose = null;
  const bars = candles.filter((c) => c.epoch >= firstBar && c.epoch < rec.expiresAt).sort((a, b) => a.epoch - b.epoch);
  for (const c of bars) {
    touch(rec, c.high, c.low);
    lastClose = c.close;
  }
  if (price != null && nowSec <= rec.expiresAt) {
    touch(rec, price, price);
    lastClose = price;
  }
  if (lastClose != null) rec.last = lastClose;
  if (nowSec >= rec.expiresAt) {
    rec.state = (rec.last - rec.entry) * rec.dir > 0 ? 'correct' : 'wrong';
    rec.hit = 'none';
    rec.resolvedAt = end;
  }
  return rec;
}

/** 0..1 elapsed fraction of the predicted window */
export function progress(rec, nowSec) {
  return Math.max(0, Math.min(1, (nowSec - rec.openedAt) / (rec.expiresAt - rec.openedAt)));
}

export function summarize(records) {
  const done = records.filter((r) => r.state === 'correct' || r.state === 'wrong');
  const correct = done.filter((r) => r.state === 'correct').length;
  return { open: records.length - done.length, resolved: done.length, correct, wrong: done.length - correct,
    hitRate: done.length ? correct / done.length : null };
}
