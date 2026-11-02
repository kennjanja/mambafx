/** Pure mapping for frozen Trade Signal evidence on a displayed candle series. */
export function selectFocusGranularity(entryGranularity, availableGranularities = []) {
  if (!Number.isFinite(entryGranularity) || entryGranularity <= 0) return null;
  return availableGranularities.filter((g) => Number.isFinite(g) && g > 0 && entryGranularity % g === 0)
    .sort((a, b) => b - a)[0] ?? null;
}

/**
 * Map a frozen event timestamp to the displayed candle interval containing it.
 * Timestamped evidence is never remapped by its old index when history differs.
 * Untimestamped legacy items retain their original index behavior.
 */
export function mapSnapshotEvidence(items = [], candles = [], granularity = null) {
  return items.flatMap((item) => {
    if (Number.isFinite(item.occurredAt)) {
      const index = candles.findIndex((c) => Number.isFinite(c.epoch)
        && (Number.isFinite(granularity)
          ? c.epoch <= item.occurredAt && item.occurredAt < c.epoch + granularity
          : c.epoch === item.occurredAt));
      return index < 0 ? [] : [{ item, index }];
    }
    return Number.isInteger(item.index) && item.index >= 0 && item.index < candles.length
      ? [{ item, index: item.index }] : [];
  });
}
