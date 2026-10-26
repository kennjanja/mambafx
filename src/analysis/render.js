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
