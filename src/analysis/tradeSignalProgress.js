import { MODEL_REGISTRY } from './tradeSignalArchitecture.js';

// Read-only diagnostics: how far each model's ordered sequence has progressed. Never feeds scoring or signal selection.
const STEP_TEXT = Object.freeze({
  'significant-sweep': 'sweep', displacement: 'displacement', 'structure-shift': 'structure shift', bos: 'BOS', 'ob-retest': 'order-block retest',
  reaction: 'reaction', 'fvg-created': 'FVG', 'fvg-retest': 'FVG retest', 'ob-confirmed-for-breaker': 'order block', 'ob-break': 'order-block break',
  'opposite-structure': 'opposite structure', 'breaker-retest': 'breaker retest', 'inducement-confirmed': 'inducement sweep + displacement',
  'broken-level-retest': 'broken-level retest', 'range-established': 'range', 'sos-or-sow': 'SOS/SOW', 'lps-or-lpsy': 'LPS/LPSY',
});
const stepText = (step) => STEP_TEXT[step] || step;

function matchedPrefix(events, sequence, dir) {
  let cursor = -Infinity, count = 0;
  for (const type of sequence) {
    const found = events.filter((e) => e.type === type && e.confirmedIndex >= cursor && (e.dir == null || e.dir === 0 || e.dir === dir))
      .sort((a, b) => a.confirmedIndex - b.confirmedIndex)[0];
    if (!found) break;
    count++; cursor = found.confirmedIndex;
  }
  return count;
}

export function computeModelProgress({ events = [], dir = 0, hasLocation = false, confirmedIds = [] } = {}) {
  const usable = events.filter((e) => Number.isFinite(e.confirmedIndex));
  const models = MODEL_REGISTRY.map((model) => {
    const total = model.sequence.length;
    const matched = dir ? matchedPrefix(usable, model.sequence, dir) : 0;
    const confirmed = confirmedIds.includes(model.model_id);
    const text = confirmed ? `Model ${model.model_id}: confirmed`
      : matched === 0 ? `Model ${model.model_id}: waiting for ${stepText(model.sequence[0])}`
        : `Model ${model.model_id}: ${stepText(model.sequence[matched - 1])} confirmed, waiting for ${stepText(model.sequence[matched])}`;
    return { id: model.model_id, name: model.name, matched, total, confirmed, text };
  });
  const best = [...models].sort((a, b) => (b.confirmed - a.confirmed) || (b.matched / b.total - a.matched / a.total) || a.id.localeCompare(b.id))[0] || null;
  return { dir, hasLocation, models, best };
}

export function createFunnel() {
  const data = {};
  return {
    data,
    record(profileId, progress) {
      if (!progress) return;
      const p = data[profileId] || (data[profileId] = { scans: 0, bias: 0, location: 0, models: {} });
      p.scans++;
      if (progress.dir) p.bias++;
      if (progress.hasLocation) p.location++;
      for (const m of progress.models) {
        const row = p.models[m.id] || (p.models[m.id] = { total: m.total, steps: Array(m.total).fill(0), confirmed: 0 });
        for (let i = 0; i < m.matched; i++) row.steps[i]++;
        if (m.confirmed) row.confirmed++;
      }
    },
  };
}
