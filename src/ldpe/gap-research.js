// Gap research: for each market, records every COMPLETED gap of each digit (the number of consecutive ticks
// without that digit between two occurrences of it) and ranks the longest ones with how many times that exact
// gap length has occurred for that digit. Read-only research: it never feeds predictions or orders.
// The open gap before a digit's first observed occurrence is unknown (its start was not seen) and is skipped.

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

  // Top completed gaps across all digits, longest first (ties: more frequent first, then lower digit).
  top(sym, n = TOP_N) {
    const s = this.m[sym]; if (!s) return [];
    const rows = [];
    for (let d = 0; d < 10; d++) for (const [g, c] of Object.entries(s.hist[d])) rows.push({ digit: d, gap: Number(g), frequency: c });
    rows.sort((a, b) => b.gap - a.gap || b.frequency - a.frequency || a.digit - b.digit);
    return rows.slice(0, n);
  }
  ticks(sym) { return this.m[sym] ? this.m[sym].ticks : 0; }
  reset(sym) { delete this.m[sym]; this.save(); }
}

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

if (typeof window !== "undefined" && typeof document !== "undefined") {
  const research = new GapResearch(window.localStorage);
  let current = null, label = "";
  const render = () => {
    const body = document.getElementById("digResearchBody"); if (!body || !current) return;
    const rows = research.top(current);
    body.innerHTML = rows.length
      ? rows.map((r, i) => `<tr><td>${i + 1}</td><td><b>${r.digit}</b></td><td>${r.gap}</td><td>${r.frequency}</td></tr>`).join("")
      : `<tr><td colspan="4" style="color:var(--muted)">No completed gaps recorded yet for this market.</td></tr>`;
    const m = document.getElementById("digResearchMarket"); if (m) m.textContent = label || current;
    const t = document.getElementById("digResearchTicks"); if (t) t.textContent = String(research.ticks(current));
  };
  window.GAPRES = {
    research,
    ingest(sym, digit, epoch, marketLabel) {
      current = sym; label = marketLabel || sym;
      if (research.ingest(sym, digit, epoch)) render();
    },
    render(sym, marketLabel) { if (sym) { current = sym; label = marketLabel || sym; } render(); },
    reset() { if (current) { research.reset(current); render(); } },
  };
  window.addEventListener("pagehide", () => research.save());
}
