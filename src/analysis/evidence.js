// Phase 6: evidence engine. Synthesises the shared analysis modules into an interpretable,
// reproducible market state for the LATEST bar of the data it is given (pass a prefix to see an
// earlier bar). Pure and deterministic; analysis only, never an execution decision.
//
// Three kinds of output are kept apart:
//   facts            - things that were observed (events, zone states, levels)      `kind: 'fact'`
//   interpretations  - rule-based readings of facts, with explicit weights         `kind: 'interpretation'`
//   validated claims - NONE. Nothing here is calibrated, so `balance` is an
//                      evidence balance in [-1, 1], NOT a probability or win rate.
//
// Correlation control: items are assigned to a group, and each group contributes at most ONE signed
// value per side (its strongest item). A BOS, the displacement that caused it, and a breakout label
// all sit in the `break` group, so they count once.

import { sanitize, atrSeries, DEFAULTS } from './core.js';
import { analyze } from './engine.js';
import { analyzeZones } from './zones.js';
import { analyzePatterns } from './patterns.js';
import { analyzeLevels, premiumDiscount } from './levels.js';
import { aggregateEvidenceFamilies, FAMILY_WEIGHTS, detectTradingRanges } from './tradeSignalArchitecture.js';
import { classifySweep, detectInducements, INDUCEMENT_LIQUIDITY_FAMILY_VALUE } from './inducement.js';

export const EVIDENCE_DEFAULTS = Object.freeze({
  minCandles: 60,
  recentBars: 12,       // how far back an event still counts as "recent"
  nearAtr: 1.0,         // zone/level proximity in ATR
  decisionThreshold: 0.35, // |balance| needed before a lean is reported
  minAgreeingGroups: 2,
  weights: Object.freeze({ // transparent, editable; ranking weights, not probabilities
    structureBias: 2, break: 3, liquidity: 2, location: 1, zone: 2, candle: 1, level: 1, trend: 1.5, htf: 2,
  }),
});

const sign = (d) => (d > 0 ? 1 : d < 0 ? -1 : 0);

export function analyzeEvidence(input, opts = {}) {
  const O = { ...EVIDENCE_DEFAULTS, ...opts, weights: { ...EVIDENCE_DEFAULTS.weights, ...(opts.weights || {}) } };
  const { candles, dropped } = sanitize(input);
  const n = candles.length, last = n - 1;
  const limitations = [], missing = [];
  if (dropped) limitations.push(`${dropped} invalid candle(s) dropped`);
  if (n < O.minCandles) {
    return { sufficient: false, verdict: 'insufficient-data', balance: null, candles, items: [], groups: [], supporting: [], conflicting: [],
      conflicts: [], scenarios: [], facts: {}, limitations: [...limitations, `need >= ${O.minCandles} candles, have ${n}`], missing: ['all'],
      disclaimer: DISCLAIMER, dropped };
  }
  const atr = atrSeries(candles, DEFAULTS.atrPeriod), a = atr[last];
  const price = candles[last].close;
  const base = analyze(candles);
  const zonesRes = analyzeZones(base.candles, { atr: base.atr, structure: base });
  const pat = analyzePatterns(candles);
  const lv = analyzeLevels(candles);
  if (a == null) missing.push('atr');

  const items = [];
  const add = (group, dir, weight, label, extra = {}) => items.push({ group, dir, weight, label, kind: extra.kind || 'interpretation', ...extra });
  const recent = (i) => last - i <= O.recentBars;

  // --- structure bias (fact -> interpretation) and recent breaks
  const sw = base.swing.events, inn = base.internal.events;
  const lastSw = sw[sw.length - 1];
  if (lastSw) add('structure', lastSw.dir, O.weights.structureBias, `last swing ${lastSw.type} ${lastSw.dir === 1 ? 'up' : 'down'}`, { index: lastSw.index, confirmedIndex: lastSw.confirmedIndex ?? lastSw.index });
  else missing.push('swing-structure');
  const lastIn = inn[inn.length - 1];
  if (lastIn && lastSw && lastIn.dir !== lastSw.dir) add('structure', lastIn.dir, O.weights.structureBias * 0.5, `internal ${lastIn.type} against swing bias (possible pullback or shift)`, { index: lastIn.index, confirmedIndex: lastIn.confirmedIndex ?? lastIn.index });

  // `break` group: structure break, displacement, SOS/SOW and confirmed chart-pattern breaks are one thing
  const breaks = [];
  for (const e of [...sw, ...inn]) if (recent(e.index)) breaks.push({ dir: e.dir, w: e.type === 'CHoCH' ? 1 : 0.8, label: `${e.type}${e.mss ? '/MSS' : ''}`, index: e.index, confirmedIndex: e.confirmedIndex ?? e.index });
  for (const d of base.displacement) if (recent(d.index)) breaks.push({ dir: d.dir, w: 0.7, label: `displacement ${d.strength.toFixed(1)}×ATR`, index: d.index });
  for (const e of pat.wyckoff) if ((e.kind === 'SOS' || e.kind === 'SOW') && recent(e.index)) breaks.push({ dir: e.dir, w: 0.6, label: e.kind, index: e.index, confirmedIndex: e.confirmedIndex ?? e.index, family: 'wyckoff' });
  for (const p of pat.chart) if (p.status === 'confirmed' && p.breakIndex != null && recent(p.breakIndex)) breaks.push({ dir: p.dir, w: 0.6, label: `${p.kind} break`, index: p.breakIndex, confirmedIndex: p.confirmedIndex ?? p.breakIndex });
  for (const b of breaks) add('break', b.dir, O.weights.break * b.w, b.label, { index: b.index, confirmedIndex: b.confirmedIndex, family: b.family, kind: 'fact' });

  // --- liquidity: confirmed sweeps, springs/upthrusts (same group: both describe a stop run + reversal)
  for (const e of base.liquidity.events) {
    if (e.kind === 'sweep-confirmed' && recent(e.index)) {
      const dir = e.side === 'buy' ? -1 : 1;
      const classification = classifySweep(candles[e.index], { level: e.level, direction: dir, minorPivotConfirmed: e.source === 'pivot' && !e.majorLiquidity, majorLiquidity: !!e.majorLiquidity });
      add('liquidity', dir, O.weights.liquidity, `${e.side}-side liquidity swept then rejected`, { index: e.index, confirmedIndex: e.confirmedIndex ?? e.index, classification: classification.classification, kind: 'fact' });
    }
    if (e.kind === 'sweep-failed' && recent(e.index)) add('liquidity', e.side === 'buy' ? 1 : -1, O.weights.liquidity * 0.6, `${e.side}-side sweep accepted (continuation)`, { index: e.index, confirmedIndex: e.confirmedIndex ?? e.index, kind: 'fact' });
  }
  for (const e of pat.wyckoff) if ((e.kind === 'spring' || e.kind === 'upthrust') && recent(e.index)) add('liquidity', e.dir, O.weights.liquidity * 0.8, e.kind, { index: e.index, confirmedIndex: e.confirmedIndex ?? e.index, family: 'wyckoff', kind: 'fact' });

  // --- location: premium/discount (mean-reversion flavoured, deliberately weak)
  const pd = lv.premiumDiscount;
  if (pd) add('location', pd.zone === 'premium' ? -1 : pd.zone === 'discount' ? 1 : 0, O.weights.location, `price in ${pd.zone} of the latest swing range (${(pd.position * 100).toFixed(0)}%)`, { top: pd.top, bottom: pd.bottom, confirmedIndex: pd.confirmedIndex });
  else missing.push('premium-discount');

  // --- live zones near price: demand-like below/at price support, supply-like above/at price oppose
  const near = [];
  if (a != null) {
    for (const z of zonesRes.zones) {
      if (z.confirmedIndex == null || ['candidate', 'invalidated', 'expired', 'inverted', 'filled'].includes(z.status)) continue;
      const dist = price > z.top ? price - z.top : price < z.bottom ? z.bottom - price : 0;
      if (dist <= O.nearAtr * a) near.push({ z, dist });
    }
    near.sort((x, y) => x.dist - y.dist);
    const bestZ = near[0];
    if (bestZ) add('zone', bestZ.z.dir, O.weights.zone * (bestZ.dist === 0 ? 1 : 0.7), `${bestZ.z.kind} ${bestZ.z.dir === 1 ? 'bullish' : 'bearish'} ${bestZ.dist === 0 ? 'retest in progress' : 'nearby'}`, { index: bestZ.z.createdIndex, confirmedIndex: bestZ.z.confirmedIndex ?? bestZ.z.createdIndex, top: bestZ.z.top, bottom: bestZ.z.bottom, kind: 'fact' });
    for (const z of lv.supplyDemand) {
      if (z.status !== 'active') continue;
      const d = price > z.top ? price - z.top : price < z.bottom ? z.bottom - price : 0;
      if (d <= O.nearAtr * a) { add('zone', z.dir, O.weights.zone * 0.6, `${z.kind.toLowerCase()} zone nearby`, { index: z.createdIndex, confirmedIndex: z.confirmedIndex ?? z.createdIndex, top: z.top, bottom: z.bottom, kind: 'fact' }); break; }
    }
  }

  // --- candle pattern on the latest bars (low weight, one item: strongest/latest)
  const cp = pat.candle.filter((e) => e.dir !== 0 && recent(e.index) && last - e.index <= 2).pop();
  if (cp) add('candle', cp.dir, O.weights.candle, `${cp.name || cp.kind} on bar ${cp.index}`, { index: cp.index, confirmedIndex: cp.confirmedIndex ?? cp.index, kind: 'fact' });

  // --- level reaction: price just beyond a strong S/R zone with role flip
  if (a != null) {
    const srNear = lv.sr.filter((z) => z.status === 'active' && Math.abs(price - z.level) <= O.nearAtr * a).sort((x, y) => y.score - x.score)[0];
    if (srNear) add('level', srNear.role === 'support' ? 1 : -1, O.weights.level, `at ${srNear.role} (×${srNear.touches}${srNear.flips ? ', flipped' : ''})`, { index: srNear.createdIndex, confirmedIndex: srNear.confirmedIndex ?? srNear.createdIndex, price: srNear.level, top: srNear.level, bottom: srNear.level, kind: 'fact' });
  }

  // --- trend: EMA alignment (one item)
  const e20 = lv.emas[20][last], e50 = lv.emas[50][last];
  if (e20 != null && e50 != null) add('trend', e20 > e50 && price > e20 ? 1 : e20 < e50 && price < e20 ? -1 : 0, O.weights.trend, `EMA20 ${e20 > e50 ? '>' : '<'} EMA50, price ${price > e20 ? 'above' : 'below'} EMA20`);
  else missing.push('ema-trend');

  // --- higher timeframes (explicitly labelled; each is a separate item inside one group, strongest wins per side)
  const htfBias = [];
  for (const h of opts.htf || []) {
    const r = analyze(h.candles);
    const ev = r.swing.events[r.swing.events.length - 1];
    if (!ev || r.candles.length < O.minCandles) { missing.push(`htf:${h.tf}`); continue; }
    htfBias.push({ tf: h.tf, dir: ev.dir });
    add('htf', ev.dir, O.weights.htf, `${h.tf} swing bias ${ev.dir === 1 ? 'bullish' : 'bearish'} (${ev.type})`, { tf: h.tf, index: ev.index, confirmedIndex: ev.confirmedIndex ?? ev.index, kind: 'fact' });
  }

  // --- per-group aggregation: strongest bull and strongest bear; group value = bull - bear (never a sum)
  const groups = {};
  for (const it of items) {
    const g = (groups[it.group] ||= { group: it.group, bull: 0, bear: 0, bullItem: null, bearItem: null, max: 0 });
    g.max = Math.max(g.max, it.weight);
    if (it.dir === 1 && it.weight > g.bull) { g.bull = it.weight; g.bullItem = it.label; }
    if (it.dir === -1 && it.weight > g.bear) { g.bear = it.weight; g.bearItem = it.label; }
  }
  const glist = Object.values(groups).map((g) => ({ ...g, net: g.bull - g.bear, conflicted: g.bull > 0 && g.bear > 0 }));
  // fixed denominator (all configured group weights): sparse evidence must give a small balance, not +/-1
  const familyAgg = aggregateEvidenceFamilies(items, FAMILY_WEIGHTS, O.weights);
  const balance = familyAgg.balance;
  const bullGroups = glist.filter((g) => g.net > 0).length, bearGroups = glist.filter((g) => g.net < 0).length;

  const conflicts = [];
  for (const g of glist) if (g.conflicted) conflicts.push(`${g.group}: "${g.bullItem}" vs "${g.bearItem}"`);
  if (bullGroups && bearGroups) conflicts.push(`${bullGroups} bullish group(s) vs ${bearGroups} bearish group(s)`);
  const modelEvents = [];
  if (lastSw) modelEvents.push({ type: 'trend-established', dir: lastSw.dir, index: lastSw.index, confirmedIndex: lastSw.confirmedIndex ?? lastSw.index, label: 'confirmed swing trend' });
  for (const e of [...sw, ...inn]) {
    const confirmedIndex = e.confirmedIndex ?? e.index;
    if (e.type === 'BOS') {
      modelEvents.push({ type: 'bos', dir: e.dir, index: e.index, confirmedIndex, level: e.level, label: e.type });
      for (let j = confirmedIndex + 1; j <= last; j++) {
        const c = candles[j];
        if (e.dir === 1 && c.low <= e.level && c.close > e.level) modelEvents.push({ type: 'broken-level-retest', dir: 1, index: j, confirmedIndex: j, level: e.level, label: 'bullish broken-level retest' });
        if (e.dir === -1 && c.high >= e.level && c.close < e.level) modelEvents.push({ type: 'broken-level-retest', dir: -1, index: j, confirmedIndex: j, level: e.level, label: 'bearish broken-level retest' });
      }
    }
    if (e.type === 'CHoCH' || e.mss) modelEvents.push({ type: 'structure-shift', dir: e.dir, index: e.index, confirmedIndex, label: e.mss ? 'CHoCH/MSS' : e.type });
    if (e.type === 'CHoCH') modelEvents.push({ type: 'opposite-structure', dir: e.dir, index: e.index, confirmedIndex, label: e.type });
  }
  for (const d of base.displacement) modelEvents.push({ type: 'displacement', dir: d.dir, index: d.index, confirmedIndex: d.confirmedIndex ?? d.index, label: 'displacement' });
  for (const e of base.liquidity.events) if (e.kind === 'sweep-candidate') {
    const dir = e.side === 'buy' ? -1 : 1, candle = candles[e.index];
    const classification = classifySweep(candle, { level: e.level, direction: dir, minorPivotConfirmed: e.source === 'pivot' && !e.majorLiquidity, majorLiquidity: !!e.majorLiquidity });
    if (classification.classification === 'significant-liquidity') {
      const sweepEvent = { type: 'significant-sweep', dir, index: e.index, confirmedIndex: e.confirmedIndex, level: e.level, source: e.source, classification: classification.classification, context: 'swing', label: `significant ${e.side}-side sweep` };
      modelEvents.push(sweepEvent);
      const eventPd = premiumDiscount(candles.slice(0, e.index + 1));
      if (eventPd && ((dir === 1 && eventPd.zone === 'discount') || (dir === -1 && eventPd.zone === 'premium'))) modelEvents.push({ ...sweepEvent, context: 'dealing-range', label: `${sweepEvent.label} in ${eventPd.zone}` });
    }
  }
  const inducements = detectInducements(candles, { granularity: opts.granularity || 60, structure: base });
  for (const event of inducements) {
    if (event.state !== 'confirmed') continue;
    const sequenceEvents = [
      { type: 'minor-pivot-confirmed', dir: event.direction, index: event.minorPivot.index, confirmedIndex: event.minorPivot.confirmedIndex, level: event.level, label: 'minor inducement pivot' },
      { type: 'minor-inducement-sweep', dir: event.direction, index: event.sweepIndex, confirmedIndex: event.sweepIndex, level: event.level, classification: event.sharedSweepClassification.classification, label: 'minor inducement sweep' },
      { type: 'inducement-displacement', dir: event.direction, index: event.displacementIndex, confirmedIndex: event.displacementIndex, level: event.level, label: 'post-sweep continuation displacement' },
    ];
    event.sequenceEvents = sequenceEvents;
    modelEvents.push({ type: 'inducement-confirmed', dir: event.direction, index: event.displacementIndex, confirmedIndex: event.displacementIndex, level: event.level, state: 'confirmed', classification: event.sharedSweepClassification.classification, sequenceEvents, evidence: event, label: 'confirmed minor inducement' });
    add('liquidity', event.direction, O.weights.liquidity * INDUCEMENT_LIQUIDITY_FAMILY_VALUE, 'confirmed minor inducement (provisional heuristic)', { index: event.sweepIndex, confirmedIndex: event.displacementIndex, family: 'liquidity', kind: 'fact', level: event.level, inducement: event });
  }
  for (const z of zonesRes.zones) {
    if (z.kind === 'OB' && z.confirmedIndex != null) modelEvents.push({ type: 'ob-confirmed-for-breaker', dir: -z.dir, index: z.createdIndex, confirmedIndex: z.confirmedIndex, level: z.bottom, label: 'valid order block before breaker' });
    if (z.kind === 'OB' && z.confirmedIndex != null && !['invalidated', 'expired', 'candidate'].includes(z.status)) {
      modelEvents.push({ type: 'ob-confirmed', dir: z.dir, index: z.createdIndex, confirmedIndex: z.confirmedIndex, level: z.bottom, label: 'valid order block' });
      if (z.firstMitigationIndex != null) modelEvents.push({ type: 'ob-retest', dir: z.dir, index: z.firstMitigationIndex, confirmedIndex: z.firstMitigationIndex, level: z.bottom, label: 'order block retest' });
    }
    if (z.kind === 'OB' && z.status === 'invalidated') {
      const broken = (z.history || []).find((h) => h.status === 'invalidated');
      if (broken) modelEvents.push({ type: 'ob-break', dir: -z.dir, index: broken.index, confirmedIndex: broken.index, level: z.bottom, label: 'order block failed' });
    }
    if (z.kind === 'BREAKER' && z.confirmedIndex != null) {
      modelEvents.push({ type: 'breaker-retest', dir: z.dir, index: z.firstMitigationIndex ?? z.confirmedIndex, confirmedIndex: z.firstMitigationIndex ?? z.confirmedIndex, level: z.bottom, label: 'breaker retest' });
    }
    if (z.kind === 'FVG' && z.confirmedIndex != null && !['invalidated', 'expired', 'filled'].includes(z.status)) {
      modelEvents.push({ type: 'fvg-created', dir: z.dir, index: z.createdIndex, confirmedIndex: z.confirmedIndex, level: z.bottom, label: 'FVG created' });
      if (z.firstMitigationIndex != null) modelEvents.push({ type: 'fvg-retest', dir: z.dir, index: z.firstMitigationIndex, confirmedIndex: z.firstMitigationIndex, level: z.bottom, label: 'FVG retest' });
    }
  }
  for (const e of pat.wyckoff) {
    if (e.kind === 'SOS' || e.kind === 'SOW') modelEvents.push({ type: 'sos-or-sow', dir: e.dir, index: e.index, confirmedIndex: e.confirmedIndex ?? e.index, label: e.kind });
    if (e.kind === 'spring' || e.kind === 'upthrust') {
      const classification = classifySweep(candles[e.index], { level: e.level, direction: e.dir, majorLiquidity: true });
      if (classification.classification === 'significant-liquidity') modelEvents.push({ type: 'significant-sweep', dir: e.dir, index: e.index, confirmedIndex: e.confirmedIndex ?? e.index, context: 'range', classification: classification.classification, label: e.kind });
    }
  }
  const ranges = detectTradingRanges(candles, { atr: base.atr });
  for (const r of ranges.ranges) modelEvents.push({ type: 'range-established', dir: 0, index: r.startIndex, confirmedIndex: r.confirmedIndex, level: r.high, label: 'trading range established' });
  for (const e of ranges.events) {
    if (e.type === 'LPS' || e.type === 'LPSY') modelEvents.push({ type: 'lps-or-lpsy', dir: e.dir, index: e.index, confirmedIndex: e.confirmedIndex, level: e.level, label: e.type });
    if (e.type === 'SOS' || e.type === 'SOW') modelEvents.push({ type: 'sos-or-sow', dir: e.dir, index: e.index, confirmedIndex: e.confirmedIndex, level: e.level, label: e.type });
  }
  for (const it of items) if (it.group === 'candle' && Number.isInteger(it.index)) modelEvents.push({ type: 'reaction', dir: it.dir, index: it.index, confirmedIndex: it.confirmedIndex ?? it.index, label: it.label });
  modelEvents.sort((x, y) => x.confirmedIndex - y.confirmedIndex || x.type.localeCompare(y.type));
  const timedModelEvents = modelEvents.map((event) => ({ ...event, occurredAt: candles[event.index]?.epoch ?? null, confirmedAt: candles[event.confirmedIndex]?.epoch == null ? null : candles[event.confirmedIndex].epoch + (opts.granularity || 0) }));

  const htfDirs = new Set(htfBias.map((h) => h.dir));
  if (htfDirs.size > 1) conflicts.push('multi-timeframe: higher timeframes disagree with each other');
  if (htfDirs.size === 1 && lastSw && !htfDirs.has(lastSw.dir)) conflicts.push(`multi-timeframe: this timeframe's swing bias is ${lastSw.dir === 1 ? 'bullish' : 'bearish'} but higher timeframe(s) are ${[...htfDirs][0] === 1 ? 'bullish' : 'bearish'}`);

  let verdict = 'inconclusive';
  if (Math.abs(balance) >= O.decisionThreshold) {
    const agree = balance > 0 ? bullGroups : bearGroups;
    if (agree >= O.minAgreeingGroups) verdict = balance > 0 ? 'bullish-lean' : 'bearish-lean';
  }
  // multi-timeframe conflict caps a lean to inconclusive: do not force a conclusion
  if (verdict !== 'inconclusive' && conflicts.some((c) => c.startsWith('multi-timeframe'))) verdict = 'inconclusive';
  if (a == null) verdict = 'inconclusive';

  // --- scenarios, invalidation and targets (descriptive price areas, not predictions)
  const pools = base.liquidity.pools.filter((p) => p.status === 'active' && !p.pending);
  const above = pools.filter((p) => p.level > price).sort((x, y) => x.level - y.level)[0];
  const below = pools.filter((p) => p.level < price).sort((x, y) => y.level - x.level)[0];
  const lastSwingLow = [...base.swing.pivots.confirmed].reverse().find((p) => p.type === 'low' && p.confirmedIndex <= last);
  const lastSwingHigh = [...base.swing.pivots.confirmed].reverse().find((p) => p.type === 'high' && p.confirmedIndex <= last);
  const srAbove = lv.sr.filter((z) => z.status === 'active' && z.level > price).sort((x, y) => x.level - y.level)[0];
  const srBelow = lv.sr.filter((z) => z.status === 'active' && z.level < price).sort((x, y) => y.level - x.level)[0];
  const scenarios = [
    { dir: 1, supported: verdict === 'bullish-lean', invalidation: lastSwingLow ? { price: lastSwingLow.price, rule: 'close below latest confirmed swing low' } : null,
      targets: [above && { price: above.level, why: 'liquidity pool above' }, srAbove && { price: srAbove.level, why: 'S/R above' }, pd && { price: pd.top, why: 'swing range high' }].filter(Boolean) },
    { dir: -1, supported: verdict === 'bearish-lean', invalidation: lastSwingHigh ? { price: lastSwingHigh.price, rule: 'close above latest confirmed swing high' } : null,
      targets: [below && { price: below.level, why: 'liquidity pool below' }, srBelow && { price: srBelow.level, why: 'S/R below' }, pd && { price: pd.bottom, why: 'swing range low' }].filter(Boolean) },
  ];

  // Supporting/conflicting only exist relative to a reported lean; without one both sides are listed neutrally.
  const byWeight = (x, y) => y.weight - x.weight;
  const bullishItems = items.filter((i) => i.dir === 1).sort(byWeight), bearishItems = items.filter((i) => i.dir === -1).sort(byWeight);
  const lean = verdict === 'bullish-lean' ? 1 : verdict === 'bearish-lean' ? -1 : 0;
  const supporting = lean === 1 ? bullishItems : lean === -1 ? bearishItems : [];
  const conflicting = lean === 1 ? bearishItems : lean === -1 ? bullishItems : [];

  limitations.push('balance is a weighted evidence balance, not a probability; weights are PROVISIONAL: heuristic, untuned and unvalidated');
  limitations.push('VWAP and volume-profile layers are price/time proxies (no traded volume in the feed); they are drawn on charts but are not inputs to this balance');
  limitations.push('families are correlated, not independent; structure and break evidence share one family, while EMA trend, higher-timeframe context and location remain heuristic context');
  if (!(opts.htf || []).length) limitations.push('no higher-timeframe data supplied: multi-timeframe alignment not assessed');

  const timedItems = items.map((item) => {
    const ix = Number.isInteger(item.index) ? item.index : last;
    const cx = Number.isInteger(item.confirmedIndex) ? item.confirmedIndex : ix;
    const series = opts.htf?.find((h) => h.tf === item.tf)?.candles || candles;
    const g = opts.htf?.find((h) => h.tf === item.tf)?.g || opts.granularity || 0;
    return { ...item, occurredAt: series[ix] ? series[ix].epoch : null, confirmedAt: series[cx] ? series[cx].epoch + g : null };
  });
  return {
    sufficient: true, verdict, balance, overallBalance: balance, candles, families: familyAgg.families, groups: glist, items: timedItems, supporting: lean === 1 ? timedItems.filter((i) => i.dir === 1).sort(byWeight) : lean === -1 ? timedItems.filter((i) => i.dir === -1).sort(byWeight) : [], conflicting: lean === 1 ? timedItems.filter((i) => i.dir === -1).sort(byWeight) : lean === -1 ? timedItems.filter((i) => i.dir === 1).sort(byWeight) : [], bullishItems: timedItems.filter((i) => i.dir === 1).sort(byWeight), bearishItems: timedItems.filter((i) => i.dir === -1).sort(byWeight), conflicts, scenarios, missing, limitations, dropped,
    facts: {
      price, atr: a, swingBias: lastSw ? lastSw.dir : 0, premiumDiscount: pd && { zone: pd.zone, position: pd.position },
      regime: pat.volatility.series[last]?.regime ?? 'unknown', squeeze: pat.volatility.series[last]?.squeeze ?? null,
      nearZones: near.slice(0, 5).map((x) => ({ kind: x.z.kind, dir: x.z.dir, status: x.z.status, top: x.z.top, bottom: x.z.bottom, distance: x.dist })),
      recentEvents: [...sw, ...inn].filter((e) => recent(e.index)).map((e) => ({ type: e.type, dir: e.dir, index: e.index, confirmedIndex: e.confirmedIndex ?? e.index, scale: sw.includes(e) ? 'swing' : 'internal' })),
      modelEvents: timedModelEvents, inducements, ranges, htf: htfBias,
    },
    disclaimer: DISCLAIMER,
  };
}

const DISCLAIMER = 'Rule-based description of current evidence. Not a forecast, not a probability, not a trade instruction.';
