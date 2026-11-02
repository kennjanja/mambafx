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

  function persist() {
    try {
      storage?.setItem(key, JSON.stringify(Object.fromEntries(records)));
      persistenceError = null;
      return true;
    } catch (error) {
      persistenceError = error;
      throw error;
    }
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
    Object.assign(record, { direction: sig.dir || 0, bias: sig.bias || null, waitingCondition: sig.waitingCondition || sig.reason || '', nearestLevel: sig.nearestLevel ?? sig.layers?.location?.evidence?.[0]?.price ?? null, updatedAt: at, profileName: sig.profileName || profile.name || profile.id, status: sig.status, action: sig.action || null, headline: sig.headline || '', reason: sig.reason || '', overallBalance: sig.overallBalance ?? null, familyValues: sig.familyValues || null, primaryModel: sig.primaryModel || null, secondaryModels: sig.secondaryModels || [], target: sig.target || null, invalidation: sig.invalidation || null, holdLabel: sig.holdLabel || null, trigger: sig.trigger || null, entryG: sig.entryG || null, price: sig.price ?? null, inducementEvents: sig.inducementEvents || [], evidenceSnapshot: sig.evidenceSnapshot || record.evidenceSnapshot || [] });
    if (sig.status === 'signal' && record.state === 'Signal Active' && previousState !== 'Signal Active') {
      record.signalId = `${id}@${sig.entryAt ?? sig.detectedAt ?? at}`;
    }
    records.set(id, record);
    persist();
    sig.lifecycleState = record.state;
    sig.lifecycleHistory = record.lifecycleHistory;
    sig.waitingCondition = record.waitingCondition || (record.state === 'Signal Active' ? 'holding until the profile period ends' : '');
    sig.nearestLevel = record.nearestLevel;
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
