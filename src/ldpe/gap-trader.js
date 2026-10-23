// Digit Research trader (pure logic). Trades DIGITMATCH through the LDPE Executor ONLY (Executor.placeTick),
// with the same continuous-cycle algorithm as LDPE: one purchase per non-target tick, the tick on which the
// target appears is never bought, a confirmed win or the target appearing ends the cycle, and the stake
// progression is reset at every cycle boundary. It performs no analysis of its own: the target is simply the
// digit with the highest CURRENT gap, and a cycle only starts when that gap has reached the trigger gap.

const CONTRACT = "DIGITMATCH";
const keep = (arr, n) => { while (arr.length > n) arr.shift(); };

export function statusOf(o) {
  return { pricing: "submitted", buying: "submitted", open: "confirmed", settled: "confirmed", rejected: "failed", unknown: "unresolved" }[o.state] || "submitted";
}

export class GapTrader {
  // opts: { k(), stake(), trigger(), resetStake(), gaps(symbol) -> number[10] | null, onChange() }
  constructor(executor, opts) {
    this.ex = executor; this.opts = opts;
    this.armed = false; this.cycle = null; this.cycleSeq = 0; this.waiting = false;
    this.lastSeq = -1; this.last = null;          // last tick seen: { symbol, seq, epoch, digit }
    this.intentions = []; this.byKey = new Map(); this.cycles = [];
    executor.on((o, ev) => this._onOrder(o, ev));
  }
  _changed() { if (this.opts.onChange) { try { this.opts.onChange(); } catch (_) {} } }
  _reset() { if (this.opts.resetStake) { try { this.opts.resetStake(); } catch (_) {} } }
  setArmed(b) { this.armed = !!b; if (!this.armed) this._end("disarmed"); this._changed(); }

  _onOrder(o, ev) {
    const it = o.intent && this.byKey.get(o.intent.key); if (!it) return;
    it.status = statusOf(o); it.reason = o.reason || null; it.contractId = o.contractId || null;
    if (ev === "settled" && o.result === "won" && !it.winSeen) {
      it.winSeen = true;
      if (this.cycle && this.cycle.id === o.intent.cycleId) this._end("win confirmed");
    }
    this._changed();
  }

  _end(reason) {
    const c = this.cycle; if (!c) return;
    c.endReason = reason; this.cycles.push(c); keep(this.cycles, 100);
    this.cycle = null; this._reset();
  }

  // Highest current gap and its digit (ties: lower digit); unseen digits have null gaps and are ignored.
  topGap(symbol) {
    const g = this.opts.gaps(symbol); if (!g) return null;
    let best = null;
    for (let d = 0; d < 10; d++) if (g[d] != null && (!best || g[d] > best.gap)) best = { digit: d, gap: g[d] };
    return best;
  }

  // One call per accepted tick, after the research gaps were updated for that tick.
  // t = { symbol, seq, epoch, digit, active }
  onTick(t) {
    if (t.seq <= this.lastSeq) return { ignored: "duplicate or out-of-order tick" };
    this.lastSeq = t.seq; this.last = { symbol: t.symbol, seq: t.seq, epoch: t.epoch, digit: t.digit };
    if (!this.armed || !t.active) { this._end(this.armed ? "automatic trading stopped" : "disarmed"); this.waiting = false; this._changed(); return { idle: true }; }
    if (this.cycle) {
      if (t.digit !== this.cycle.target) return this._intend(t);
      this._end(`target ${t.digit} appeared`);       // the target tick is never bought
    }
    const top = this.topGap(t.symbol), trig = Math.max(1, Number(this.opts.trigger()) || 1);
    if (top && top.gap >= trig) {
      this._reset();
      this.cycle = { id: "R:" + (++this.cycleSeq), n: this.cycleSeq, symbol: t.symbol, target: top.digit, startGap: top.gap, trigger: trig, intentions: 0 };
      this.waiting = false; this._changed();
      return { started: this.cycle.id, target: top.digit };
    }
    this.waiting = true; this._changed();
    return { waiting: true };
  }

  _place(t, digit, keyPrefix, cycleId, manual) {
    const key = `${keyPrefix}${t.symbol}:${t.seq}:${t.epoch}`;
    const it = { key, cycleId, symbol: t.symbol, tickSeq: t.seq, tickEpoch: t.epoch, tickDigit: t.digit, target: digit, manual: !!manual, at: Date.now(), status: "intended", reason: null, contractId: null };
    this.intentions.push(it); keep(this.intentions, 300); this.byKey.set(key, it);
    const r = this.ex.placeTick({ symbol: t.symbol, digit, k: this.opts.k(), contractType: CONTRACT, stake: this.opts.stake(), tickSeq: t.seq, tickEpoch: t.epoch, tickDigit: t.digit, cycleId, keyPrefix, manual: !!manual, forecast: null });
    if (!r.ok) { it.status = "failed"; it.reason = r.reason; } else if (it.status === "intended") it.status = "submitted";
    this._changed();
    return { ok: r.ok, reason: r.reason, intention: it };
  }

  _intend(t) { this.cycle.intentions++; return this._place(t, this.cycle.target, "R:", this.cycle.id, false); }

  // Manual trade on the latest tick: independent of Arm and of the Stop switch.
  manual(digit) {
    const d = Number(digit);
    if (!Number.isInteger(d) || d < 0 || d > 9) return { ok: false, reason: "invalid digit" };
    if (!this.last) return { ok: false, reason: "no tick received yet" };
    return this._place(this.last, d, `M${d}:`, "M", true);
  }

  countsForStake(contractId) {
    const o = this.ex.byContract.get(String(contractId));
    if (!o || !o.intent || typeof o.intent.cycleId !== "string" || !o.intent.cycleId.startsWith("R:")) return true;
    return !!this.cycle && this.cycle.id === o.intent.cycleId;
  }

  counts() {
    const c = { submitted: 0, confirmed: 0, failed: 0, unresolved: 0 };
    for (const it of this.intentions) if (c[it.status] !== undefined) c[it.status]++;
    c.total = this.intentions.length; return c;
  }
}
