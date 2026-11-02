import { transitionLifecycle, WATCHING_EXPIRY_SEC, TERMINAL_STATES } from './tradeSignalArchitecture.js';
import { LIFECYCLE_STORAGE_KEY } from './tradeSignalLifecycleStore.js';

export { LIFECYCLE_STORAGE_KEY };

// Bulky evidence that is recomputed by the next scan for pre-entry records, and only worth keeping for frozen entries.
export const BULKY_FIELDS = Object.freeze(['evidenceSnapshot', 'inducementEvents', 'familyValues', 'entry', 'bias', 'secondaryModels']);
// Retention: terminal/closed records keep their frozen snapshots for a day, then only the small summary is kept.
// History is capped, and the registry is capped, so persisted state cannot grow without limit.
export const TERMINAL_SNAPSHOT_TTL_SEC = 24 * 3600;
export const HISTORY_MAX = 200;
export const RECORDS_MAX = 500;
const isFinal = (record) => TERMINAL_STATES.includes(record.state) || record.state === 'Closed';

// Pure: returns true when the record was changed.
export function applyRetention(record, atSec) {
  let changed = false;
  if (Array.isArray(record.lifecycleHistory) && record.lifecycleHistory.length > HISTORY_MAX) {
    record.lifecycleHistory = record.lifecycleHistory.slice(-HISTORY_MAX); changed = true;
  }
  if (isFinal(record) && !record.snapshotsPrunedAt && Number.isFinite(atSec) && atSec - (record.updatedAt || 0) >= TERMINAL_SNAPSHOT_TTL_SEC) {
    for (const field of BULKY_FIELDS) delete record[field];
    record.snapshotsPrunedAt = atSec; changed = true;
  }
  return changed;
}

// level 0 keeps everything; 1 slims records that are not frozen yet; 2 slims everything except the active signal.
export function compactRecord(record, level) {
  if (level === 0) return record;
  const keep = level === 1 ? record.entryFrozenAt != null : record.state === 'Signal Active';
  if (keep) return record;
  const slim = { ...record };
  for (const field of BULKY_FIELDS) delete slim[field];
  return slim;
}

/**
 * Lifecycle registry. The in-memory map is the live truth: update() always applies the real state to the signal first.
 * - { store }: asynchronous IndexedDB persistence (write-behind, failures reported through onPersistChange, never thrown).
 * - { storage }: legacy synchronous localStorage persistence; failures are thrown after the state has been applied.
 */
export function createLifecycleRegistry({ storage = globalThis.localStorage, key = LIFECYCLE_STORAGE_KEY, store = null, onPersistChange = null, nowSec = () => Math.floor(Date.now() / 1000) } = {}) {
  const records = new Map(), dirty = new Set();
  let persistenceError = null, flushing = null, again = false;

  async function init() {
    if (!store) return load();
    const result = await store.migrateLegacy();
    for (const row of await store.loadAll()) {
      // A record already updated in memory is newer than anything read from disk.
      if (row && typeof row.state === 'string' && !records.has(row.key)) records.set(row.key, { ...row, lifecycleHistory: Array.isArray(row.lifecycleHistory) ? row.lifecycleHistory : [] });
    }
    return { records: list(), migration: result };
  }

  function setError(error) {
    const changed = (persistenceError == null) !== (error == null) || (error && persistenceError && error.message !== persistenceError.message);
    persistenceError = error;
    if (changed && onPersistChange) { try { onPersistChange(error); } catch { /* UI callback must not break scanning */ } }
  }

  function prune() {
    const at = nowSec(), put = [], remove = [];
    for (const [id, record] of records) if (applyRetention(record, at)) dirty.add(id);
    if (records.size > RECORDS_MAX) {
      const oldest = [...records].filter(([, record]) => isFinal(record)).sort((a, b) => (a[1].updatedAt || 0) - (b[1].updatedAt || 0));
      for (const [id] of oldest.slice(0, records.size - RECORDS_MAX)) { records.delete(id); dirty.delete(id); remove.push(id); }
    }
    for (const id of dirty) if (records.has(id)) put.push(records.get(id));
    return { put, remove };
  }

  function scheduleFlush() {
    if (flushing) { again = true; return flushing; }
    flushing = (async () => {
      try {
        do {
          again = false;
          const ids = [...dirty], { put, remove } = prune();
          dirty.clear();
          let lastError = null, ok = false;
          for (const level of [0, 1, 2]) {
            // Compacting must also rewrite rows stored earlier in full form, or they would keep occupying the quota.
            const rows = level === 0 ? put : [...records.values()];
            try { await store.write({ put: rows.map((record) => compactRecord(record, level)), remove }); ok = true; break; }
            catch (error) { lastError = error; }
          }
          if (ok) setError(null);
          else { for (const id of ids) dirty.add(id); setError(lastError); break; }
        } while (again);
      } finally { flushing = null; }
    })();
    return flushing;
  }

  async function flush() { while (flushing) await flushing; if (dirty.size && store) { scheduleFlush(); while (flushing) await flushing; } }

  function load() {
    records.clear();
    const raw = storage?.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError('invalid Trade Signal lifecycle archive');
      for (const [id, record] of Object.entries(parsed)) if (record && typeof record.state === 'string') records.set(id, { ...record, key: id, lifecycleHistory: Array.isArray(record.lifecycleHistory) ? record.lifecycleHistory : [] });
    }
    return list();
  }

  const serialize = (level) => JSON.stringify(Object.fromEntries([...records].map(([id, record]) => [id, compactRecord(record, level)])));

  function persist() {
    if (store) { scheduleFlush(); return true; }
    let lastError = null;
    for (const level of [1, 2]) {
      try {
        storage?.setItem(key, serialize(level));
        persistenceError = null;
        return true;
      } catch (error) {
        lastError = error;
      }
    }
    persistenceError = lastError;
    throw lastError;
  }

  function update(sig, profile, at) {
    const id = `${sig.symbol}|${profile.id}`;
    let record = records.get(id) || { key: id, state: 'No Setup', lifecycleHistory: [], watchingSince: null };
    if (TERMINAL_STATES.includes(record.state) || record.state === 'Closed') {
      sig.lifecycleState = record.state;
      sig.lifecycleHistory = record.lifecycleHistory;
      sig.waitingCondition = record.waitingCondition || 'setup is terminal';
      sig.nearestLevel = record.nearestLevel ?? null;
      sig.status = record.state === 'Opposed' ? 'wait' : 'none';
      sig.headline = `${sig.label || sig.symbol}: ${record.state}`;
      return record;
    }
    const previousState = record.state;
    const hasBias = sig.dir === 1 || sig.dir === -1;
    const hasLocation = !!(sig.layers && sig.layers.location.status === 'Approaching Location');
    const hasModel = !!sig.primaryModel;
    const move = (next, reason) => {
      if (record.state !== next && !TERMINAL_STATES.includes(record.state)) transitionLifecycle(record, next, at, reason || sig.reason || sig.headline || '');
    };
    if (record.state === 'No Setup') {
      if (sig.status === 'insufficient') move('Insufficient Data', sig.reason);
      else if (hasBias) move('Bias Identified', 'directional context established');
    }
    if (record.state === 'Bias Identified') {
      if (sig.status === 'wait') move('Opposed', sig.reason);
      else if (hasBias) move('Watching', 'awaiting context-aligned location and entry model');
    }
    if (record.state === 'Watching') {
      if (sig.status === 'wait') move('Opposed', sig.reason);
      else if (hasLocation) move('Approaching Location', 'price is interacting with a qualifying location');
    }
    if (record.state === 'Approaching Location') {
      if (sig.status === 'wait') move('Opposed', sig.reason);
      else if (!hasLocation) move('Watching', 'location condition no longer qualifies');
      else if (hasModel) move('Trigger Detected', 'ordered entry model confirmed');
    }
    if (record.state === 'Trigger Detected') {
      if (sig.status === 'wait') move('Opposed', sig.reason);
      else if (sig.status === 'signal') move('Signal Active', 'all three analysis layers agree');
      else if (sig.preEntryInvalidated || !hasModel || !hasLocation) move('Invalidated Before Entry', sig.preEntryInvalidationReason || 'confirmed model or location no longer qualifies before entry');
    }
    if (['Watching', 'Approaching Location'].includes(record.state) && record.watchingSince == null) record.watchingSince = at;
    if (['Watching', 'Approaching Location'].includes(record.state) && at - record.watchingSince >= WATCHING_EXPIRY_SEC[profile.id]) {
      transitionLifecycle(record, 'Expired Without Entry', at, 'profile watching window elapsed without entry confirmation');
    }
    const entrySnapshot = { direction: sig.dir || record.direction || 0, entry: sig.entry || record.entry || null, overallBalance: sig.overallBalance ?? record.overallBalance ?? null,
      familyValues: sig.familyValues || record.familyValues || null, primaryModel: sig.primaryModel || record.primaryModel || null, secondaryModels: sig.secondaryModels?.length ? sig.secondaryModels : record.secondaryModels || [],
      target: sig.target || record.target || null, invalidation: sig.invalidation || record.invalidation || null, holdLabel: sig.holdLabel || record.holdLabel || null,
      trigger: sig.trigger || record.trigger || null, entryG: sig.entryG || record.entryG || null, price: sig.price ?? record.price ?? null,
      confirmedAt: sig.confirmedAt ?? record.confirmedAt ?? null, detectedAt: sig.detectedAt ?? record.detectedAt ?? null,
      model_id: sig.model_id ?? sig.primaryModel?.model_id ?? record.model_id ?? null,
      model_context: sig.model_context ?? sig.primaryModel?.context ?? record.model_context ?? null,
      inducementEvents: sig.inducementEvents?.length ? sig.inducementEvents : record.inducementEvents || [], evidenceSnapshot: sig.evidenceSnapshot?.length ? sig.evidenceSnapshot : record.evidenceSnapshot || [] };
    const entryFrozen = record.entryFrozenAt != null;
    Object.assign(record, { bias: sig.bias || null, waitingCondition: sig.status === 'signal' ? 'holding until the profile period ends' : (sig.waitingCondition || sig.reason || ''), nearestLevel: sig.nearestLevel ?? sig.layers?.location?.evidence?.[0]?.price ?? null, updatedAt: at, profileName: sig.profileName || profile.name || profile.id, status: sig.status, action: sig.action || null, headline: sig.headline || '', reason: sig.reason || '' });
    if (!entryFrozen) {
      Object.assign(record, entrySnapshot);
      if (record.state === 'Trigger Detected' || record.state === 'Signal Active') record.entryFrozenAt = at;
    }
    if (sig.status === 'signal' && record.state === 'Signal Active' && previousState !== 'Signal Active') {
      record.signalId = `${id}@${sig.entryAt ?? sig.detectedAt ?? at}`;
    }
    records.set(id, record); dirty.add(id);
    // The row must show the real state even when storage is full, so apply it before persisting.
    sig.lifecycleState = record.state;
    sig.lifecycleHistory = record.lifecycleHistory;
    sig.waitingCondition = record.waitingCondition || (record.state === 'Signal Active' ? 'holding until the profile period ends' : '');
    sig.nearestLevel = record.nearestLevel;
    persist();
    return record;
  }

  function close(id, at, reason = 'end-of-period outcome resolved') {
    const record = records.get(id);
    if (!record || record.state !== 'Signal Active') return record || null;
    transitionLifecycle(record, 'Closed', at, reason);
    record.updatedAt = at;
    records.set(id, record); dirty.add(id);
    persist();
    return record;
  }

  function list() { return [...records.values()].map((record) => ({ ...record, lifecycleHistory: [...record.lifecycleHistory] })); }
  return { init, flush, load, update, close, get: (id) => records.get(id) || null, list, persist, get persistenceError() { return persistenceError; } };
}
