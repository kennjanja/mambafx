// Trade-signal composer: turns the evidence engine's reading of a higher "bias" timeframe and a lower "entry"
// timeframe into one descriptive setup per market. Pure and deterministic.
//
//   bias  (30 min): must report a bullish/bearish lean, with 1 hour + 4 hour as higher-timeframe context
//   entry (5 min) : must not oppose the bias lean; supplies the target area and invalidation
//
// This is a rule-based reading of evidence. The evidence weights are provisional and unvalidated, so the output
// is NOT a forecast, a probability or a profitability claim.

import { analyzeEvidence } from './evidence.js';
import { aggregateEvidenceFamilies, FAMILY_WEIGHTS, evaluateEntryModels, evaluateLayers } from './tradeSignalArchitecture.js';

export const TRADE_SIGNAL_TFS = Object.freeze({
  entry: { g: 300, label: '5 min' },
  bias: { g: 1800, label: '30 min' },
  htf: Object.freeze([{ g: 3600, label: '1 hour' }, { g: 14400, label: '4 hour' }]),
});

// Profiles: different bias / entry / hold combinations. A profile is a fixed rule set, not tuned on outcomes.
const T = (g, label) => ({ g, label });
export const PROFILES = Object.freeze({
  scalp: { id: 'scalp', name: 'Scalp', holdSec: 180, holdLabel: '3 min', tfs: { bias: T(900, '15 min'), entry: T(180, '3 min'), htf: [T(1800, '30 min'), T(3600, '1 hour')] } },
  intraday: { id: 'intraday', name: 'Intraday', holdSec: 1800, holdLabel: '30 min', tfs: TRADE_SIGNAL_TFS },
  swing: { id: 'swing', name: 'Swing', holdSec: 3600, holdLabel: '1 hour', tfs: { bias: T(3600, '1 hour'), entry: T(900, '15 min'), htf: [T(14400, '4 hour')] } },
});
export const PROFILE_LIST = Object.freeze([PROFILES.scalp, PROFILES.intraday, PROFILES.swing]);
export const ALL_GRANULARITIES = Object.freeze([...new Set(PROFILE_LIST.flatMap((p) => [p.tfs.entry.g, p.tfs.bias.g, ...p.tfs.htf.map((h) => h.g)]))].sort((a, b) => a - b));

// Opposing entry-timeframe response is considered only when it occurs after a model's final confirmation.
function findReversal(entry, dir, candles) {
  if (entry.dropped) return null;
  const it = entry.items.filter((i) => i.dir === -dir && i.index != null && ['liquidity', 'candle', 'break'].includes(i.group)).sort((a, b) => b.index - a.index)[0];
  const c = it && candles[it.index];
  return it && c ? { label: it.label, epoch: c.epoch } : null;
}

const KIND = {
  'S/R above': 'resistance', 'S/R below': 'support',
  'liquidity pool above': 'liquidity pool', 'liquidity pool below': 'liquidity pool',
  'swing range high': 'swing high', 'swing range low': 'swing low',
};

function pickTarget(dir, price, evidences) {
  for (const { ev, tf } of evidences) {
    const sc = ev.scenarios && ev.scenarios.find((s) => s.dir === dir);
    if (!sc) continue;
    const ok = sc.targets.filter((t) => (dir === 1 ? t.price > price : t.price < price));
    if (!ok.length) continue;
    ok.sort((a, b) => (dir === 1 ? a.price - b.price : b.price - a.price));
    return { price: ok[0].price, kind: KIND[ok[0].why] || ok[0].why, tf };
  }
  return null;
}

/** candles: { [granularity]: candle[] } -> setup description for one market. */
export function buildTradeSignal({ symbol, label = symbol, candles = {}, profile = PROFILES.intraday, tfs = profile.tfs, nowSec = null }) {
  const get = (t) => {
    const series = candles[t.g] || [];
    return Number.isFinite(nowSec) ? series.filter((c) => Number.isFinite(c.epoch) && c.epoch + t.g <= nowSec) : series;
  };
  const htf = tfs.htf.map((h) => ({ tf: h.label, g: h.g, candles: get(h) })).filter((h) => h.candles.length >= 60);
  const bias = analyzeEvidence(get(tfs.bias), { htf, granularity: tfs.bias.g });
  const entry = analyzeEvidence(get(tfs.entry), { htf: [{ tf: tfs.bias.label, g: tfs.bias.g, candles: get(tfs.bias) }, ...htf].filter((h) => h.candles.length >= 60), granularity: tfs.entry.g });
  const families = bias.families || aggregateEvidenceFamilies(bias.items, FAMILY_WEIGHTS).families;
  const base = { symbol, label, profile: profile.id, profileName: profile.name, holdSec: profile.holdSec, holdLabel: profile.holdLabel, entryG: tfs.entry.g, biasTf: tfs.bias.label, entryTf: tfs.entry.label, bias: summary(bias), entry: summary(entry), familyValues: families, overallBalance: bias.overallBalance ?? bias.balance, dir: 0, status: 'none', detectedAt: Number.isFinite(nowSec) ? nowSec : null, inducementEvents: entry.facts?.inducements || [], evidenceSnapshot: buildTradeSignalEvidenceSnapshot(entry, tfs.entry.g) };
  const activeInducement = (entry.facts?.inducements || []).find((event) => ['formed', 'swept'].includes(event.state));
  if (activeInducement) base.waitingCondition = activeInducement.state === 'formed' ? 'Waiting for inducement sweep' : 'Waiting for displacement';
  if (!bias.sufficient || !entry.sufficient) {
    return { ...base, status: 'insufficient', reason: `not enough candles (${!bias.sufficient ? tfs.bias.label : tfs.entry.label})`, headline: `${label}: waiting for candle history` };
  }
  const dir = bias.verdict === 'bullish-lean' ? 1 : bias.verdict === 'bearish-lean' ? -1 : 0;
  const price = entry.facts.price;
  base.price = price;
  if (!dir) return { ...base, reason: `${tfs.bias.label} evidence is ${bias.verdict}`, headline: `${label}: no ${tfs.bias.label} lean` };
  base.dir = dir;
  const reversal = findReversal(entry, dir, get(tfs.entry));
  base.reversal = reversal;   // informational only; active records never exit early on a reversal
  const word = dir === 1 ? 'BULLISH' : 'BEARISH', action = dir === 1 ? 'BUY' : 'SELL';
  const entryVerdictDir = entry.verdict === 'bullish-lean' ? 1 : entry.verdict === 'bearish-lean' ? -1 : 0;
  if (entryVerdictDir === -dir) {
    return { ...base, status: 'wait', action, reason: `${tfs.entry.label} evidence leans ${entryVerdictDir === 1 ? 'bullish' : 'bearish'}, against the ${tfs.bias.label} ${word.toLowerCase()} lean`, headline: `${label}: ${word} lean on ${tfs.bias.label}, but ${tfs.entry.label} opposes - wait` };
  }
  const locationEvidence = entry.items.filter((item) => ['level', 'zone', 'location'].includes(item.group) && item.dir === dir);
  const scenario = entry.scenarios.find((s) => s.dir === dir);
  const invalidation = scenario && scenario.invalidation ? { ...scenario.invalidation, tf: tfs.entry.label } : null;
  const entryDirection = entry.verdict === 'bullish-lean' ? 1 : entry.verdict === 'bearish-lean' ? -1 : entry.facts.swingBias;
  const modelEvents = entry.facts.modelEvents || [];
  const hasWyckoffSequence = modelEvents.some((event) => event.type === 'range-established') && modelEvents.some((event) => event.type === 'sos-or-sow') && modelEvents.some((event) => event.type === 'lps-or-lpsy');
  const marketContext = hasWyckoffSequence ? ['trend', 'range'] : ['trend'];
  const evaluatedModels = evaluateEntryModels({ events: modelEvents, biasDirection: dir, entryDirection, marketContext,
    locations: locationEvidence, nearestInvalidationDistance: invalidation ? Math.abs(price - invalidation.price) : Infinity, asOfIndex: entry.candles.length - 1 });
  const reversalIndex = reversal ? entry.candles.findIndex((c) => c.epoch === reversal.epoch) : -1;
  const eligible = evaluatedModels.candidates.filter((candidate) => {
    const last = candidate.confirmingEvents[candidate.confirmingEvents.length - 1];
    return reversalIndex < 0 || last.confirmedIndex >= reversalIndex;
  });
  const modelSelection = { primary: eligible[0] || null, secondary: eligible.slice(1), candidates: eligible };
  if (modelSelection.primary) base.reversal = null;
  const layers = evaluateLayers({ bias, entry, locationEvidence, models: modelSelection.candidates });
  base.layers = layers;
  base.primaryModel = modelSelection.primary;
  base.secondaryModels = modelSelection.secondary;
  base.qualifyingModelIds = modelSelection.candidates.map((model) => model.model_id);
  if (!layers.signal) {
    const missing = layers.missingLayer || 'Entry Confirmation';
    const reason = missing === 'Location Gate' ? 'waiting for a context-aligned support, resistance, supply/demand or zone interaction'
      : missing === 'Entry Confirmation' ? 'waiting for a complete ordered entry-model sequence' : 'directional bias is inconclusive';
    const headline = `${label}: ${word} lean on ${tfs.bias.label} - waiting for ${missing}`;
    return { ...base, status: missing === 'Entry Confirmation' || missing === 'Location Gate' ? 'watching' : 'none', action,
      reason: `${missing}: ${reason}`, headline };
  }
  const model = modelSelection.primary;
  const triggerEvent = model.confirmingEvents[model.confirmingEvents.length - 1];
  const trigger = { kind: 'model', label: triggerEvent.label || triggerEvent.type, index: triggerEvent.index, confirmedIndex: triggerEvent.confirmedIndex };
  const target = pickTarget(dir, price, [{ ev: entry, tf: tfs.entry.label }, { ev: bias, tf: tfs.bias.label }]);
  const until = target ? ` toward the ${target.kind} at ${fmtPrice(target.price)}` : ' (no target area identified)';
  const triggerCandle = Number.isInteger(trigger.confirmedIndex) ? get(tfs.entry)[trigger.confirmedIndex] : null;
  const evidenceSnapshot = base.evidenceSnapshot;
  return {
    ...base, status: 'signal', action, target, invalidation, trigger, primaryModel: model, secondaryModels: modelSelection.secondary,
    qualifyingModelIds: [...new Set(modelSelection.candidates.map((candidate) => candidate.model_id))],
    confirmedAt: triggerCandle ? triggerCandle.epoch + tfs.entry.g : null, evidenceSnapshot,
    headline: `${label}: ${word} lean on ${tfs.bias.label} - ${action} on ${tfs.entry.label} - ${model.name} (${model.context})${until}; hold ${profile.holdLabel}, score at period end`,
  };
}

/** Display precision by magnitude (the feed's own decimals are not known here). */
export function fmtPrice(p) { const a = Math.abs(p); return p.toFixed(a >= 1000 ? 2 : a >= 100 ? 3 : a >= 1 ? 4 : 5); }
function summary(e) { return { verdict: e.verdict, balance: e.balance, overallBalance: e.overallBalance ?? e.balance, families: e.families || [] }; }
export function buildTradeSignalEvidenceSnapshot(evidence, granularity) {
  const candles = evidence.candles || [];
  const items = (evidence.items || []).map((item) => ({ ...item,
    occurredAt: item.occurredAt ?? (Number.isInteger(item.index) ? candles[item.index]?.epoch ?? null : null),
    confirmedAt: item.confirmedAt ?? (Number.isInteger(item.confirmedIndex) ? (candles[item.confirmedIndex]?.epoch ?? null) + granularity : null),
  }));
  for (const event of evidence.facts?.inducements || []) {
    const points = [
      { number: 1, index: event.minorPivot.index, confirmedIndex: event.minorPivot.confirmedIndex, price: event.level, label: 'Inducement minor pivot' },
      { number: 2, index: event.sweepIndex, confirmedIndex: event.sweepIndex, price: event.level, label: 'Inducement sweep' },
      { number: 3, index: event.displacementStartIndex, confirmedIndex: event.displacementIndex, price: event.level, label: 'Inducement displacement' },
      { number: 4, index: event.protectedPivot.index, confirmedIndex: event.protectedPivot.confirmedIndex, price: event.protectedLevel, label: 'Protected structural level' },
    ];
    for (const point of points) {
      if (!Number.isInteger(point.index) || !candles[point.index]) continue;
      items.push({ group: 'liquidity', family: 'liquidity', dir: event.direction, weight: 0.25, kind: 'fact', index: point.index,
        confirmedIndex: point.confirmedIndex, occurredAt: candles[point.index].epoch, confirmedAt: Number.isInteger(point.confirmedIndex) && candles[point.confirmedIndex] ? candles[point.confirmedIndex].epoch + granularity : null,
        label: point.label, price: point.price, sequenceNumber: point.number, snapshotKind: 'inducement' });
    }
  }
  return items;
}
