// Trade Signal's orchestration primitives. All detectors remain in the shared analysis engine.

export const FAMILY_WEIGHTS = Object.freeze({
  structure: 1.5, liquidity: 1.25, momentum: 1.25, location: 0.75, zones: 1,
  wyckoff: 0.75, htf: 0.75,
});
export const EVIDENCE_FAMILY_MAP = Object.freeze({
  structure: 'structure', break: 'structure', liquidity: 'liquidity', location: 'location',
  zone: 'zones', candle: 'momentum', level: 'location', trend: 'momentum', htf: 'htf',
});

export function aggregateEvidenceFamilies(items = [], weights = FAMILY_WEIGHTS, sourceWeights = null) {
  const families = Object.fromEntries(Object.keys(weights).map((family) => [family, { family, bull: 0, bear: 0, bullItem: null, bearItem: null, value: 0, weight: weights[family] }]));
  for (const item of items) {
    const family = item.family || EVIDENCE_FAMILY_MAP[item.group];
    const f = families[family];
    if (!f || !Number.isFinite(item.weight)) continue;
    const value = sourceWeights && sourceWeights[item.group] ? item.weight / sourceWeights[item.group] : item.weight;
    if (item.dir === 1 && value > f.bull) { f.bull = value; f.bullItem = item.label; }
    if (item.dir === -1 && value > f.bear) { f.bear = value; f.bearItem = item.label; }
  }
  for (const f of Object.values(families)) f.value = f.bull - f.bear;
  const denominator = Object.values(weights).reduce((sum, weight) => sum + weight, 0);
  return { families: Object.values(families), balance: denominator ? Object.values(families).reduce((sum, f) => sum + f.value * f.weight, 0) / denominator : 0 };
}

export const WATCHING_EXPIRY_SEC = Object.freeze({ scalp: 15 * 60, intraday: 2 * 3600, swing: 6 * 3600 });
export const LIFECYCLE_STATES = Object.freeze(['No Setup', 'Bias Identified', 'Watching', 'Approaching Location', 'Trigger Detected', 'Signal Active', 'Closed']);
export const TERMINAL_STATES = Object.freeze(['Invalidated Before Entry', 'Expired Without Entry', 'Opposed', 'Insufficient Data']);
const TRANSITIONS = Object.freeze({
  'No Setup': ['Bias Identified', 'Insufficient Data'],
  'Bias Identified': ['Watching', 'Opposed', 'Insufficient Data', 'No Setup'],
  Watching: ['Approaching Location', 'Expired Without Entry', 'Opposed', 'Insufficient Data', 'No Setup'],
  'Approaching Location': ['Trigger Detected', 'Watching', 'Expired Without Entry', 'Opposed', 'Insufficient Data'],
  'Trigger Detected': ['Signal Active', 'Invalidated Before Entry', 'Opposed', 'Insufficient Data'],
  'Signal Active': ['Closed', 'Opposed', 'Insufficient Data'],
});
export function transitionLifecycle(record, next, at, reason = '') {
  const current = record.state || 'No Setup';
  if (current === next) return record;
  if (TERMINAL_STATES.includes(current)) throw new Error(`terminal lifecycle state ${current}`);
  if (!TRANSITIONS[current]?.includes(next)) throw new Error(`invalid lifecycle transition ${current} -> ${next}`);
  if (!Number.isFinite(at)) throw new TypeError('lifecycle transition requires a timestamp');
  const event = { from: current, to: next, at, reason };
  record.state = next;
  record.lifecycleHistory = [...(record.lifecycleHistory || []), event];
  return record;
}

// Fixed definitions are ordered compositions of shared detector events, never duplicate detectors:
// A: HTF direction -> significant liquidity approach/sweep -> directional displacement -> CHoCH/MSS.
// B: HTF direction -> displacement/BOS -> confirmed OB pullback -> entry-timeframe reaction.
// C: directional context -> displacement-created FVG -> FVG retrace -> reaction.
// D: valid OB -> OB failure -> opposite structure -> failed-OB retest -> reaction.
// F: established trend -> minor countertrend swing/sweep -> continuation displacement.
// G: entry-timeframe BOS -> displacement -> retest of that broken level -> hold/reaction.
// J: fixed trading range -> SOS/LPS or SOW/LPSY continuation.
const MODEL_DEFINITIONS = [
  { model_id: 'A', name: 'Liquidity Sweep Reversal', classification: 'reversal', context: 'swing', sequence: ['significant-sweep', 'displacement', 'structure-shift'], requiredEvidence: ['significant liquidity', 'displacement', 'CHoCH/MSS'], invalidation: 'beyond the swept swing', layer1: 'higher-timeframe bias supports the reversal direction', layer2: 'direction-aligned location contains the significant swept swing level', layer3: 'significant sweep -> directional displacement -> confirmed CHoCH/MSS', priority: 'confirming events, then nearest invalidation, then ID' },
  { model_id: 'B', name: 'Order Block Continuation', classification: 'continuation', context: 'trend', sequence: ['displacement', 'bos', 'ob-retest', 'reaction'], requiredEvidence: ['displacement', 'BOS', 'valid OB', 'reaction'], invalidation: 'beyond the OB', layer1: 'higher-timeframe bias and entry structure support the continuation direction', layer2: 'direction-aligned location contains the confirmed OB retest level', layer3: 'displacement -> BOS -> confirmed OB pullback -> reaction' },
  { model_id: 'C', name: 'FVG Continuation', classification: 'continuation', context: 'trend', sequence: ['displacement', 'fvg-created', 'fvg-retest', 'reaction'], requiredEvidence: ['displacement', 'FVG', 'reaction'], invalidation: 'beyond the FVG', layer1: 'higher-timeframe bias and entry structure support the continuation direction', layer2: 'direction-aligned location contains the confirmed FVG retest level', layer3: 'displacement -> FVG created -> FVG retest -> reaction' },
  { model_id: 'D', name: 'Breaker Block Reversal', classification: 'reversal', context: 'trend', sequence: ['ob-confirmed-for-breaker', 'ob-break', 'opposite-structure', 'breaker-retest', 'reaction'], requiredEvidence: ['valid OB', 'OB break', 'opposite structure', 'reaction'], invalidation: 'beyond the failed OB', layer1: 'higher-timeframe bias supports the reversal direction', layer2: 'direction-aligned location contains the confirmed breaker retest level', layer3: 'valid OB -> OB failure -> opposite structure -> breaker retest -> reaction' },
  { model_id: 'F', name: 'Inducement Sweep Continuation', classification: 'continuation', context: 'trend', sequence: ['inducement-confirmed'], requiredEvidence: ['confirmed minor pivot', 'same-candle wick-and-close sweep', 'later continuation displacement'], invalidation: 'protected level or pre-entry opposing CHoCH', layer1: 'higher-timeframe bias agrees and entry structure continues in the same direction', layer2: 'a direction-aligned pullback location contains the minor inducement level', layer3: 'dedicated detector confirms pivot -> sweep -> later displacement' },
  { model_id: 'G', name: 'BOS Pullback Continuation', classification: 'continuation', context: 'trend', sequence: ['bos', 'displacement', 'broken-level-retest', 'reaction'], requiredEvidence: ['entry-timeframe BOS', 'displacement', 'broken-level retest', 'reaction'], invalidation: 'beyond the broken level', layer1: 'higher-timeframe bias and entry structure support the continuation direction', layer2: 'direction-aligned location contains the broken-level retest', layer3: 'entry-timeframe BOS -> displacement -> broken-level retest -> reaction' },
  { model_id: 'J', name: 'Wyckoff SOS/SOW Continuation', classification: 'continuation', context: 'range', sequence: ['range-established', 'sos-or-sow', 'lps-or-lpsy'], requiredEvidence: ['trading range', 'SOS/SOW', 'LPS/LPSY'], invalidation: 'beyond the range boundary', layer1: 'higher-timeframe bias and entry structure support the continuation direction', layer2: 'direction-aligned location contains the LPS/LPSY retest level', layer3: 'fixed trading range -> SOS/SOW -> LPS/LPSY' },
];
const MODEL_PRIORITY = 'most confirming ordered events, then nearest valid invalidation, then deterministic model-ID order';
export const MODEL_REGISTRY = Object.freeze(MODEL_DEFINITIONS.map((model) => Object.freeze({ ...model, directionRule: model.classification === 'reversal' ? 'higher-timeframe bias must support proposed direction' : 'entry-timeframe structure must support proposed direction', priority: MODEL_PRIORITY, layer1: model.layer1 || (model.classification === 'reversal' ? 'higher-timeframe bias supports reversal direction' : 'directional structure supports continuation'), layer2: model.layer2 || 'direction-aligned model context/location must be present', layer3: model.layer3 || `confirmed ordered sequence: ${model.sequence.join(' then ')}`, reasonText: `${model.name}: ${model.sequence.join(' then ')}` })));

function isOpposed(a, b) { return a && b && a !== b; }
function orderedSequence(events, sequence, dir) {
  let cursor = -Infinity; const matches = [];
  for (const type of sequence) {
    const found = events.filter((event) => event.type === type && event.confirmedIndex >= cursor && (event.dir == null || event.dir === 0 || event.dir === dir)).sort((a, b) => a.confirmedIndex - b.confirmedIndex)[0];
    if (!found) return null;
    matches.push(found); cursor = found.confirmedIndex;
  }
  return matches;
}

export function evaluateEntryModels({ events = [], biasDirection = 0, entryDirection = 0, locations = [], nearestInvalidationDistance = Infinity, asOfIndex = Infinity, marketContext = 'trend', preEntryInvalidated = false, expired = false } = {}) {
  if (preEntryInvalidated || expired) return { primary: null, secondary: [], candidates: [] };
  const activeEvents = events.filter((event) => Number.isFinite(event.confirmedIndex) && event.confirmedIndex <= asOfIndex);
  const candidates = [];
  for (const model of MODEL_REGISTRY) {
    const dirs = [1, -1].filter((dir) => biasDirection === dir && (model.classification === 'reversal' || entryDirection === dir));
    for (const direction of dirs) {
      const contextAllowed = Array.isArray(marketContext) ? marketContext.includes(model.context) : model.context === marketContext;
      if (model.model_id !== 'A' && !contextAllowed) continue;
      if (model.classification === 'reversal' && isOpposed(biasDirection, direction)) continue;
      if (model.classification === 'continuation' && isOpposed(entryDirection, direction)) continue;
      const alignedLocations = locations.filter((location) => location && (location.dir == null || location.dir === direction));
      if (!alignedLocations.length) continue;
      const contexts = model.model_id === 'A' ? ['swing', 'range', 'dealing-range'] : [model.context];
      for (const context of contexts) {
        const scopedEvents = model.model_id === 'A'
          ? activeEvents.filter((event) => event.type !== 'significant-sweep' || (event.context || 'swing') === context)
          : activeEvents;
        const matched = orderedSequence(scopedEvents, model.sequence, direction);
        if (!matched) continue;
        if (model.model_id === 'A' && !matched.some((event) => event.type === 'significant-sweep' && event.classification === 'significant-liquidity' && event.dir === direction && (event.context || 'swing') === context)) continue;
        const locationEvent = ({ A: 'significant-sweep', B: 'ob-retest', C: 'fvg-retest', D: 'breaker-retest', F: 'inducement-confirmed', G: 'broken-level-retest', J: 'lps-or-lpsy' })[model.model_id];
        const relevantLocationLevel = matched.find((event) => event.type === locationEvent)?.level;
        if (!Number.isFinite(relevantLocationLevel) || !alignedLocations.some((location) => Number.isFinite(location.top) && Number.isFinite(location.bottom)
          && relevantLocationLevel <= location.top && relevantLocationLevel >= location.bottom)) continue;
        if (model.model_id === 'F') {
          const inducement = matched.find((event) => event.type === 'inducement-confirmed' && event.state === 'confirmed' && event.classification === 'minor-inducement-liquidity');
          const requiredSequence = ['minor-pivot-confirmed', 'minor-inducement-sweep', 'inducement-displacement'];
          if (!inducement || !inducement.sequenceEvents || inducement.sequenceEvents.length !== requiredSequence.length
            || inducement.sequenceEvents.some((event, index) => event.type !== requiredSequence[index] || event.dir !== direction || event.confirmedIndex > inducement.confirmedIndex || (index > 0 && event.confirmedIndex <= inducement.sequenceEvents[index - 1].confirmedIndex))
            || inducement.sequenceEvents[1].classification !== 'minor-inducement-liquidity') continue;
          const level = inducement.level;
          if (level !== relevantLocationLevel) continue;
        }
        candidates.push({ model_id: model.model_id, name: model.name, context, direction, classification: model.classification,
          confirmingEvents: model.model_id === 'F' ? matched[0].sequenceEvents : matched, confirmingEventCount: model.model_id === 'F' ? matched[0].sequenceEvents.length : matched.length, invalidationDistance: Number.isFinite(nearestInvalidationDistance) ? nearestInvalidationDistance : Infinity,
          reason: `${model.name}: ${matched.map((event) => event.label || event.type).join(' then ')}`, location: alignedLocations.find((location) => relevantLocationLevel <= location.top && relevantLocationLevel >= location.bottom) || alignedLocations[0] || null });
      }
    }
  }
  candidates.sort((a, b) => b.confirmingEventCount - a.confirmingEventCount || a.invalidationDistance - b.invalidationDistance || a.model_id.localeCompare(b.model_id) || a.context.localeCompare(b.context));
  return { primary: candidates[0] || null, secondary: candidates.slice(1), candidates };
}

/** Causal, rolling dealing ranges and their SOS/SOW/LPS/LPSY events. Input must contain closed candles only. */
export function detectTradingRanges(candles = [], { lookback = 20, maxRangeAtr = 8, retestAtr = 0.25, maxRetestBars = 30, atr = [] } = {}) {
  const ranges = [], events = [];
  let active = null;
  for (let i = lookback; i < candles.length; i++) {
    const c = candles[i], a = atr[i - 1];
    if (!Number.isFinite(a) || a <= 0) continue;
    if (active && active.status === 'active') {
      const body = Math.abs(c.close - c.open);
      if (c.close > active.high && body >= 1.5 * a) {
        active.status = 'broken-up'; active.breakoutIndex = i;
        events.push({ type: 'SOS', dir: 1, index: i, confirmedIndex: i, level: active.high, range: { ...active } });
      } else if (c.close < active.low && body >= 1.5 * a) {
        active.status = 'broken-down'; active.breakoutIndex = i;
        events.push({ type: 'SOW', dir: -1, index: i, confirmedIndex: i, level: active.low, range: { ...active } });
      }
      continue;
    }
    if (active && ['broken-up', 'broken-down'].includes(active.status)) {
      const age = i - active.breakoutIndex;
      if (age > maxRetestBars) { active.status = 'expired'; active.endIndex = i; active = null; }
      else if (active.status === 'broken-up') {
        if (c.close < active.low) { active.status = 'invalidated'; active.endIndex = i; active = null; }
        else if (i > active.breakoutIndex && c.low <= active.high + retestAtr * a && c.close > active.high) {
          active.status = 'complete'; active.endIndex = i;
          events.push({ type: 'LPS', dir: 1, index: i, confirmedIndex: i, level: active.high, range: { ...active } });
        }
      } else if (active.status === 'broken-down') {
        if (c.close > active.high) { active.status = 'invalidated'; active.endIndex = i; active = null; }
        else if (i > active.breakoutIndex && c.high >= active.low - retestAtr * a && c.close < active.low) {
          active.status = 'complete'; active.endIndex = i;
          events.push({ type: 'LPSY', dir: -1, index: i, confirmedIndex: i, level: active.low, range: { ...active } });
        }
      }
      continue;
    }
    const window = candles.slice(i - lookback, i);
    const high = Math.max(...window.map((bar) => bar.high)), low = Math.min(...window.map((bar) => bar.low));
    if (high - low > maxRangeAtr * a) continue;
    active = { high, low, startIndex: i - lookback, confirmedIndex: i, endIndex: null, status: 'active' };
    ranges.push({ ...active });
    events.push({ type: 'range-established', dir: 0, index: active.startIndex, confirmedIndex: active.confirmedIndex, level: high, range: { ...active }, label: 'trading range established' });
    const body = Math.abs(c.close - c.open);
    if (c.close > active.high && body >= 1.5 * a) {
      active.status = 'broken-up'; active.breakoutIndex = i;
      events.push({ type: 'SOS', dir: 1, index: i, confirmedIndex: i, level: active.high, range: { ...active } });
    } else if (c.close < active.low && body >= 1.5 * a) {
      active.status = 'broken-down'; active.breakoutIndex = i;
      events.push({ type: 'SOW', dir: -1, index: i, confirmedIndex: i, level: active.low, range: { ...active } });
    }
  }
  return { ranges, events };
}

export function evaluateLayers({ bias, entry, locationEvidence = [], models = [] }) {
  const direction = bias?.verdict === 'bullish-lean' ? 1 : bias?.verdict === 'bearish-lean' ? -1 : 0;
  const biasResult = { status: !bias?.sufficient ? 'Insufficient data' : direction ? (direction > 0 ? 'Bullish' : 'Bearish') : 'Inconclusive', direction, evidence: bias?.items || [], reason: bias?.verdict || 'insufficient data' };
  const validLocations = locationEvidence.filter((item) => item && (item.dir == null || item.dir === direction));
  const alignedModels = models.filter((model) => model && (model.direction == null || model.direction === direction));
  const locationResult = { status: validLocations.length ? 'Approaching Location' : 'Watching', direction, evidence: validLocations, reason: validLocations.length ? 'price is near a context-aligned location' : 'waiting for a qualifying location' };
  const entryResult = { status: alignedModels.length ? 'Trigger Detected' : 'Watching', direction, evidence: alignedModels, reason: alignedModels.length ? 'ordered entry model confirmed' : 'waiting for ordered entry confirmation' };
  const ready = biasResult.status === 'Bullish' || biasResult.status === 'Bearish';
  const signal = ready && validLocations.length > 0 && alignedModels.length > 0;
  return { bias: biasResult, location: locationResult, entry: entryResult, signal, missingLayer: !ready ? 'Directional Bias' : !validLocations.length ? 'Location Gate' : !alignedModels.length ? 'Entry Confirmation' : null };
}
