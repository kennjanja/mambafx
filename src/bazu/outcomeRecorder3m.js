/**
 * src/bazu/outcomeRecorder3m.js  (pure, shadow only)
 * Records the features available at prediction time for each breakout observation and later scores the
 * direction at HORIZONS ticks with the same convention as horizons3m (entry = first tick after the decision).
 * Never reads or changes signal generation, filtering or execution.
 */
import { HORIZONS, outcomeAt, byGroup, accuracy } from './horizons3m.js?v=17';

const MIN_GAP_TICKS = 10;

/** Index of the last tick at or before `at` (-1 if none). */
const lastIdxAtOrBefore = (epochs, at) => { let lo = 0, hi = epochs.length; while (lo < hi) { const m = (lo + hi) >> 1; if (epochs[m] <= at) lo = m + 1; else hi = m; } return lo - 1; };

const filterSnapshot = (f) => (f ? Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v ? (v.pass === true ? 'pass' : v.pass === false ? 'fail' : 'n/a') : 'n/a'])) : null);

/** Snapshot of a prediction as it stood at decision time, or null when it holds no breakout observation. */
export function snapshot(symbol, pred, price) {
  const b = pred?.breakoutState;
  const traded = pred && !pred.wait && pred.playbook === 'breakout';
  if (!b || !b.direction) return null;
  return {
    kind: 'breakout-state',
    symbol, at: pred.decisionTs, price, dir: b.direction, state: b.state, edge: b.edge,
    strength: b.strength, confirmation: b.confirmation, context: b.context || null,
    filters: filterSnapshot(pred.breakoutFilters),
    playbook: pred.playbook || null, signalDir: pred.direction || 0, score: pred.strength ?? null,
    eligible: !!traded,
    regime: pred.regime?.type || null,
    families: pred.families || null,
  };
}

/** Snapshot of the top playbook candidate, whether or not it survived the gates (eligible = it did). */
export function playbookSnapshot(symbol, pred, price) {
  if (!pred?.playbook || !(pred.direction === 1 || pred.direction === -1)) return null;
  return {
    kind: 'playbook',
    symbol, at: pred.decisionTs, price, dir: pred.direction, state: pred.wait ? 'gated' : 'signal', playbook: pred.playbook,
    filters: filterSnapshot(pred.breakoutFilters),
    score: pred.strength ?? null, eligible: !pred.wait, gate: (pred.vetoes && pred.vetoes[0]) || (pred.reasons && pred.reasons[0]) || null,
    regime: pred.regime?.type || null, families: pred.families || null,
    familyAgreement: pred.familyAgreement ?? null,
  };
}

export function createOutcomeRecorder({ keep = 3000, storage = null, key = 'bazu_outcomes_v1' } = {}) {
  let rows = [], seq = 0;
  const lastBy = new Map();
  try { rows = storage ? JSON.parse(storage.getItem(key) || '[]') : []; seq = rows.reduce((m, r) => Math.max(m, r.n || 0), 0); } catch { rows = []; }
  const save = () => { try { storage?.setItem(key, JSON.stringify(rows.slice(-keep))); } catch { /* quota */ } };

  return {
    /** Records one breakout-state row and one playbook row per scan, each deduped per (symbol, kind, state, dir) for MIN_GAP_TICKS ticks. */
    observe(symbol, pred, prices, epochs) {
      const price = prices[prices.length - 1], idx = epochs.length - 1, added = [];
      for (const snap of [snapshot(symbol, pred, price), playbookSnapshot(symbol, pred, price)]) {
        if (!snap) continue;
        const k = `${snap.kind}|${symbol}|${snap.playbook && snap.kind === 'playbook' ? snap.playbook : snap.state}|${snap.dir}`, prev = lastBy.get(k);
        if (prev != null && idx - prev < MIN_GAP_TICKS) continue;
        lastBy.set(k, idx);
        const row = { id: `${symbol}-${snap.at}-${snap.kind}-${snap.playbook || snap.state}-${snap.dir}`, n: ++seq, ...snap, outcome: null };
        rows.push(row); added.push(row);
      }
      if (rows.length > keep) rows = rows.slice(-keep);
      return added.length ? added : null;
    },
    /** Resolve whatever has matured; a row is complete once the longest horizon is known. */
    resolve(symbol, prices, epochs) {
      let changed = false;
      for (const r of rows) {
        if (r.symbol !== symbol || (r.outcome && r.outcome.h[HORIZONS[HORIZONS.length - 1]])) continue;
        const k = lastIdxAtOrBefore(epochs, r.at);
        if (k < 0) continue;
        const o = outcomeAt(prices, k, r.dir);
        if (o) { r.outcome = o; changed = true; }
      }
      if (changed) save();
      return changed;
    },
    all: () => rows,
    clear() { rows = []; lastBy.clear(); save(); },
    /** Accuracy per breakout state and horizon; `eligibleOnly` restricts to observations that were real signals. */
    report({ eligibleOnly = false, kind = null, groupBy = (r) => r.state } = {}) {
      const obs = rows.filter((r) => r.outcome && (!eligibleOnly || r.eligible) && (!kind || (r.kind || 'breakout-state') === kind));
      const out = {};
      for (const h of HORIZONS) { const g = byGroup(obs, groupBy, h); for (const [k, v] of Object.entries(g)) (out[k] = out[k] || { n: 0, horizons: {} }, out[k].n = Math.max(out[k].n, v.n), out[k].horizons[h] = v); }
      return out;
    },
    /** Compare accuracy of observations where a filter passed, failed or was unavailable. */
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
