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
export function buildTradeSignal({ symbol, label = symbol, candles = {}, tfs = TRADE_SIGNAL_TFS }) {
  const get = (t) => candles[t.g] || [];
  const htf = tfs.htf.map((h) => ({ tf: h.label, candles: get(h) })).filter((h) => h.candles.length >= 60);
  const bias = analyzeEvidence(get(tfs.bias), { htf });
  const entry = analyzeEvidence(get(tfs.entry), { htf: [{ tf: tfs.bias.label, candles: get(tfs.bias) }, ...htf].filter((h) => h.candles.length >= 60) });
  const base = { symbol, label, biasTf: tfs.bias.label, entryTf: tfs.entry.label, bias: summary(bias), entry: summary(entry), dir: 0, status: 'none' };
  if (!bias.sufficient || !entry.sufficient) {
    return { ...base, status: 'insufficient', reason: `not enough candles (${!bias.sufficient ? tfs.bias.label : tfs.entry.label})`, headline: `${label}: waiting for candle history` };
  }
  const dir = bias.verdict === 'bullish-lean' ? 1 : bias.verdict === 'bearish-lean' ? -1 : 0;
  const price = entry.facts.price;
  base.price = price;
  if (!dir) return { ...base, reason: `${tfs.bias.label} evidence is ${bias.verdict}`, headline: `${label}: no ${tfs.bias.label} lean` };
  base.dir = dir;
  const word = dir === 1 ? 'BULLISH' : 'BEARISH', action = dir === 1 ? 'BUY' : 'SELL';
  const entryVerdictDir = entry.verdict === 'bullish-lean' ? 1 : entry.verdict === 'bearish-lean' ? -1 : 0;
  if (entryVerdictDir === -dir) {
    return { ...base, status: 'wait', action, reason: `${tfs.entry.label} evidence leans ${entryVerdictDir === 1 ? 'bullish' : 'bearish'}, against the ${tfs.bias.label} ${word.toLowerCase()} lean`, headline: `${label}: ${word} lean on ${tfs.bias.label}, but ${tfs.entry.label} opposes - wait` };
  }
  const target = pickTarget(dir, price, [{ ev: entry, tf: tfs.entry.label }, { ev: bias, tf: tfs.bias.label }]);
  const sc = entry.scenarios.find((s) => s.dir === dir);
  const invalidation = sc && sc.invalidation ? { ...sc.invalidation, tf: tfs.entry.label } : null;
  const until = target ? ` until price reaches the ${target.kind} at ${fmtPrice(target.price)}` : ' (no target area identified)';
  return {
    ...base, status: 'signal', action, target, invalidation,
    headline: `${label}: ${word} lean on ${tfs.bias.label} - ${action} on ${tfs.entry.label}${until}`,
  };
}

/** Display precision by magnitude (the feed's own decimals are not known here). */
export function fmtPrice(p) { const a = Math.abs(p); return p.toFixed(a >= 1000 ? 2 : a >= 100 ? 3 : a >= 1 ? 4 : 5); }
function summary(e) { return { verdict: e.verdict, balance: e.balance }; }
