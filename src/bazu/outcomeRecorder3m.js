/**
 * src/bazu/outcomeRecorder3m.js  (pure, shadow only)
 * Records the features available at prediction time for each breakout / playbook observation and later scores the
 * direction at HORIZONS ticks with the same convention as horizons3m (entry = first tick after the decision).
 * Never reads or changes signal generation, filtering or execution.
 */
import { HORIZONS, outcomeAt, byGroup, accuracy } from './horizons3m.js?v=17';

export const MIN_GAP_TICKS = 60;
export const BUCKET_CAP = 400;
export const MIN_REAL_SIGNALS = 100;

/** Index of the last tick at or before `at` (-1 if none). */
const lastIdxAtOrBefore = (epochs, at) => { let lo = 0, hi = epochs.length; while (lo < hi) { const m = (lo + hi) >> 1; if (epochs[m] <= at) lo = m + 1; else hi = m; } return lo - 1; };

const filterSnapshot = (f) => (f ? Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v ? (v.pass === true ? 'pass' : v.pass === false ? 'fail' : 'n/a') : 'n/a'])) : null);
/** Family votes only (full member detail made rows too large to persist). */
const familyVotes = (f) => (f ? Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v && typeof v === 'object' ? (v.vote ?? null) : v])) : null);
const stateLabel = (e) => (e.state === 'failed' && e.failKind ? `failed-${e.failKind}` : e.state);

/** One row per breakout event present at decision time (all zones), not just the top-priority one. */
export function snapshot(symbol, pred, price) {
  const b = pred?.breakoutState;
  if (!b || !b.direction) return [];
  const list = b.list && b.list.length ? b.list : [b];
  const traded = !pred.wait && pred.playbook === 'breakout';
  return list.filter((e) => e.direction).map((e, i) => ({
    kind: 'breakout-state',
    symbol, at: pred.decisionTs, price, dir: e.direction, state: stateLabel(e), edge: e.edge,
    strength: e.strength, confirmation: e.confirmation, context: e.context || null,
    filters: filterSnapshot(pred.breakoutFilters),
    playbook: pred.playbook || null, signalDir: pred.direction || 0, score: pred.strength ?? null,
    eligible: !!traded && i === 0,
    regime: pred.regime?.type || null,
    families: familyVotes(pred.families),
  }));
}

/** Snapshot of the top playbook candidate, whether or not it survived the gates (eligible = it did). */
export function playbookSnapshot(symbol, pred, price) {
  if (!pred?.playbook || !(pred.direction === 1 || pred.direction === -1)) return null;
  return {
    kind: 'playbook',
    symbol, at: pred.decisionTs, price, dir: pred.direction, state: pred.wait ? 'gated' : 'signal', playbook: pred.playbook,
    filters: filterSnapshot(pred.breakoutFilters),
    score: pred.strength ?? null, eligible: !pred.wait, gate: (pred.vetoes && pred.vetoes[0]) || (pred.reasons && pred.reasons[0]) || null,
    regime: pred.regime?.type || null, families: familyVotes(pred.families),
    familyAgreement: pred.familyAgreement ?? null,
  };
}

const bucketOf = (r) => `${r.kind || 'breakout-state'}|${r.kind === 'playbook' ? r.playbook : r.state}`;

export function createOutcomeRecorder({ keep = 4000, bucketCap = BUCKET_CAP, storage = null, key = 'bazu_outcomes_v2' } = {}) {
  let rows = [], seq = 0;
  try { storage?.removeItem('bazu_outcomes_v1'); } catch { /* ignore */ }
  const lastBy = new Map();
  try { rows = storage ? JSON.parse(storage.getItem(key) || '[]') : []; seq = rows.reduce((m, r) => Math.max(m, r.n || 0), 0); } catch { rows = []; }
  const save = () => {
    for (let n = Math.min(rows.length, 1500); n >= 0; n = Math.floor(n * 0.75)) {
      try { storage?.setItem(key, JSON.stringify(rows.slice(-n))); return; } catch { /* quota: retry smaller */ }
    }
  };
  /** Persisting is debounced: stringifying thousands of rows on every scan froze the page. */
  let saveTimer = null;
  const saveSoon = () => { if (!storage || saveTimer) return; saveTimer = setTimeout(() => { saveTimer = null; save(); }, 20000); };
  /** Drop the oldest rows of any bucket above its cap, then the oldest overall above `keep`, so common rows never evict rare ones. */
  const trim = () => {
    const count = new Map();
    for (const r of rows) count.set(bucketOf(r), (count.get(bucketOf(r)) || 0) + 1);
    rows = rows.filter((r) => { const b = bucketOf(r), c = count.get(b); if (c > bucketCap) { count.set(b, c - 1); return false; } return true; });
    if (rows.length > keep) rows = rows.slice(-keep);
  };

  return {
    /** Records every breakout event and the top playbook candidate; deduped per (symbol, kind, state/playbook, dir, zone) for MIN_GAP_TICKS ticks. */
    observe(symbol, pred, prices, epochs) {
      const price = prices[prices.length - 1], idx = epochs.length - 1, added = [];
      for (const snap of [...snapshot(symbol, pred, price), playbookSnapshot(symbol, pred, price)]) {
        if (!snap) continue;
        const zone = snap.kind === 'breakout-state' ? `${snap.context?.zoneTf || ''}@${Number(snap.edge).toPrecision(8)}` : '';
        const k = `${snap.kind}|${symbol}|${snap.kind === 'playbook' ? snap.playbook : snap.state}|${snap.dir}|${zone}`, prev = lastBy.get(k);
        if (prev != null && idx - prev < MIN_GAP_TICKS) continue;
        lastBy.set(k, idx);
        const row = { id: `${symbol}-${snap.at}-${snap.kind}-${snap.playbook || snap.state}-${snap.dir}-${zone}`, n: ++seq, ...snap, outcome: null };
        rows.push(row); added.push(row);
      }
      if (added.length) { trim(); saveSoon(); }
      return added.length ? added : null;
    },
    /** Resolve whatever has matured; a row is complete once the longest horizon is known. */
    resolve(symbol, prices, epochs) {
      let changed = false;
      const last = HORIZONS[HORIZONS.length - 1], tail = epochs[epochs.length - 1];
      for (const r of rows) {
        if (r.symbol !== symbol || (r.outcome && r.outcome.h[last] !== undefined && r.outcome.h[last] !== null)) continue;
        if (!(tail > r.at)) continue;
        const k = lastIdxAtOrBefore(epochs, r.at);
        if (k < 0) continue;
        const o = outcomeAt(prices, k, r.dir);
        if (o) { r.outcome = o; changed = true; }
      }
      if (changed) saveSoon();
      return changed;
    },
    all: () => rows,
    clear() { rows = []; lastBy.clear(); save(); },
    /** Accuracy per group and horizon; `eligibleOnly` restricts to observations that were real signals. */
    report({ eligibleOnly = false, kind = null, groupBy = (r) => r.state } = {}) {
      const obs = rows.filter((r) => r.outcome && (!eligibleOnly || r.eligible) && (!kind || (r.kind || 'breakout-state') === kind));
      const out = {};
      for (const h of HORIZONS) { const g = byGroup(obs, groupBy, h); for (const [k, v] of Object.entries(g)) (out[k] = out[k] || { n: 0, horizons: {} }, out[k].n = Math.max(out[k].n, v.n), out[k].horizons[h] = v); }
      return out;
    },
    /**
     * Real signals vs rejected/delayed candidates per playbook. `verdict` stays 'insufficient' until there are at
     * least `minReal` matured real signals, and a gate is only 'useful' when the rejected rows do clearly worse.
     */
    gateComparison(h = 5, minReal = MIN_REAL_SIGNALS) {
      const obs = rows.filter((r) => r.kind === 'playbook' && r.outcome);
      const res = {};
      for (const pb of new Set(obs.map((r) => r.playbook))) {
        const g = obs.filter((r) => r.playbook === pb), pick = (el) => accuracy(g.filter((r) => r.eligible === el).map((r) => ({ dir: r.dir, result: r.outcome.h[h] })));
        const real = pick(true), rej = pick(false);
        let verdict = 'insufficient';
        if (real.n >= minReal) verdict = !real.ci95 || !rej.ci95 ? 'insufficient' : real.ci95.lo > rej.ci95.hi ? 'gate helps' : real.ci95.hi < rej.ci95.lo ? 'gate hurts' : 'no clear difference';
        res[pb] = { real, rejected: rej, verdict, needReal: Math.max(0, minReal - real.n) };
      }
      return res;
    },
    /** Compare accuracy of observations where a filter passed, failed or was unavailable (breakout-state rows). */
    filterAudit(h = 5) {
      const obs = rows.filter((r) => r.outcome && r.filters && (r.kind || 'breakout-state') === 'breakout-state');
      const res = {};
      for (const f of Object.keys(obs[0]?.filters || {})) {
        res[f] = {};
        for (const v of ['pass', 'fail', 'n/a']) res[f][v] = accuracy(obs.filter((r) => r.filters[f] === v).map((r) => ({ dir: r.dir, result: r.outcome.h[h] })));
      }
      return res;
    },
  };
}
