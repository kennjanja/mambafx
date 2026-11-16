import { atrSeries, sanitize } from './core.js';
import { detectPivots } from './pivots.js';

export const SR_GROUPS = Object.freeze([
  { label: 'Low TFSR', frames: [30, 60, 180, 300, 600] },
  { label: 'Medium TFSR', frames: [900, 1800, 2700] },
  { label: 'High TFSR', frames: [3600, 7200, 14400, 28800] },
  { label: 'Ultra TFSR', frames: [86400, 604800, 2592000] },
]);

export function periodStart(epoch, kind) {
  const d = new Date(epoch * 1000);
  if (kind === 'month') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
  if (kind === 'week') {
    const day = Math.floor(epoch / 86400);
    return (day - ((day + 3) % 7 + 7) % 7) * 86400;
  }
  return Math.floor(epoch / kind) * kind;
}

export function periodEnd(epoch, kind) {
  if (kind === 'month') {
    const d = new Date(epoch * 1000);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000;
  }
  return periodStart(epoch, kind) + (kind === 'week' ? 604800 : kind);
}

// Historical aggregation keeps complete buckets; live chart callers may opt to display a forming bucket.
export function aggregateCandles(source, sourceSeconds, kind, now, { includeForming = false } = {}) {
  const { candles } = sanitize(source);
  const result = [];
  let bucket = null;
  const flush = () => {
    if (!bucket) return;
    const end = periodEnd(bucket.epoch, kind);
    if (bucket.first === bucket.epoch && bucket.contiguous &&
        (end > now || bucket.last + sourceSeconds === end)) {
      result.push({ epoch: bucket.epoch, open: bucket.open, high: bucket.high, low: bucket.low, close: bucket.close });
    }
  };
  for (const c of candles) {
    // Historical replay cannot know a forming candle's eventual OHLC values.
    if (c.epoch > now || (!includeForming && c.epoch + sourceSeconds > now)) continue;
    const start = periodStart(c.epoch, kind);
    if (!bucket || bucket.epoch !== start) {
      flush();
      bucket = { epoch: start, first: c.epoch, last: c.epoch, open: c.open, high: c.high, low: c.low, close: c.close, contiguous: true };
    } else {
      if (c.epoch !== bucket.last + sourceSeconds) bucket.contiguous = false;
      bucket.last = c.epoch;
      bucket.high = Math.max(bucket.high, c.high);
      bucket.low = Math.min(bucket.low, c.low);
      bucket.close = c.close;
    }
  }
  flush();
  return result;
}

function frameAnalysis(input, endOf, now) {
  const candles = sanitize(input).candles.filter(c => endOf(c.epoch) <= now);
  if (candles.length < 5) return null;
  const atr = atrSeries(candles).at(-1);
  const { confirmed } = detectPivots(candles, 2, true);
  const evidence = confirmed.map(p => ({
    price: p.price, pivotEpoch: p.epoch,
    confirmedAt: endOf(p.confirmedEpoch), pivotLabel: p.label, type: p.type,
  }));
  return {
    atr,
    support: evidence.filter(p => p.type === 'low'),
    resistance: evidence.filter(p => p.type === 'high'),
  };
}

function matchingLevels(frames, analyses, role) {
  if (frames.some(g => !analyses[g]) || !Number.isFinite(analyses[frames[0]].atr) || analyses[frames[0]].atr <= 0) return [];
  const tolerance = analyses[frames[0]].atr * 0.25;
  const points = frames.flatMap(g => analyses[g][role].map(p => ({ ...p, timeframe: g })))
    .sort((a, b) => a.price - b.price);
  const levels = [];
  for (let i = 0; i < points.length; i++) {
    const chosen = new Map();
    for (let j = i; j < points.length && points[j].price - points[i].price <= tolerance; j++) {
      if (!chosen.has(points[j].timeframe)) chosen.set(points[j].timeframe, points[j]);
      if (chosen.size === frames.length) {
        const values = [...chosen.values()];
        const low = Math.min(...values.map(v => v.price));
        const high = Math.max(...values.map(v => v.price));
        const price = (low + high) / 2;
        if (!levels.some(l => Math.abs(l.price - price) <= tolerance)) levels.push({
          id: `${role}:${frames.join(',')}:${values.map(v => `${v.timeframe}:${v.pivotEpoch}`).join(',')}`,
          price, low, high, tolerance, evidence: values.sort((a, b) => a.timeframe - b.timeframe),
          evidenceConfirmedAt: Math.max(...values.map(v => v.confirmedAt)),
          rank: { timeframeCoverage: values.length, latestEvidenceAt: Math.max(...values.map(v => v.confirmedAt)) },
        });
        break;
      }
    }
  }
  return levels;
}

export function computeModifiedSr(data, now, currentPrice) {
  const frames = SR_GROUPS.flatMap(g => g.frames);
  const analyses = {};
  for (const g of frames) {
    const kind = g === 2592000 ? 'month' : g === 604800 ? 'week' : g;
    analyses[g] = frameAnalysis(data[g] || [], epoch => periodEnd(epoch, kind), now);
  }
  const missing = frames.filter(g => !analyses[g] ||
    (SR_GROUPS.some(group => group.frames[0] === g) && !(analyses[g].atr > 0)));
  const available = frames.filter(g => !missing.includes(g));
  const output = { support: [], resistance: [], available, missing };
  if (!Number.isFinite(currentPrice)) return output;
  const rankOrder = (a, b) => b.rank.timeframeCoverage - a.rank.timeframeCoverage ||
    b.rank.latestEvidenceAt - a.rank.latestEvidenceAt || a.price - b.price;
  for (const role of ['support', 'resistance']) {
    const sure = matchingLevels(frames, analyses, role).map(l => ({ ...l, label: 'Sure TFSR' }));
    const groups = SR_GROUPS.flatMap(group => matchingLevels(group.frames, analyses, role)
      .filter(l => !sure.some(s => Math.abs(s.price - l.price) <= s.tolerance))
      .map(l => ({ ...l, label: group.label })));
    output[role] = [...sure, ...groups].sort(rankOrder);
  }
  return output;
}

// A nearby zone is context, not proof that its originating price event is independent.
export function attachZoneContext(result, analyses) {
  const live = new Set(['active', 'partial', 'mitigated']);
  const resultWithContext = { ...result };
  for (const role of ['support', 'resistance']) {
    const dir = role === 'support' ? 1 : -1;
    resultWithContext[role] = result[role].map(line => {
      const contextById = new Map();
      const add = evidence => {
        if (!contextById.has(evidence.id)) contextById.set(evidence.id, evidence);
      };
      const addReference = (timeframe, kind, price, index, extra = {}) => {
        const bundle = analyses[timeframe];
        const candles = (bundle?.levels || bundle?.patterns || bundle?.engine)?.candles;
        if (!candles?.length || !Number.isFinite(price) || Math.abs(price - line.price) > line.tolerance) return;
        const i = Number.isInteger(index) ? index : candles.length - 1;
        const candle = candles[i];
        if (!candle) return;
        const frameKind = timeframe === 2592000 ? 'month' : timeframe === 604800 ? 'week' : timeframe;
        add({
          id: `${timeframe}:reference:${kind}:${candle.epoch}:${price}`,
          family: 'context-reference', kind, status: 'reference', dir: 0,
          timeframe, bottom: price, top: price, originEpoch: candle.epoch,
          confirmedAt: periodEnd(candle.epoch, frameKind), ...extra,
        });
      };
      for (const pivot of line.evidence) {
        const bundle = analyses[pivot.timeframe];
        if (!bundle) continue;
        const analysis = bundle.engine || bundle;
        const kind = pivot.timeframe === 2592000 ? 'month' : pivot.timeframe === 604800 ? 'week' : pivot.timeframe;
        for (const zone of analysis.zones || []) {
          if (zone.dir !== dir || zone.confirmedIndex == null || !live.has(zone.status) ||
              !Number.isFinite(zone.bottom) || !Number.isFinite(zone.top) ||
              line.price < zone.bottom - line.tolerance || line.price > zone.top + line.tolerance) continue;
          const confirmation = analysis.candles[zone.confirmedIndex];
          const origin = analysis.candles[zone.createdIndex];
          if (!confirmation || !origin) continue;
          add({
            id: `${pivot.timeframe}:${zone.kind}:${origin.epoch}:${zone.dir}:${zone.bottom}:${zone.top}`,
            family: zone.kind === 'FVG' || zone.kind === 'IFVG' || zone.kind === 'BPR' ? 'imbalance'
              : zone.kind === 'OB' || zone.kind === 'BREAKER' ? 'order-block' : 'rejection',
            timeframe: pivot.timeframe, kind: zone.kind, status: zone.status, dir: zone.dir,
            bottom: zone.bottom, top: zone.top, originEpoch: origin.epoch,
            confirmedAt: periodEnd(confirmation.epoch, kind),
            fill: zone.fill, testCount: zone.testCount,
          });
        }

        for (const sweep of analysis.liquidity?.events || []) {
          if (sweep.kind !== 'sweep-confirmed' || sweep.confirmedIndex == null ||
              (role === 'support' ? sweep.side !== 'sell' : sweep.side !== 'buy') ||
              Math.abs(sweep.level - line.price) > line.tolerance) continue;
          const confirmation = analysis.candles[sweep.confirmedIndex];
          const origin = analysis.candles[sweep.index];
          if (!confirmation || !origin) continue;
          add({
            id: `${pivot.timeframe}:sweep:${sweep.side}:${origin.epoch}:${sweep.level}`,
            family: 'liquidity-response', kind: 'confirmed-sweep', status: 'confirmed', dir,
            timeframe: pivot.timeframe, bottom: sweep.level, top: sweep.level,
            originEpoch: origin.epoch, confirmedAt: periodEnd(confirmation.epoch, kind),
            reaction: sweep.reaction || null,
          });
        }

        for (const pool of analysis.liquidity?.pools || []) {
          if (pool.status !== 'active' || Math.abs(pool.level - line.price) > line.tolerance) continue;
          const formed = analysis.candles[pool.formedIndex];
          if (!formed) continue;
          add({
            id: `${pivot.timeframe}:liquidity:${pool.source}:${pool.side}:${formed.epoch}:${pool.level}`,
            family: 'liquidity-reference', timeframe: pivot.timeframe, kind: pool.equal ? 'equal-high-low' : pool.source,
            status: pool.status, dir: pool.side === 'sell' ? 1 : -1, liquiditySide: pool.side,
            bottom: pool.level, top: pool.level, originEpoch: formed.epoch,
            confirmedAt: periodEnd(formed.epoch, kind), touches: pool.touches,
          });
        }

        for (const scale of ['swing', 'internal']) {
          for (const event of analysis[scale]?.events || []) {
            if (Math.abs(event.level - line.price) > line.tolerance) continue;
            const confirmation = analysis.candles[event.confirmedIndex];
            if (!confirmation) continue;
            add({
              id: `${pivot.timeframe}:structure:${scale}:${event.type}:${event.dir}:${event.pivotIndex}:${confirmation.epoch}`,
              family: 'market-structure', timeframe: pivot.timeframe, kind: event.mss ? 'MSS' : event.type,
              status: event.status, dir: event.dir, bottom: event.level, top: event.level,
              originEpoch: analysis.candles[event.pivotIndex]?.epoch,
              confirmedAt: periodEnd(confirmation.epoch, kind),
            });
          }
        }

        const levels = bundle.levels;
        for (const zone of levels?.sr || []) {
          if (zone.status !== 'active' || zone.role !== role || zone.confirmedIndex == null ||
              !Number.isFinite(zone.low) || !Number.isFinite(zone.high) ||
              line.price < zone.low - line.tolerance || line.price > zone.high + line.tolerance) continue;
          const confirmation = levels.candles[zone.confirmedIndex];
          const updated = levels.candles[zone.updatedIndex];
          const origin = levels.candles[zone.createdIndex];
          if (!confirmation || !origin) continue;
          add({
            id: `${pivot.timeframe}:horizontal-sr:${zone.id}`,
            family: 'horizontal-sr', timeframe: pivot.timeframe, kind: 'pivot-cluster',
            status: zone.status, dir, bottom: zone.low, top: zone.high,
            originEpoch: origin.epoch, confirmedAt: periodEnd(confirmation.epoch, kind),
            updatedAt: updated ? periodEnd(updated.epoch, kind) : null,
            touches: zone.touches, flips: zone.flips, history: zone.history,
          });
        }

        for (const zone of levels?.supplyDemand || []) {
          if (zone.dir !== dir || zone.confirmedIndex == null || zone.status !== 'active' ||
              line.price < zone.bottom - line.tolerance || line.price > zone.top + line.tolerance) continue;
          const confirmation = levels.candles[zone.confirmedIndex];
          const origin = levels.candles[zone.createdIndex];
          if (!confirmation || !origin) continue;
          add({
            id: `${pivot.timeframe}:${zone.kind}:${origin.epoch}:${zone.bottom}:${zone.top}`,
            family: 'supply-demand', timeframe: pivot.timeframe, kind: zone.kind, status: zone.status, dir,
            bottom: zone.bottom, top: zone.top, originEpoch: origin.epoch,
            confirmedAt: periodEnd(confirmation.epoch, kind), testCount: zone.testCount,
          });
        }

        for (const trendline of levels?.trendlines || []) {
          if (trendline.status !== 'active' || trendline.confirmedIndex == null ||
              (role === 'support' ? trendline.kind !== 'support-line' : trendline.kind !== 'resistance-line')) continue;
          const lastIndex = levels.candles.length - 1;
          const projected = trendline.p1.price + trendline.slope * (lastIndex - trendline.p1.index);
          if (Math.abs(projected - line.price) > line.tolerance) continue;
          const confirmation = levels.candles[trendline.confirmedIndex];
          if (!confirmation) continue;
          add({
            id: `${pivot.timeframe}:${trendline.id}`, family: 'trendline', timeframe: pivot.timeframe,
            kind: trendline.kind, status: trendline.status, dir, bottom: projected, top: projected,
            originEpoch: levels.candles[trendline.p1.index]?.epoch,
            confirmedAt: periodEnd(confirmation.epoch, kind), touches: trendline.touches,
          });
        }

        const patterns = bundle.patterns;
        for (const pattern of patterns?.chart || []) {
          if (pattern.status !== 'confirmed' || pattern.confirmedIndex == null ||
              (role === 'support' ? pattern.dir !== 1 : pattern.dir !== -1)) continue;
          const pivots = (pattern.pivots || []).filter(p => p.type === (role === 'support' ? 'low' : 'high'));
          if (!pivots.some(p => Math.abs(p.price - line.price) <= line.tolerance)) continue;
          const confirmation = patterns.candles[pattern.confirmedIndex];
          if (!confirmation) continue;
          const prices = pivots.map(p => p.price);
          add({
            id: `${pivot.timeframe}:pattern:${pattern.id}`, family: 'chart-pattern',
            timeframe: pivot.timeframe, kind: pattern.kind, status: pattern.status, dir,
            bottom: Math.min(...prices), top: Math.max(...prices),
            originEpoch: patterns.candles[pivots[0].index]?.epoch,
            confirmedAt: periodEnd(confirmation.epoch, kind),
          });
        }

        for (const candleEvent of patterns?.candle || []) {
          if (candleEvent.confirmedIndex == null || candleEvent.dir !== dir) continue;
          const candle = patterns.candles[candleEvent.index];
          if (!candle || candle.low > line.price + line.tolerance || candle.high < line.price - line.tolerance) continue;
          add({
            id: `${pivot.timeframe}:candle:${candleEvent.kind}:${candle.epoch}:${dir}`,
            family: 'candle-rejection', timeframe: pivot.timeframe, kind: candleEvent.kind,
            status: 'confirmed', dir, bottom: candle.low, top: candle.high,
            originEpoch: candle.epoch, confirmedAt: periodEnd(candle.epoch, kind),
          });
        }

        const pd = levels?.premiumDiscount;
        if (pd) {
          for (const [label, price] of [['premium 75%', pd.q75], ['equilibrium', pd.eq], ['discount 25%', pd.q25]]) {
            addReference(pivot.timeframe, label, price, pd.confirmedIndex);
          }
        }
        const fib = levels?.fib;
        if (fib) {
          for (const level of fib.levels || []) {
            addReference(pivot.timeframe, `fib ${level.ratio}`, level.price, fib.confirmedIndex);
          }
          if (fib.ote && line.price >= fib.ote.low - line.tolerance && line.price <= fib.ote.high + line.tolerance) {
            addReference(pivot.timeframe, 'OTE reference', fib.ote.price, fib.confirmedIndex, {
              bottom: fib.ote.low, top: fib.ote.high,
            });
          }
        }
        const open = levels?.opens?.at(-1);
        if (open) {
          addReference(pivot.timeframe, 'day open', open.dayOpen, levels.candles.length - 1);
          addReference(pivot.timeframe, 'week open', open.weekOpen, levels.candles.length - 1);
          for (const [label, price] of Object.entries(open.pivots || {})) {
            addReference(pivot.timeframe, `previous-period ${label}`, price, levels.candles.length - 1);
          }
        }
        if (levels?.profile) {
          for (const [label, price] of [['time-at-price POC proxy', levels.profile.poc], ['time-at-price VAH proxy', levels.profile.vah], ['time-at-price VAL proxy', levels.profile.val]]) {
            addReference(pivot.timeframe, label, price, levels.candles.length - 1, { proxy: true });
          }
        }
        const ema = levels?.emas || {};
        for (const [period, values] of Object.entries(ema)) {
          const price = values?.at(-1);
          if (Number.isFinite(price)) addReference(pivot.timeframe, `EMA ${period}`, price, levels.candles.length - 1);
        }
      }

      const allContext = [...contextById.values()].sort((a, b) => b.confirmedAt - a.confirmedAt || a.id.localeCompare(b.id));
      const supportingEvidence = allContext.filter(e => e.dir === dir &&
        e.family !== 'context-reference' && e.family !== 'liquidity-reference');
      const evidenceTimes = [line.evidenceConfirmedAt, ...supportingEvidence.map(e => e.confirmedAt)].filter(Number.isFinite);
      const latestEvidenceAt = evidenceTimes.length ? Math.max(...evidenceTimes) : null;
      return {
        ...line, context: allContext.slice(0, 20),
        rank: {
          timeframeCoverage: line.evidence.length,
          latestEvidenceAt,
        },
      };
    });
  }
  return resultWithContext;
}
