// SVG-string renderer for the engine layer. Pure: (analysis, geometry, options) -> string.
// Geometry comes from the host chart so the layer follows pan, zoom and price range exactly:
//   { start, count, lo, hi, xAt(i), y(p), clampY(p), chartRight, padL, dec }
// Zones are anchored to candle indices (hence timestamps) and prices, never to pixels.

const COLORS = {
  OB: { 1: ['22,224,139', 'OB+'], '-1': ['255,77,94', 'OB−'] },
  BREAKER: { 1: ['120,200,255', 'BRK+'], '-1': ['255,150,70', 'BRK−'] },
  FVG: { 1: ['255,196,77', 'FVG+'], '-1': ['255,196,77', 'FVG−'] },
  IFVG: { 1: ['180,140,255', 'IFVG+'], '-1': ['180,140,255', 'IFVG−'] },
  BPR: { 1: ['230,230,120', 'BPR'], '-1': ['230,230,120', 'BPR'] },
  REJECTION: { 1: ['90,200,200', 'RB+'], '-1': ['220,110,200', 'RB−'] },
};
const LIVE = (z) => z.confirmedIndex != null && !['invalidated', 'expired', 'inverted', 'candidate'].includes(z.status) && !(z.kind === 'FVG' && z.status === 'filled');

export function visibleZones(zones, g, { states = 'live', kinds = null, max = 14 } = {}) {
  const last = g.start + g.count - 1;
  const out = zones.filter((z) => {
    if (z.confirmedIndex == null || z.status === 'candidate') return false;
    if (kinds && !kinds.includes(z.kind)) return false;
    if (states === 'live' && !LIVE(z)) return false;
    const endI = z.endIndex ?? Infinity;
    if (z.createdIndex > last || endI < g.start) return false;
    return Math.max(z.top, z.bottom) >= g.lo && Math.min(z.top, z.bottom) <= g.hi;
  });
  out.sort((a, b) => b.confirmedIndex - a.confirmedIndex);
  return out.slice(0, max);
}

export function renderZones(zones, g, opts = {}) {
  let s = '';
  for (const z of visibleZones(zones, g, opts)) {
    const [rgb, label] = COLORS[z.kind][z.dir];
    const x0 = Math.max(g.padL, g.xAt(z.createdIndex));
    const x1 = z.endIndex != null ? Math.min(g.chartRight, g.xAt(z.endIndex)) : g.chartRight;
    if (x1 <= x0) continue;
    const yt = g.clampY(z.top), yb = g.clampY(z.bottom);
    const dead = !LIVE(z);
    const fillA = dead ? 0.05 : 0.12 + Math.min(0.1, z.fill * 0.1);
    s += `<g class="eng-zone" data-kind="${z.kind}" data-status="${z.status}">`
      + `<rect x="${x0.toFixed(1)}" y="${yt.toFixed(1)}" width="${(x1 - x0).toFixed(1)}" height="${Math.max(1.5, yb - yt).toFixed(1)}" fill="rgba(${rgb},${fillA})" stroke="rgba(${rgb},${dead ? 0.25 : 0.55})" stroke-width="0.6"${dead ? ' stroke-dasharray="2,3"' : ''}/>`;
    if (z.kind === 'FVG' || z.kind === 'IFVG') {
      const ym = g.clampY(z.mid);
      s += `<line x1="${x0.toFixed(1)}" y1="${ym.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${ym.toFixed(1)}" stroke="rgba(${rgb},0.35)" stroke-width="0.5" stroke-dasharray="1,2"/>`;
    }
    const tag = `${label}${z.testCount ? ' ×' + z.testCount : ''}${dead ? ' ' + z.status : ''}`;
    s += `<text x="${(x0 + 2).toFixed(1)}" y="${(yt + 7).toFixed(1)}" fill="rgba(${rgb},0.95)" font-size="6.5" font-family="monospace">${tag}</text></g>`;
  }
  return s;
}

export function renderStructure(structure, g, { scale = 'swing', max = 8 } = {}) {
  const evs = (structure[scale]?.events || []).filter((e) => e.index >= g.start && e.index < g.start + g.count && e.level >= g.lo && e.level <= g.hi).slice(-max);
  let s = '';
  for (const e of evs) {
    const up = e.dir === 1;
    const label = e.mss ? 'MSS' : e.type;
    const col = e.type === 'CHoCH' ? '#ffc44d' : up ? '#16e08b' : '#ff4d5e';
    const x0 = Math.max(g.padL, g.xAt(e.pivotIndex)), x1 = g.xAt(e.index), y = g.clampY(e.level);
    s += `<g class="eng-struct" data-type="${label}"><line x1="${x0.toFixed(1)}" y1="${y.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${col}" stroke-width="0.8" stroke-dasharray="3,2"/>`
      + `<text x="${((x0 + x1) / 2).toFixed(1)}" y="${(y + (up ? -3 : 8)).toFixed(1)}" fill="${col}" font-size="6.5" text-anchor="middle" font-family="monospace">${label}</text></g>`;
  }
  return s;
}

export function renderLiquidity(liq, g, { max = 8 } = {}) {
  const pools = liq.pools.filter((p) => p.status === 'active' && p.level >= g.lo && p.level <= g.hi && (p.equal || p.source !== 'pivot'))
    .sort((a, b) => b.formedIndex - a.formedIndex).slice(0, max);
  let s = '';
  for (const p of pools) {
    const y = g.clampY(p.level), x0 = Math.max(g.padL, g.xAt(p.pivotIndices[0] ?? p.formedIndex));
    const name = p.source === 'pivot' ? (p.side === 'buy' ? 'EQH' : 'EQL') + ' ×' + p.touches : p.source;
    const col = p.side === 'buy' ? '#ff9ec0' : '#7fdcff';
    s += `<g class="eng-liq" data-source="${p.source}"><line x1="${x0.toFixed(1)}" y1="${y.toFixed(1)}" x2="${g.chartRight}" y2="${y.toFixed(1)}" stroke="${col}" stroke-width="0.7" stroke-dasharray="1,3"/>`
      + `<text x="${g.chartRight - 2}" y="${(y - 2).toFixed(1)}" fill="${col}" font-size="6.5" text-anchor="end" font-family="monospace">${name}</text></g>`;
  }
  for (const e of liq.events) {
    if (e.kind !== 'sweep-confirmed' || e.index < g.start || e.index >= g.start + g.count || e.level < g.lo || e.level > g.hi) continue;
    const x = g.xAt(e.index), y = g.clampY(e.level);
    s += `<g class="eng-sweep"><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.6" fill="none" stroke="#ffc44d" stroke-width="1"/>`
      + `<text x="${x.toFixed(1)}" y="${(y + (e.side === 'buy' ? -5 : 10)).toFixed(1)}" fill="#ffc44d" font-size="6.5" text-anchor="middle" font-family="monospace">sweep</text></g>`;
  }
  return s;
}

const ABBR = { 'pin-bar': 'PIN', engulfing: 'ENG', 'inside-bar': 'IB', 'outside-bar': 'OB', 'three-bar-reversal': '3BR' };
export function renderCandlePatterns(pat, g, { max = 12 } = {}) {
  const ev = pat.candle.filter((e) => ABBR[e.kind] && e.index >= g.start && e.index < g.start + g.count).slice(-max);
  let s = '';
  for (const e of ev) {
    const c = pat.candles[e.index];
    const x = g.xAt(e.index), up = e.dir >= 0;
    const yy = g.clampY(up ? c.low : c.high) + (up ? 9 : -4);
    const col = e.dir === 1 ? '#16e08b' : e.dir === -1 ? '#ff4d5e' : '#9aa7bd';
    s += `<text class="eng-cp" data-kind="${e.kind}" x="${x.toFixed(1)}" y="${yy.toFixed(1)}" fill="${col}" font-size="6" text-anchor="middle" font-family="monospace">${e.name === 'shooting-star' ? 'SS' : e.name === 'hammer' ? 'HAM' : ABBR[e.kind]}</text>`;
  }
  return s;
}

export function renderChartPatterns(pat, g, { max = 4, live = true } = {}) {
  const last = g.start + g.count - 1;
  const list = pat.chart.filter((p) => (!live || ['forming', 'confirmed'].includes(p.status)) && p.pivots[p.pivots.length - 1].index <= last && p.pivots[0].index >= g.start - 40)
    .sort((a, b) => b.formedIndex - a.formedIndex).slice(0, max);
  let s = '';
  for (const p of list) {
    const col = p.status === 'confirmed' ? (p.dir === 1 ? '#16e08b' : '#ff4d5e') : '#9aa7bd';
    const pts = p.pivots.map((q) => `${g.xAt(q.index).toFixed(1)},${g.clampY(q.price).toFixed(1)}`).join(' ');
    s += `<g class="eng-pat" data-kind="${p.kind}" data-status="${p.status}"><polyline points="${pts}" fill="none" stroke="${col}" stroke-width="0.8" stroke-dasharray="${p.status === 'confirmed' ? '0' : '3,2'}"/>`;
    for (const ln of [p.upper, p.lower]) if (ln) {
      const xa = g.xAt(ln[0].index), xb = Math.min(g.chartRight, g.xAt(p.confirmedIndex));
      const sl = (ln[1].price - ln[0].price) / (ln[1].index - ln[0].index);
      const ya = g.clampY(ln[0].price), yb = g.clampY(ln[0].price + sl * (p.confirmedIndex - ln[0].index));
      s += `<line x1="${xa.toFixed(1)}" y1="${ya.toFixed(1)}" x2="${xb.toFixed(1)}" y2="${yb.toFixed(1)}" stroke="${col}" stroke-width="0.7"/>`;
    }
    if (p.neckline != null && !p.necklinePts && p.neckline >= g.lo && p.neckline <= g.hi) s += `<line x1="${g.xAt(p.pivots[0].index).toFixed(1)}" y1="${g.clampY(p.neckline).toFixed(1)}" x2="${g.chartRight}" y2="${g.clampY(p.neckline).toFixed(1)}" stroke="${col}" stroke-width="0.6" stroke-dasharray="4,2"/>`;
    const lp = p.pivots[p.pivots.length - 1];
    s += `<text x="${g.xAt(lp.index).toFixed(1)}" y="${(g.clampY(lp.price) + (lp.type === 'high' ? -4 : 9)).toFixed(1)}" fill="${col}" font-size="6.5" font-family="monospace" text-anchor="middle">${p.kind} (${p.status})</text></g>`;
  }
  return s;
}

export function renderWyckoff(pat, g, { max = 6 } = {}) {
  let s = '';
  for (const e of pat.wyckoff.filter((e) => e.kind !== 'effort-no-result' && e.index >= g.start && e.index < g.start + g.count && e.level >= g.lo && e.level <= g.hi).slice(-max)) {
    const col = e.dir === 1 ? '#16e08b' : '#ff4d5e';
    s += `<text class="eng-wy" x="${g.xAt(e.index).toFixed(1)}" y="${(g.clampY(e.level) + (e.dir === 1 ? 10 : -4)).toFixed(1)}" fill="${col}" font-size="6.5" font-family="monospace" text-anchor="middle">${e.kind}</text>`;
  }
  return s;
}

export function renderRegime(pat, g) {
  const v = pat.volatility.series[g.start + g.count - 1];
  if (!v) return '';
  const pct = v.atrPercentile == null ? 'n/a' : Math.round(v.atrPercentile * 100) + 'p';
  return `<text class="eng-reg" x="${g.padL + 2}" y="9" fill="#9aa7bd" font-size="6.5" font-family="monospace">vol ${v.regime} (ATR ${pct})${v.squeeze ? ' � squeeze' : ''}</text>`;
}

export function renderLevels(L, g, { showSR = true, showSD = true, showPD = true, showFib = true, showTL = true, showMA = true, showRef = true, showProfile = true, showAMD = true, srMax = 6, sdMax = 6 } = {}) {
  let s = '';
  const px = L.candles[L.candles.length - 1].close;
  const line = (cls, y, col, dash, label, x0 = g.padL, w = 0.7) =>
    `<g class="${cls}"><line x1="${x0.toFixed(1)}" y1="${y.toFixed(1)}" x2="${g.chartRight}" y2="${y.toFixed(1)}" stroke="${col}" stroke-width="${w}"${dash ? ` stroke-dasharray="${dash}"` : ''}/><text x="${g.chartRight - 2}" y="${(y - 2).toFixed(1)}" fill="${col}" font-size="6.5" text-anchor="end" font-family="monospace">${label}</text></g>`;
  const inV = (p) => p >= g.lo && p <= g.hi;
  if (showSR) {
    const act = L.sr.filter((z) => z.status === 'active' && z.updatedIndex <= g.start + g.count).sort((a, b) => b.score - a.score).slice(0, srMax);
    for (const z of act) {
      if (z.high < g.lo || z.low > g.hi) continue;
      const yt = g.clampY(z.high), yb = g.clampY(z.low), col = z.role === 'resistance' ? '255,77,94' : '22,224,139';
      s += `<g class="lv-sr"><rect x="${g.padL}" y="${yt.toFixed(1)}" width="${(g.chartRight - g.padL).toFixed(1)}" height="${Math.max(1.5, yb - yt).toFixed(1)}" fill="rgba(${col},0.08)" stroke="rgba(${col},0.4)" stroke-width="0.5"/><text x="${g.padL + 2}" y="${(yt - 2).toFixed(1)}" fill="rgb(${col})" font-size="6.5" font-family="monospace">${z.role === 'resistance' ? 'R' : 'S'} �${z.touches}${z.flips ? ' flip' + z.flips : ''}</text></g>`;
    }
  }
  if (showSD) {
    const sd = L.supplyDemand.filter((z) => z.status === 'active' && z.createdIndex < g.start + g.count && z.top >= g.lo && z.bottom <= g.hi)
      .sort((a, b) => b.confirmedIndex - a.confirmedIndex).slice(0, sdMax);
    for (const z of sd) {
      const yt = g.clampY(z.top), yb = g.clampY(z.bottom), col = z.dir === 1 ? '60,200,255' : '255,140,60', x0 = Math.max(g.padL, g.xAt(z.createdIndex));
      s += `<g class="lv-sd"><rect x="${x0.toFixed(1)}" y="${yt.toFixed(1)}" width="${(g.chartRight - x0).toFixed(1)}" height="${Math.max(1.5, yb - yt).toFixed(1)}" fill="rgba(${col},0.13)" stroke="rgba(${col},0.6)" stroke-width="0.6"/><text x="${(x0 + 2).toFixed(1)}" y="${(yt + 7).toFixed(1)}" fill="rgb(${col})" font-size="6.5" font-family="monospace">${z.kind === 'DEMAND' ? 'DEM' : 'SUP'}${z.testCount ? ' �' + z.testCount : ''}</text></g>`;
    }
  }
  if (showPD && L.premiumDiscount) {
    const pd = L.premiumDiscount;
    for (const [k, v] of [['75%', pd.q75], ['EQ', pd.eq], ['25%', pd.q25]]) if (inV(v)) s += line('lv-pd', g.clampY(v), '#8aa0c8', '1,3', `P/D ${k}`);
  }
  if (showFib && L.fib) {
    for (const l of L.fib.levels) if ([0.5, 0.618, 0.705, 0.786, 1.272, 1.618, -0.27, -0.62].includes(l.ratio) && inV(l.price)) s += line('lv-fib', g.clampY(l.price), l.ratio === 0.705 ? '#ffd24d' : '#c0a0ff', '2,3', `fib ${l.ratio}`, g.padL, l.ratio === 0.705 ? 1 : 0.6);
  }
  if (showTL) {
    for (const t of L.trendlines.filter((t) => t.status === 'active' && t.p2.index >= g.start - 60).sort((a, b) => b.touches - a.touches).slice(0, 3)) {
      const last = g.start + g.count - 1, ya = t.p1.price + t.slope * (g.start - t.p1.index), yb2 = t.p1.price + t.slope * (last - t.p1.index);
      s += `<g class="lv-tl"><line x1="${g.xAt(g.start).toFixed(1)}" y1="${g.clampY(ya).toFixed(1)}" x2="${g.xAt(last).toFixed(1)}" y2="${g.clampY(yb2).toFixed(1)}" stroke="${t.kind === 'support-line' ? '#16e08b' : '#ff4d5e'}" stroke-width="0.8" stroke-dasharray="5,2"/></g>`;
    }
  }
  if (showMA) {
    const cols = { 20: '#ffd24d', 50: '#4dc3ff', 200: '#ff7ad9' };
    for (const [per, arr] of Object.entries(L.emas)) {
      let d = '';
      for (let i = g.start; i < g.start + g.count; i++) if (arr[i] != null && inV(arr[i])) d += `${d ? 'L' : 'M'}${g.xAt(i).toFixed(1)},${g.clampY(arr[i]).toFixed(1)}`;
      if (d) s += `<g class="lv-ema"><path d="${d}" fill="none" stroke="${cols[per] || '#aaa'}" stroke-width="0.8"/></g>`;
    }
  }
  if (showRef) {
    const o = L.opens[g.start + g.count - 1];
    if (o) {
      if (inV(o.dayOpen)) s += line('lv-ref', g.clampY(o.dayOpen), '#9aa7bd', '1,2', 'day open');
      if (inV(o.weekOpen)) s += line('lv-ref', g.clampY(o.weekOpen), '#9aa7bd', '1,2', 'week open');
      if (o.pivots) for (const [k, v] of Object.entries(o.pivots)) if (inV(v)) s += line('lv-ref', g.clampY(v), '#7d8aa5', '2,4', k.toUpperCase(), g.padL, 0.5);
    }
  }
  if (showProfile && L.profile) {
    for (const [k, v] of [['POC*', L.profile.poc], ['VAH*', L.profile.vah], ['VAL*', L.profile.val]]) if (inV(v)) s += line('lv-vp', g.clampY(v), '#e0b0ff', k === 'POC*' ? '' : '3,3', k + ' (proxy)');
  }
  if (showAMD) {
    const a = L.amd[g.start + g.count - 1];
    if (a && a.state !== 'none') s += `<text class="lv-amd" x="${g.padL + 2}" y="18" fill="#ffd24d" font-size="6.5" font-family="monospace">AMD: ${a.state}${a.distributionDir ? (a.distributionDir === 1 ? ' ?' : ' ?') : ''}</text>`;
  }
  return s;
}
