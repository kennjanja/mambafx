import { transitionLifecycle, WATCHING_EXPIRY_SEC, TERMINAL_STATES } from './tradeSignalArchitecture.js';

export const LIFECYCLE_STORAGE_KEY = 'mfx_ts_lifecycle_v1';

export function createLifecycleRegistry({ storage = globalThis.localStorage, key = LIFECYCLE_STORAGE_KEY } = {}) {
  const records = new Map();
  let persistenceError = null;

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

  // Pre-entry records are re-derived from the next scan, so their bulky evidence is not worth persisting. Frozen entry
  // records (Trigger Detected, Signal Active, terminal) keep everything. If storage is still full the minimal form
  // keeps only the active signal's evidence.
  const BULKY_FIELDS = ['evidenceSnapshot', 'inducementEvents', 'familyValues', 'entry', 'bias', 'secondaryModels'];
  const serialize = (level) => JSON.stringify(Object.fromEntries([...records].map(([id, record]) => {
    const keepFull = level === 0 ? record.entryFrozenAt != null : record.state === 'Signal Active';
    if (keepFull) return [id, record];
    const slim = { ...record };
    for (const field of BULKY_FIELDS) delete slim[field];
    return [id, slim];
  })));

  function persist() {
    let lastError = null;
    for (const level of [0, 1]) {
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
    records.set(id, record);
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
    records.set(id, record);
    persist();
    return record;
  }

  function list() { return [...records.values()].map((record) => ({ ...record, lifecycleHistory: [...record.lifecycleHistory] })); }
  return { load, update, close, get: (id) => records.get(id) || null, list, persist, get persistenceError() { return persistenceError; } };
}
