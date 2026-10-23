// Gap research: for each market, records every COMPLETED gap of each digit (the number of consecutive ticks
// without that digit between two occurrences of it) and ranks the longest ones. The research itself is read-only;
// the optional trader (gap-trader.js) acts on it only through the LDPE Executor.
// The open gap before a digit's first observed occurrence is unknown (its start was not seen) and is skipped.

import { GapTrader } from "./gap-trader.js";

const LS_KEY = "ldpe_gap_research_v1";
export const TOP_N = 5;

export class GapResearch {
  constructor(storage) { this.storage = storage || null; this.m = {}; this.dirty = 0; this._load(); }

  _load() {
    try { const s = this.storage && JSON.parse(this.storage.getItem(LS_KEY)); if (s && s.v === 1) this.m = s.m || {}; } catch (_) { this.m = {}; }
  }
  save() {
    if (!this.storage) return;
    try { this.storage.setItem(LS_KEY, JSON.stringify({ v: 1, m: this.m })); this.dirty = 0; } catch (_) {}
  }

  _s(sym) {
    return this.m[sym] || (this.m[sym] = { lastEpoch: -1, ticks: 0, cur: new Array(10).fill(0), seen: new Array(10).fill(false), hist: Array.from({ length: 10 }, () => ({})) });
  }

  // Returns false for duplicate/out-of-order ticks (epoch not strictly increasing) and invalid digits.
  ingest(sym, digit, epoch) {
    const d = Number(digit), e = Number(epoch);
    if (!Number.isInteger(d) || d < 0 || d > 9 || !Number.isFinite(e)) return false;
    const s = this._s(sym);
    if (e <= s.lastEpoch) return false;
    s.lastEpoch = e; s.ticks++;
    if (s.seen[d]) { const g = s.cur[d]; s.hist[d][g] = (s.hist[d][g] || 0) + 1; }
    s.seen[d] = true; s.cur[d] = 0;
    for (let i = 0; i < 10; i++) if (i !== d && s.seen[i]) s.cur[i]++;
    if (++this.dirty >= 25) this.save();
    return true;
  }

  // Top completed gaps, longest first. frequency = how many completed gaps, by ANY digit (including this
  // one), have reached at least this length: a later, longer gap by another digit raises it too.
  top(sym, n = TOP_N) {
    const s = this.m[sym]; if (!s) return [];
    const all = [];
    for (let d = 0; d < 10; d++) for (const [g, c] of Object.entries(s.hist[d])) all.push({ digit: d, gap: Number(g), count: c });
    const rows = all.map(r => ({ digit: r.digit, gap: r.gap, frequency: all.reduce((a, x) => a + (x.gap >= r.gap ? x.count : 0), 0) }));
    rows.sort((a, b) => b.gap - a.gap || a.digit - b.digit);
    return rows.slice(0, n);
  }
  // Current (still open) gap per digit; null until the digit has been seen.
  current(sym) { const s = this.m[sym]; return s ? s.cur.map((v, d) => (s.seen[d] ? v : null)) : null; }
  ticks(sym) { return this.m[sym] ? this.m[sym].ticks : 0; }
  reset(sym) { delete this.m[sym]; this.save(); }
}

const LS_TRIG = "ldpe_gap_trigger_v1";
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

if (typeof window !== "undefined" && typeof document !== "undefined") {
  const research = new GapResearch(window.localStorage);
  let current = null, label = "", trader = null;
  const $ = (id) => document.getElementById(id);
  const H = () => window.__ldpeHost || {};
  const trigger = () => { const v = parseInt(($("digResTrigger") || {}).value, 10); return Number.isFinite(v) && v >= 1 ? v : 30; };

  const getTrader = () => {
    if (trader || !window.LDPE || !window.LDPE.executor) return trader;
    trader = new GapTrader(window.LDPE.executor, {
      k: () => window.LDPE.settings.k,
      stake: () => (H().resNextStake ? H().resNextStake() : window.LDPE.settings.stake),
      trigger,
      resetStake: () => { if (H().resResetStake) H().resResetStake(); },
      gaps: (sym) => research.current(sym),
      onChange: () => render(),
    });
    return trader;
  };

  const render = () => {
    const body = $("digResearchBody"); if (!body || !current) return;
    const rows = research.top(current);
    body.innerHTML = rows.length
      ? rows.map(r => `<tr><td><b>${r.digit}</b></td><td>${r.gap}</td><td>${r.frequency}</td></tr>`).join("")
      : `<tr><td colspan="3" style="color:var(--muted)">No completed gaps recorded yet for this market.</td></tr>`;
    const m = $("digResearchMarket"); if (m) m.textContent = label || current;
    const t = $("digResearchTicks"); if (t) t.textContent = String(research.ticks(current));
    const cur = research.current(current);
    for (let d = 0; d < 10; d++) { const g = $("digResGap" + d); if (g) g.textContent = cur && cur[d] != null ? "gap " + cur[d] : "gap —"; }
    const tr = getTrader(), st = $("digResStatus"); if (!st) return;
    const L = window.LDPE;
    const acct = L ? (L.settings.accountType === "real" ? "Real" : "Demo") : "—";
    if (!tr) { st.textContent = "Trading unavailable: LDPE executor not loaded."; return; }
    const top = tr.topGap(current), n = tr.counts();
    st.innerHTML = `Account: <b>${acct}</b> · ` + (tr.armed
      ? (tr.cycle ? `cycle ${tr.cycle.n}: target <b>${tr.cycle.target}</b> (gap was ${tr.cycle.startGap}, fixed) · ${tr.cycle.intentions} trades`
        : `<b>waiting</b> for a digit to reach gap ${trigger()}` + (top ? ` (highest now: ${top.digit} at ${top.gap})` : ""))
      : "automated trading off") + ` · intentions ${n.total}: submitted ${n.submitted}, confirmed ${n.confirmed}, failed ${n.failed}, unresolved ${n.unresolved}`
      + (tr.intentions.length && tr.intentions[tr.intentions.length - 1].status === "failed" ? ` · last error: ${esc(tr.intentions[tr.intentions.length - 1].reason)}` : "");
  };

  window.GAPRES = {
    research,
    ingest(sym, digit, epoch, marketLabel) {
      current = sym; label = marketLabel || sym;
      if (research.ingest(sym, digit, epoch)) render();
    },
    // after the LDPE engine has processed the same tick (its sequence number is the executor's clock)
    afterTick(sym, digit, epoch) {
      const tr = getTrader(); if (!tr) return;
      const L = window.LDPE;
      tr.onTick({ symbol: sym, seq: L.engine.state(sym).seq, epoch: Number(epoch), digit: Number(digit), active: !L.executor.stopped });
    },
    arm(on) { const tr = getTrader(); if (tr) tr.setArmed(on); const c = $("digResArm"); if (c) c.checked = !!(tr && tr.armed); },
    disarm() { this.arm(false); },
    manual(d) { const tr = getTrader(); if (!tr) return; const r = tr.manual(d); if (!r.ok) { const s = $("digResStatus"); if (s) s.textContent = "Manual trade not sent: " + r.reason; } render(); },
    // Results of research orders feed the research progression only (never LDPE's); returns true when handled.
    recordResult(id, stk, won) {
      const o = window.LDPE && window.LDPE.executor.byContract.get(String(id));
      if (!o || !o.intent || typeof o.intent.cycleId !== "string") return false;
      if (trader && trader.countsForStake(id) && H().resRecord) H().resRecord(stk, won);
      return true;
    },
    countsForStake: (id) => (trader ? trader.countsForStake(id) : true),
    render(sym, marketLabel) { if (sym) { current = sym; label = marketLabel || sym; } render(); },
    reset() { if (current) { research.reset(current); render(); } },
  };
  try { const v = window.localStorage.getItem(LS_TRIG); const el = $("digResTrigger"); if (v && el) el.value = v; } catch (_) {}
  const el = $("digResTrigger"); if (el) el.addEventListener("change", () => { try { window.localStorage.setItem(LS_TRIG, String(trigger())); } catch (_) {} render(); });
  window.addEventListener("pagehide", () => research.save());
}