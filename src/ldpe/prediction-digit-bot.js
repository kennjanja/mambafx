// Overlapping DIGITMATCH cycles use confirmed contract outcomes, not observed tick digits.
const PREFIX = "PDT:";
const LIVE = new Set(["pricing", "buying", "open", "unknown"]);

export class PredictionDigitBot {
  constructor(executor, onChange = () => {}) {
    this.ex = executor;
    this.onChange = onChange;
    this.armed = false;
    this.cycle = null;
    this.cycleNumber = 0;
    this.pnl = 0;
    this.reason = "Disarmed";
    this.lastSeq = -1;
    this.lastEpoch = -1;
    this.sessionOrders = new Set();
    executor.on((order, event) => this.onOrder(order, event));
  }

  owns(order) { return typeof order.intent?.cycleId === "string" && order.intent.cycleId.startsWith(PREFIX); }
  hasUnresolved() { return [...this.ex.orders.values()].some(o => this.owns(o) && LIVE.has(o.state)); }

  arm(settings) {
    if (this.armed) return { ok: false, reason: "Already armed" };
    if (this.hasUnresolved()) return { ok: false, reason: "Previous orders are unresolved or still open; reconcile and settle them before starting." };
    if (this.ex.stopped) return { ok: false, reason: "LDPE automatic trading is stopped." };
    const mismatch = this.ex.accountMismatch();
    if (mismatch) return { ok: false, reason: mismatch };
    const { stake, multiplier, targetProfit, stopLoss, duration, symbol } = settings;
    if (!Number.isFinite(stake) || stake < 0.35 || !Number.isFinite(multiplier) || multiplier < 1 || multiplier > 10 ||
        !Number.isFinite(targetProfit) || targetProfit <= 0 || !Number.isFinite(stopLoss) || stopLoss <= 0 ||
        !Number.isInteger(duration) || duration < 1 || duration > 10 || !symbol) {
      return { ok: false, reason: "Enter a valid base stake, multiplier, duration, and positive profit and loss limits." };
    }
    this.settings = { ...settings };
    this.accountId = this.ex.host.account().loginId;
    this.sessionOrders.clear();
    this.pnl = 0;
    this.cycle = null;
    this.lastSeq = -1;
    this.lastEpoch = -1;
    this.reason = "Waiting for a current prediction";
    this.armed = true;
    this.onChange();
    return { ok: true };
  }

  stop(reason) {
    this.armed = false;
    this.reason = reason;
    this.ex.cancelPricing(o => this.sessionOrders.has(o.id), "Prediction Digit Trade stopped before purchase");
    this.onChange();
  }

  onOrder(order, event) {
    if (!this.owns(order)) return;
    if (event === "created" && this.armed) this.sessionOrders.add(order.id);
    if (!this.sessionOrders.has(order.id)) return;
    if (event === "unknown") return this.stop("Purchase outcome unknown; reconcile the account before restarting.");
    if (event === "rejected" && !order.cancelledBeforeBuy && this.armed) return this.stop("Order rejected: " + order.reason);
    if (event === "settled") {
      if (!Number.isFinite(order.pnl) || order.pnl === 0) return this.stop("Settlement outcome or profit is unknown; inspect the account.");
      this.pnl += order.pnl;
      if (this.armed && (this.pnl >= this.settings.targetProfit || this.pnl <= -this.settings.stopLoss)) {
        return this.stop(this.pnl >= this.settings.targetProfit ? "Target profit reached" : "Stop loss reached");
      }
      if (this.armed && order.result === "won" && this.cycle && order.intent.cycleId === this.cycle.id) {
        const id = this.cycle.id;
        this.cycle = null;
        this.reason = "Win confirmed; waiting for the next current prediction";
        this.ex.cancelPricing(o => o.intent?.cycleId === id, "Cycle won before purchase");
      }
    }
    this.onChange();
  }

  onTick(t) {
    if (!this.armed) return;
    if (t.symbol !== this.settings.symbol) return this.stop("Market changed; settle open orders before restarting.");
    const account = this.ex.host.account();
    const mismatch = this.ex.accountMismatch(account);
    if (mismatch || account.loginId !== this.accountId || this.ex.stopped) {
      return this.stop(mismatch || (this.ex.stopped ? "LDPE automatic trading stopped" : "Account changed"));
    }
    if (t.seq <= this.lastSeq || t.epoch <= this.lastEpoch) return;
    this.lastSeq = t.seq;
    this.lastEpoch = t.epoch;
    if (!this.cycle) {
      const f = t.forecast;
      if (!f || f.reconstructed || f.symbol !== t.symbol || f.madeAtSeq !== t.seq ||
          f.horizon !== this.settings.duration || !Number.isInteger(f.predictedDigit) || f.predictedDigit < 0 || f.predictedDigit > 9) {
        this.reason = "Waiting for a current prediction";
        this.onChange();
        return;
      }
      this.cycle = { id: PREFIX + (++this.cycleNumber), digit: f.predictedDigit, forecast: f };
    }
    const cycle = this.cycle;
    const count = [...this.ex.orders.values()].filter(o => this.sessionOrders.has(o.id) && o.intent?.cycleId === cycle.id && o.state !== "rejected").length;
    const stake = Math.round(this.settings.stake * Math.pow(this.settings.multiplier, count) * 100) / 100;
    if (!Number.isFinite(stake) || stake > 100000) return this.stop("Calculated stake exceeds the 100000 safety maximum.");
    const r = this.ex.placeTick({
      symbol: t.symbol, digit: cycle.digit, k: this.settings.duration, contractType: "DIGITMATCH",
      stake, tickSeq: t.seq, tickEpoch: t.epoch, tickDigit: t.digit, cycleId: cycle.id,
      keyPrefix: PREFIX, forecast: cycle.forecast,
    });
    if (!r.ok) {
      if (r.reason.startsWith("rate limit:")) { this.reason = r.reason; this.onChange(); return; }
      return this.stop("Order not sent: " + r.reason);
    }
    this.reason = "Trading digit " + cycle.digit;
    this.onChange();
  }
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  const $ = id => document.getElementById(id);
  const ids = ["pdtStake", "pdtMultiplier", "pdtTP", "pdtSL"];
  const storageKey = "ldpe_prediction_digit_settings_v1";
  let bot;
  const getBot = () => {
    if (!bot && window.LDPE?.executor) bot = new PredictionDigitBot(window.LDPE.executor, render);
    return bot;
  };
  const render = () => {
    const b = bot, status = $("pdtStatus"), toggle = $("pdtArm");
    if (!status || !toggle) return;
    toggle.checked = !!b?.armed;
    for (const id of ids) if ($(id)) $(id).disabled = !!b?.armed;
    const open = b ? [...b.ex.orders.values()].filter(o => b.owns(o) && LIVE.has(o.state)).length : 0;
    status.textContent = b ? `${b.armed ? "ARMED" : "OFF"} — ${b.reason}; session P/L ${b.pnl.toFixed(2)}; unresolved/open ${open}.` : "Waiting for LDPE.";
  };
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || "{}");
    for (const id of ids) if ($(id) && saved[id] != null) $(id).value = saved[id];
  } catch (e) { console.warn("[prediction digit bot] could not restore settings", e); }
  for (const id of ids) $(id)?.addEventListener("change", () => {
    try { localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(ids.map(k => [k, $(k).value])))); }
    catch (e) { console.warn("[prediction digit bot] could not save settings", e); }
  });
  window.PDT = {
    arm(on) {
      const b = getBot();
      if (!b) { $("pdtStatus").textContent = "LDPE executor unavailable."; $("pdtArm").checked = false; return; }
      if (!on) { b.stop("Manually stopped"); return; }
      const r = b.arm({
        stake: Number($("pdtStake").value), multiplier: Number($("pdtMultiplier").value),
        targetProfit: Number($("pdtTP").value), stopLoss: Number($("pdtSL").value),
        duration: Number(window.LDPE.settings.k), symbol: window.__ldpeHost.symbol,
      });
      if (!r.ok) { b.reason = r.reason; render(); }
    },
    afterTick(symbol, result, epoch) {
      const b = getBot();
      if (b && result?.accepted) b.onTick({ symbol, seq: window.LDPE.engine.state(symbol).seq, epoch: Number(epoch), digit: result.digit, forecast: result.forecast });
    },
    interrupt(reason) { if (bot?.armed) bot.stop(reason); },
    owns(id) { const b = getBot(); return !!b?.owns(b.ex.byContract.get(String(id)) || {}); },
  };
  window.addEventListener("pagehide", () => window.PDT.interrupt("Page closed; reconcile open orders before restarting."));
  render();
}
