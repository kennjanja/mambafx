// Legacy Prediction History remains the canonical store because this app has no shared backend history API.
// Migration is additive and idempotent: the original records remain readable if a write fails.
export const ARCHIVE_KEY = 'mfx_ts_archive_v1';

export function migrateLegacyRecord(record) {
  if (!record || typeof record !== 'object') return record;
  if (record.resolution_method) return { ...record };
  return {
    ...record,
    model_id: record.model_id ?? null,
    model_context: record.model_context ?? null,
    familyValues: record.familyValues ?? null,
    overallBalance: record.overallBalance ?? null,
    resolution_method: 'legacy-scan-sample',
  };
}

export function migrateArchiveRecords(records = []) {
  const migrated = [], seen = new Set();
  for (const original of Array.isArray(records) ? records : []) {
    const record = migrateLegacyRecord(original);
    if (!record) continue;
    const key = record.id || null;
    if (key && seen.has(key)) {
      const previous = migrated.findIndex((item) => item.id === key);
      if (previous >= 0) migrated[previous] = { ...migrated[previous], ...record };
      continue;
    }
    if (key) seen.add(key);
    migrated.push(record);
  }
  return migrated;
}

export function mergeArchiveRecords(existing = [], incoming = []) {
  const merged = migrateArchiveRecords(existing);
  const ids = new Set(merged.map((record) => record.id).filter(Boolean));
  for (const original of incoming) {
    const record = migrateLegacyRecord(original);
    if (!record || (record.id && ids.has(record.id))) continue;
    merged.push(record);
    if (record.id) ids.add(record.id);
  }
  return merged;
}

export function loadArchive(storage = globalThis.localStorage) {
  let records = [], parseable = true;
  try { records = JSON.parse(storage?.getItem(ARCHIVE_KEY) || '[]'); } catch { parseable = false; }
  if (!parseable || !Array.isArray(records)) return [];
  const migrated = migrateArchiveRecords(records);
  if (JSON.stringify(records) !== JSON.stringify(migrated)) {
    try { storage?.setItem(ARCHIVE_KEY, JSON.stringify(migrated)); } catch { /* preserve readable legacy records when migration cannot be written */ }
  }
  return migrated;
}
