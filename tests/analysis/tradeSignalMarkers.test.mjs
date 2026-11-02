import test from 'node:test';
import assert from 'node:assert/strict';
import { mapSnapshotEvidence, selectFocusGranularity } from '../../src/analysis/tradeSignalMarkers.js';

const candles = (start, count, granularity) => Array.from({ length: count }, (_, i) => ({ epoch: start + i * granularity }));

test('3m and 15m snapshots select their matching displayed charts when available', () => {
  const available = [30, 60, 180, 300, 900, 1800, 3600, 14400];
  assert.equal(selectFocusGranularity(180, available), 180);
  assert.equal(selectFocusGranularity(900, available), 900);
  assert.equal(selectFocusGranularity(180, [30, 60, 300]), 60);
  assert.equal(selectFocusGranularity(900, [30, 60, 300]), 300);
});

test('frozen event timestamps map by candle interval at exact timeframe boundaries', () => {
  const arr = candles(0, 6, 60), beforeBoundary = { id: 'a', occurredAt: 179 }, boundary = { id: 'b', occurredAt: 180 };
  const mapped = mapSnapshotEvidence([beforeBoundary, boundary], arr, 60);
  assert.deepEqual(mapped.map(({ index }) => index), [2, 3]);
  assert.equal(mapped[0].item, beforeBoundary);
  assert.equal(mapped[1].item, boundary);
  assert.deepEqual(mapped.map(({ item }) => item.id), ['a', 'b']);
});

test('mapping is independent of history start, zoom window, and later history loading', () => {
  const event = { id: 'event-1', occurredAt: 600, sequenceNumber: 1 };
  const original = candles(300, 10, 60), extended = candles(0, 15, 60);
  const first = mapSnapshotEvidence([event], original, 60)[0];
  const loaded = mapSnapshotEvidence([event], extended, 60)[0];
  assert.equal(original[first.index].epoch, 600);
  assert.equal(extended[loaded.index].epoch, 600);
  assert.notEqual(first.index, loaded.index);
  const zooms = [
    { start: 0, count: 4, visible: false },
    { start: 8, count: 4, visible: true },
    { start: 11, count: 4, visible: false },
  ];
  for (const zoom of zooms) {
    assert.equal(loaded.index, 10, 'zooming never changes timestamp-to-candle mapping');
    assert.equal(loaded.index >= zoom.start && loaded.index < zoom.start + zoom.count, zoom.visible);
  }
  assert.equal(loaded.item, event);
  assert.equal(loaded.item.occurredAt, 600);
});

test('history missing the timestamp omits the marker instead of reusing an unrelated old index', () => {
  const event = { id: 'frozen-evidence', index: 1, occurredAt: 60 };
  assert.deepEqual(mapSnapshotEvidence([event], candles(600, 4, 60), 60), []);
  const legacy = { index: 1 };
  assert.deepEqual(mapSnapshotEvidence([legacy], candles(600, 4, 60), 60), [{ item: legacy, index: 1 }]);
});

test('multiple markers preserve source order and frozen evidence identity', () => {
  const first = { id: 'pivot', occurredAt: 60, sequenceNumber: 1 };
  const second = { id: 'sweep', occurredAt: 180, sequenceNumber: 2 };
  const third = { id: 'displacement', occurredAt: 240, sequenceNumber: 3 };
  const result = mapSnapshotEvidence([first, second, third], candles(0, 8, 60), 60);
  assert.deepEqual(result.map(({ item }) => item.id), ['pivot', 'sweep', 'displacement']);
  assert.deepEqual(result.map(({ index }) => index), [1, 3, 4]);
  assert.deepEqual(result.map(({ item }) => item.occurredAt), [60, 180, 240]);
});
