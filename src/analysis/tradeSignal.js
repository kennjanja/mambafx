// Trade-signal composer: turns the evidence engine's reading of a higher "bias" timeframe and a lower "entry"
// timeframe into one descriptive setup per market. Pure and deterministic.
//
//   bias  (30 min): must report a bullish/bearish lean, with 1 hour + 4 hour as higher-timeframe context
//   entry (5 min) : must not oppose the bias lean; supplies the target area and invalidation
//
// This is a rule-based reading of evidence. The evidence weights are provisional and unvalidated, so the output
// is NOT a forecast, a probability or a profitability claim.

import { analyzeEvidence } from './evidence.js';

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

// Entry triggers (entry-timeframe evidence agreeing with the bias direction) and exit reversals (opposing evidence).
function findTrigger(entry, dir) {
  const mine = entry.items.filter((i) => i.dir === dir);
  const loc = mine.find((i) => i.group === 'location'), lvl = mine.find((i) => i.group === 'level'), zone = mine.find((i) => i.group === 'zone');
  const liq = mine.find((i) => i.group === 'liquidity');
  if (liq) return { kind: 'sweep', label: liq.label };
  if (lvl) return { kind: 'pullback', label: lvl.label };
  if (zone) return { kind: 'pullback', label: zone.label };
  if (loc) return { kind: 'pullback', label: loc.label };
  return null;
}
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
export function buildTradeSignal({ symbol, label = symbol, candles = {}, profile = PROFILES.intraday, tfs = profile.tfs }) {
  const get = (t) => candles[t.g] || [];
  const htf = tfs.htf.map((h) => ({ tf: h.label, candles: get(h) })).filter((h) => h.candles.length >= 60);
  const bias = analyzeEvidence(get(tfs.bias), { htf });
  const entry = analyzeEvidence(get(tfs.entry), { htf: [{ tf: tfs.bias.label, candles: get(tfs.bias) }, ...htf].filter((h) => h.candles.length >= 60) });
  const base = { symbol, label, profile: profile.id, profileName: profile.name, holdSec: profile.holdSec, holdLabel: profile.holdLabel, entryG: tfs.entry.g, biasTf: tfs.bias.label, entryTf: tfs.entry.label, bias: summary(bias), entry: summary(entry), dir: 0, status: 'none' };
  if (!bias.sufficient || !entry.sufficient) {
    return { ...base, status: 'insufficient', reason: `not enough candles (${!bias.sufficient ? tfs.bias.label : tfs.entry.label})`, headline: `${label}: waiting for candle history` };
  }
  const dir = bias.verdict === 'bullish-lean' ? 1 : bias.verdict === 'bearish-lean' ? -1 : 0;
  const price = entry.facts.price;
  base.price = price;
  if (!dir) return { ...base, reason: `${tfs.bias.label} evidence is ${bias.verdict}`, headline: `${label}: no ${tfs.bias.label} lean` };
  base.dir = dir;
  const reversal = findReversal(entry, dir, get(tfs.entry));
  base.reversal = reversal;   // opposing evidence on the entry timeframe; used to exit a running trade early
  const word = dir === 1 ? 'BULLISH' : 'BEARISH', action = dir === 1 ? 'BUY' : 'SELL';
  const entryVerdictDir = entry.verdict === 'bullish-lean' ? 1 : entry.verdict === 'bearish-lean' ? -1 : 0;
  if (entryVerdictDir === -dir) {
    return { ...base, status: 'wait', action, reason: `${tfs.entry.label} evidence leans ${entryVerdictDir === 1 ? 'bullish' : 'bearish'}, against the ${tfs.bias.label} ${word.toLowerCase()} lean`, headline: `${label}: ${word} lean on ${tfs.bias.label}, but ${tfs.entry.label} opposes - wait` };
  }
  const pb = pickTarget(-dir, price, [{ ev: entry, tf: tfs.entry.label }, { ev: bias, tf: tfs.bias.label }]);
  const trigger = findTrigger(entry, dir);
  if (!trigger || reversal) {
    const lvl = pb ? ` near the ${pb.kind} at ${fmtPrice(pb.price)}` : '';
    return { ...base, status: 'watching', action, pullback: pb, reason: reversal ? `${tfs.entry.label} shows an opposing reversal (${reversal.label})` : 'no pullback or liquidity-sweep trigger yet',
      headline: `${label}: ${word} lean on ${tfs.bias.label} - WAIT on ${tfs.entry.label} for a ${dir === 1 ? 'pullback / swing low' : 'rally / swing high'}${lvl} or a liquidity sweep` };
  }
  const target = pickTarget(dir, price, [{ ev: entry, tf: tfs.entry.label }, { ev: bias, tf: tfs.bias.label }]);
  const sc = entry.scenarios.find((s) => s.dir === dir);
  const invalidation = sc && sc.invalidation ? { ...sc.invalidation, tf: tfs.entry.label } : null;
  const until = target ? ` until price reaches the ${target.kind} at ${fmtPrice(target.price)}` : ' (no target area identified)';
  return {
    ...base, status: 'signal', action, target, invalidation, trigger, exitOn: dir === 1 ? 'upthrust / bearish reversal' : 'spring / bullish reversal',
    headline: `${label}: ${word} lean on ${tfs.bias.label} - ${action} on ${tfs.entry.label} after ${trigger.kind === 'sweep' ? 'a liquidity sweep' : 'a pullback'} (${trigger.label})${until}, hold ${profile.holdLabel} or exit on ${dir === 1 ? 'an upthrust / bearish reversal' : 'a spring / bullish reversal'}`,
  };
}

/** Display precision by magnitude (the feed's own decimals are not known here). */
export function fmtPrice(p) { const a = Math.abs(p); return p.toFixed(a >= 1000 ? 2 : a >= 100 ? 3 : a >= 1 ? 4 : 5); }
function summary(e) { return { verdict: e.verdict, balance: e.balance }; }
