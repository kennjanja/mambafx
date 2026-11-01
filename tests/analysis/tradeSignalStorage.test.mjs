import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateLegacyRecord, migrateArchiveRecords, mergeArchiveRecords } from '../../src/analysis/tradeSignalStorage.js';

test('legacy archive migration marks old scoring and preserves outcomes and timestamps', () => {
  const legacy = { id: 'old', symbol: 'R_10', openedAt: 10, expiresAt: 20, state: 'correct', last: 101, rule: 'hold' };
  const migrated = migrateLegacyRecord(legacy);
  assert.equal(migrated.resolution_method, 'legacy-scan-sample');
  assert.equal(migrated.state, 'correct'); assert.equal(migrated.openedAt, 10); assert.equal(migrated.model_id, null); assert.equal(migrated.familyValues, null);
  assert.equal(legacy.resolution_method, undefined);
});

test('archive migration is idempotent and removes duplicates without losing enriched fields', () => {
  const archive = [
    { id: 'same', state: 'wrong', resolution_method: 'legacy-scan-sample', target: 103 },
    { id: 'same', state: 'wrong', resolution_method: 'legacy-scan-sample', familyValues: { structure: 0.3 } },
    { id: 'other', state: 'correct' },
  ];
  const once = migrateArchiveRecords(archive), twice = migrateArchiveRecords(once);
  assert.equal(once.length, 2); assert.deepEqual(twice, once);
  assert.equal(once[0].target, 103); assert.deepEqual(once[0].familyValues, { structure: 0.3 });
});

test('merging the same resolution twice never duplicates it', () => {
  const old = [{ id: 'old', state: 'correct' }], rec = { id: 'new', state: 'wrong', model_id: 'A', resolution_method: 'post-entry-1m-close' };
  const merged = mergeArchiveRecords(old, [rec, rec]);
  assert.equal(merged.length, 2); assert.equal(merged[0].resolution_method, 'legacy-scan-sample'); assert.equal(merged[1].model_id, 'A');
});


test('failed migration writes never overwrite the existing archive', async () => {
  const raw = JSON.stringify([{ id: 'kept', state: 'wrong', last: 0 }]);
  const storage = { getItem: () => raw, setItem: () => { throw new Error('quota'); } };
  const { loadArchive } = await import('../../src/analysis/tradeSignalStorage.js');
  const result = loadArchive(storage);
  assert.equal(result[0].id, 'kept'); assert.equal(result[0].resolution_method, 'legacy-scan-sample');
  assert.equal(storage.getItem(), raw);
});
