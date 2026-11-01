// Beast Mode: a combined signal that exists only when Bazu's live prediction and a Trade Signal setup AGREE on direction.
// Pure and deterministic (no DOM / network) so the rules can be tested.
//
//  combine():  Bazu tradable Rise/Fall  +  Trade Signal 'signal' (entry trigger present) with the same direction  => 'beast'
//              opposite directions => 'conflict' (never recorded); only one side => 'bazu-only' / 'trade-only' / 'watching'
//  Following:  a beast record opens at the price seen, lasts exactly Bazu's predicted window (decisionTs + durationSec),
//              and is scored like the Rise/Fall contract it describes: exit price vs entry price, a tie loses.
//              The Trade Signal target / invalidation are tracked as extra information (first touch), not as the result.
//              If the window lapses without a price sample close to its end (page closed), the record is 'void', never guessed.

export const MIN_REMAINING_SEC = 15;   // do not open a record on a prediction that is about to lapse
export const END_GRACE_SEC = 10;       // a price sample this close to the end of the window counts as the exit price

const dirOf = (d) => (d === 'Rise' ? 1 : d === 'Fall' ? -1 : 0);

/** bazu: { direction, ok, durationSec, strength, decisionTs, price } | null ; tradeSigs: buildTradeSignal results for the market. */
export function combine(bazu, tradeSigs = []) {
  const bd = bazu && bazu.ok ? dirOf(bazu.direction) : 0;
  const live = tradeSigs.filter((s) => s && s.status === 'signal' && (s.dir === 1 || s.dir === -1));
  const watching = tradeSigs.filter((s) => s && s.status === 'watching');
  if (bd) {
    const agree = live.filter((s) => s.dir === bd).sort((a, b) => Math.abs(a.holdSec - bazu.durationSec) - Math.abs(b.holdSec - bazu.durationSec));
    if (agree.length) return { state: 'beast', dir: bd, trade: agree[0], agreeing: agree.length };
    if (live.some((s) => s.dir === -bd)) return { state: 'conflict', dir: bd, trade: live.find((s) => s.dir === -bd) };
    return { state: 'bazu-only', dir: bd, watching: watching.filter((s) => s.dir === bd).length };
  }
  if (live.length) return { state: 'trade-only', dir: live[0].dir, trade: live[0] };
  return { state: watching.length ? 'watching' : 'none', dir: 0 };
}

export function openBeast(sym, label, combo, bazu, price, nowSec) {
  if (!combo || combo.state !== 'beast' || !(price > 0) || !(bazu.durationSec > 0)) return null;
  const start = bazu.decisionTs > 0 ? bazu.decisionTs : nowSec;
  const expiresAt = start + bazu.durationSec;
  if (expiresAt - nowSec < MIN_REMAINING_SEC) return null;
  const t = combo.trade;
  return {
    id: `${sym}@${start}`, key: `${sym}|${start}|${combo.dir}`, symbol: sym, label, dir: combo.dir, side: combo.dir === 1 ? 'Rise' : 'Fall',
    bazuDuration: bazu.duration, bazuStrength: bazu.strength, profile: t.profileName, tradeHeadline: t.headline,
    trigger: t.trigger ? `${t.trigger.kind}: ${t.trigger.label}` : null,
    target: t.target ? t.target.price : null, invalidation: t.invalidation ? t.invalidation.price : null,
    entry: price, openedAt: nowSec, expiresAt, hi: price, lo: price, last: price, lastAt: nowSec, touch: null, state: 'open',
  };
}

/** Advance a record with a price sample. Returns the (mutated) record. */
export function updateBeast(rec, price, nowSec) {
  if (rec.state !== 'open') return rec;
  const p = price > 0 ? price : null;
  if (nowSec < rec.expiresAt) {
    if (p != null) {
      rec.last = p; rec.lastAt = nowSec; rec.hi = Math.max(rec.hi, p); rec.lo = Math.min(rec.lo, p);
      if (!rec.touch) {
        const up = rec.dir === 1;
        const inv = rec.invalidation != null && (up ? p <= rec.invalidation : p >= rec.invalidation);
        const tgt = rec.target != null && (up ? p >= rec.target : p <= rec.target);
        if (inv) rec.touch = 'invalidation'; else if (tgt) rec.touch = 'target';
      }
    }
    return rec;
  }
  if (p != null && nowSec - rec.expiresAt <= END_GRACE_SEC) { rec.last = p; rec.lastAt = nowSec; }
  if (rec.lastAt >= rec.expiresAt - END_GRACE_SEC) {
    const d = (rec.last - rec.entry) * rec.dir;
    rec.state = d > 0 ? 'correct' : 'wrong';   // a tie loses, as in a Rise/Fall contract
    rec.exit = rec.last;
  } else {
    rec.state = 'void';                        // lapsed without a price near the end: not scored
  }
  rec.closedAt = nowSec;
  return rec;
}

export const progress = (rec, nowSec) => Math.max(0, Math.min(1, (nowSec - rec.openedAt) / Math.max(1, rec.expiresAt - rec.openedAt)));

export function summarize(recs) {
  const c = recs.filter((r) => r.state === 'correct').length, w = recs.filter((r) => r.state === 'wrong').length;
  return { open: recs.filter((r) => r.state === 'open').length, correct: c, wrong: w, void: recs.filter((r) => r.state === 'void').length, hitRate: c + w ? c / (c + w) : null, n: c + w };
}
