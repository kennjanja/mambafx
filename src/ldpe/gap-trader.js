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
    this.armed = false; this.pnl = 0; this.stopReason = null; this.cooldownLeft = 0; this.cycle = null; this.cycleSeq = 0; this.waiting = false;
    this.lastSeq = -1; this.seqBySymbol = new Map(); this.last = null;          // last tick seen: { symbol, seq, epoch, digit }
    this.intentions = []; this.byKey = new Map(); this.cycles = [];
    executor.on((o, ev) => this._onOrder(o, ev));
  }
  _changed() { if (this.opts.onChange) { try { this.opts.onChange(); } catch (_) {} } }
  _reset() { if (this.opts.resetStake) { try { this.opts.resetStake(); } catch (_) {} } }
  setArmed(b) {
    this.armed = !!b; this.cooldownLeft = 0;
    if (this.armed) { this.pnl = 0; this.stopReason = null; } else this._end("disarmed");
    this._changed();
  }
  // Target profit / stop loss are checked on the realised P/L of this armed session; 0 disables a limit.
  _checkLimits() {
    if (!this.armed) return;
    const tp = Number(this.opts.targetProfit && this.opts.targetProfit()) || 0, sl = Number(this.opts.stopLoss && this.opts.stopLoss()) || 0;
    if (tp > 0 && this.pnl >= tp) { this.setArmed(false); this.stopReason = `target profit reached (${this.pnl.toFixed(2)})`; this._changed(); }
    else if (sl > 0 && this.pnl <= -sl) { this.setArmed(false); this.stopReason = `stop loss reached (${this.pnl.toFixed(2)})`; this._changed(); }
  }

  _onOrder(o, ev) {
    const it = o.intent && this.byKey.get(o.intent.key); if (!it) return;
    if (ev === "settled" && !it.pnlSeen && !it.manual && o.pnl != null) { it.pnlSeen = true; this.pnl += Number(o.pnl) || 0; }
    it.status = statusOf(o); it.reason = o.reason || null; it.contractId = o.contractId || null;
    if (ev === "settled" && o.result === "won" && !it.winSeen) {
      it.winSeen = true;
      if (this.cycle && this.cycle.id === o.intent.cycleId) this._end("win confirmed");
    }
    this._checkLimits();
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
    // tick sequence numbers are per market, so duplicates are detected per market
    const prev = this.seqBySymbol.has(t.symbol) ? this.seqBySymbol.get(t.symbol) : -1;
    if (t.seq <= prev) return { ignored: "duplicate or out-of-order tick" };
    this.seqBySymbol.set(t.symbol, t.seq);
    // the market was switched mid-cycle: that cycle's target digit belongs to the old market
    if (this.cycle && this.cycle.symbol !== t.symbol) { this._end("market changed"); this.cooldownLeft = 0; }
    this.lastSeq = t.seq; this.last = { symbol: t.symbol, seq: t.seq, epoch: t.epoch, digit: t.digit };
    if (!this.armed || !t.active) { this._end(this.armed ? "automatic trading stopped" : "disarmed"); this.waiting = false; this._changed(); return { idle: true }; }
    if (this.cycle) {
      if (t.digit !== this.cycle.target) {
        if (this.cooldownLeft > 0) { this.cooldownLeft--; this._changed(); return { cooldown: this.cooldownLeft }; }
        const g = this.opts.gaps(t.symbol), cur = g ? g[this.cycle.target] : null;
        const rules = (this.opts.cooldowns && this.opts.cooldowns()) || [];
        for (let i = 0; i < rules.length; i++) {
          const r = rules[i];
          if (r && r.gap > 0 && r.ticks > 0 && cur != null && cur >= r.gap && !this.cycle.cdFired[i]) {
            this.cycle.cdFired[i] = true; this.cooldownLeft = r.ticks - 1; this._changed();
            return { cooldown: r.ticks };
          }
        }
        return this._intend(t);
      }
      this._end(`target ${t.digit} appeared`);       // the target tick is never bought
    }
    const top = this.topGap(t.symbol), trig = Math.max(1, Number(this.opts.trigger()) || 1);
    if (top && top.gap >= trig) {
      this._reset();
      this.cycle = { id: "R:" + (++this.cycleSeq), n: this.cycleSeq, symbol: t.symbol, target: top.digit, startGap: top.gap, trigger: trig, intentions: 0, cdFired: [false, false] };
      this.cooldownLeft = 0;
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
