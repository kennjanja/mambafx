/**
 * src/bazu/breakoutStates3m.js  (pure, shadow: records only, never gates a decision)
 * Explicit breakout lifecycle per zone, separating the initial event's STRENGTH from its later CONFIRMATION:
 *   approaching -> testing -> penetrated -> provisional -> confirmed -> continuation -> exhaustion
 *   failed (closed back inside the zone / follow-through broke) is the terminal alternative.
 * Closed candles only. direction: +1 = break above a resistance-type zone, -1 = break below a support-type zone.
 * Event labels are the shadow-analysis key: horizons3m.js measures what actually followed each state.
 */

export const BRK_STATES = Object.freeze(['approaching', 'testing', 'penetrated', 'provisional', 'confirmed', 'continuation', 'exhaustion', 'failed']);
const PRIORITY = ['failed', 'confirmed', 'provisional', 'continuation', 'exhaustion', 'penetrated', 'testing', 'approaching'];
const UP_KINDS = ['resistance', 'supply', 'level'], DN_KINDS = ['support', 'demand', 'level'];

const DEF = { WINDOW: 10, POKE_ATR: 0.1, PEN_ATR: 0.25, BODY: 0.6, RETEST_ATR: 0.25, FOLLOW_MIN: 2, CONT_ATR: 1.5, EXH_ATR: 3, APPROACH_ATR: 1 };

export function classifyBreakouts(cs, zones, cfg = {}, price = cs?.at(-1)?.close) {
  const p = { ...DEF, PEN_ATR: cfg.BREAKOUT_MIN_ATR ?? DEF.PEN_ATR, BODY: cfg.BREAKOUT_BODY ?? DEF.BODY };
  const i = (cs?.length || 0) - 1, a = cs?.[i]?.atr;
  if (i < 8 || !(a > 0)) return { events: [], top: null };
  const events = [];
  for (const z of zones || []) {
    for (const dir of [1, -1]) {
      if (!(dir > 0 ? UP_KINDS : DN_KINDS).includes(z.kind)) continue;
      const edge = dir > 0 ? z.high : z.low, side = (v) => (dir > 0 ? v - edge : edge - v);
      const ctx = { zoneTf: z.tf, zoneKind: z.kind, touches: z.touches, zoneStrength: z.strength, overlap: z.overlap || 0, flipped: !!z.flipped };
      const mk = (state, extra) => events.push({ state, direction: dir, zone: z, edge, context: ctx, ...extra });
      let j = -1;
      for (let k = Math.max(1, i - p.WINDOW); k <= i; k++) if (cs[k].patternOk !== false && side(dir > 0 ? cs[k].high : cs[k].low) > p.POKE_ATR * a) { j = k; break; }
      if (j < 0) {
        const gap = -side(price) / a;
        if (price >= z.low && price <= z.high) mk('testing', { ageBars: 0 });
        else if (gap > 0 && gap <= p.APPROACH_ATR) mk('approaching', { gapATR: gap, ageBars: 0 });
        continue;
      }
      const c = cs[j], after = cs.slice(j + 1), depth = side(c.close) / a;
      const strength = { penetrationATR: depth, bodyRange: c.bodyRange, rangeATR: c.rangeATR, wickFrac: dir > 0 ? c.upperFrac : c.lowerFrac };
      const ageBars = i - j, ext = side(price) / a;
      const confirm = { closesBeyond: after.filter((x) => side(x.close) > 0).length, closesAfter: after.length, retestHeld: after.some((x) => (dir > 0 ? x.low <= edge + p.RETEST_ATR * a && x.close >= edge : x.high >= edge - p.RETEST_ATR * a && x.close <= edge)), backInside: side(c.close) <= 0 || after.some((x) => side(x.close) <= 0) };
      const base = { strength, confirmation: confirm, ageBars, extensionATR: ext };
      if (confirm.backInside) { mk('failed', { ...base, reason: `closed back inside the zone ${ageBars} bar(s) after the poke` }); continue; }
      const strong = depth >= p.PEN_ATR && c.bodyRange >= p.BODY;
      if (!strong) { mk('penetrated', { ...base, reason: 'beyond the edge but below the penetration/body thresholds' }); continue; }
      if (!after.length) { mk('provisional', { ...base, reason: 'strong break candle just closed; no follow-through yet' }); continue; }
      if (!(confirm.retestHeld || after.length >= p.FOLLOW_MIN)) { mk('provisional', { ...base, reason: 'one closed candle after the break, no retest yet' }); continue; }
      if (ext >= p.EXH_ATR) mk('exhaustion', { ...base, reason: `${ext.toFixed(1)} ATR beyond the zone` });
      else if (ext >= p.CONT_ATR) mk('continuation', { ...base, reason: `extending, ${ext.toFixed(1)} ATR beyond the zone` });
      else mk('confirmed', { ...base, reason: `follow-through${confirm.retestHeld ? ' and retest held' : ''}` });
    }
  }
  events.sort((x, y) => PRIORITY.indexOf(x.state) - PRIORITY.indexOf(y.state) || (x.ageBars ?? 0) - (y.ageBars ?? 0));
  return { events, top: events[0] || null };
}

/** Compact, serialisable form for logs (no zone object references). */
export const summarize = (r) => (r.top ? { state: r.top.state, direction: r.top.direction, edge: r.top.edge, reason: r.top.reason || null, strength: r.top.strength || null, confirmation: r.top.confirmation || null, ageBars: r.top.ageBars, extensionATR: r.top.extensionATR ?? null, context: r.top.context, all: r.events.length } : null);
