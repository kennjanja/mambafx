// Follows each Trade Signal until its predicted time lapses, then marks it correct or wrong.
// Pure functions (no DOM / network) so the scoring rules can be tested.
//
// Rules (all fixed when the signal opens, never tuned afterwards):
//  - horizon: the signal's profile hold time (default 1800 s) from the moment the signal was first seen
//  - early exit: opposing entry-timeframe evidence (e.g. an upthrust for a BUY) formed after the signal opened closes it early,
//    scored by the direction of the last price (unless the target/invalidation was already touched)
//  - only prices after the signal opened count: scan price samples plus 5 min candles that start after it opened
//  - first touch decides: target reached first -> correct; invalidation reached first -> wrong;
//    a single bar touching both is scored wrong (order inside a bar is unknown)
//  - nothing touched by the lapse: correct if the last price moved in the signal direction from the entry price
//  - a record resolves only at the lapse, interim state is shown as progress

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
    hit: null, hitAt: null, last: sig.price, state: 'open',
  };
}

function touch(rec, hi, lo) {
  const up = rec.dir === 1;
  const tgt = rec.target != null && (up ? hi >= rec.target : lo <= rec.target);
  const inv = rec.invalidation != null && (up ? lo <= rec.invalidation : hi >= rec.invalidation);
  if (inv) return 'wrong';       // includes the both-touched-in-one-bar case
  if (tgt) return 'correct';
  return null;
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
    if (!rec.hit) { const h = touch(rec, c.high, c.low); if (h) { rec.hit = h; rec.hitAt = c.epoch; } }
    lastClose = c.close;
  }
  if (price != null && nowSec <= rec.expiresAt) {
    if (!rec.hit) { const h = touch(rec, price, price); if (h) { rec.hit = h; rec.hitAt = nowSec; } }
    lastClose = price;
  }
  if (lastClose != null) rec.last = lastClose;
  const exited = !rec.hit && reversal && reversal.epoch > rec.openedAt && nowSec < rec.expiresAt;
  if (exited) { rec.exitReason = reversal.label; rec.hit = 'exit'; }
  if (nowSec >= rec.expiresAt || exited) {
    rec.state = rec.hit === 'correct' || rec.hit === 'wrong' ? rec.hit : (rec.last - rec.entry) * rec.dir > 0 ? 'correct' : 'wrong';
    if (!rec.hit) rec.hit = 'none';
    rec.resolvedAt = exited ? nowSec : end;
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
