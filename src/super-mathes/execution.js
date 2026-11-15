import { accountDay, assessTradeRisk } from "./tradingRisk.js?v=3";

const CONFIG_KEYS = ["baseStake", "maximumStake", "maximumExposure", "cycleLoss", "sessionLoss", "cycleTarget",
  "sessionTarget", "dailyTarget", "maxAttempts", "martingale", "multiplierNumerator", "multiplierDenominator",
  "timeZone", "windowSize", "frequencyWeight", "durationTicks"];

// The host must hold exclusive ownership for the entire durable-write lifetime.
export class ResearchExecution {
  constructor({ host, store, research, now = Date.now }) {
    this.host = host;
    this.store = store;
    this.research = research;
    this.now = now;
    this.state = null;
    this.running = false;
    this.busy = false;
    this.generation = 0;
  }

  async save() {
    if (this.host.ownsExecution() !== true) throw new Error("Exclusive execution ownership lost");
    await this.store.save(structuredClone(this.state));
  }

  archiveUnknown() {
    const { order, cycle, session, history } = this.state;
    if (!order || !["buying", "unknown"].includes(order.phase) || !cycle || !session || !Array.isArray(history) ||
        !Number.isSafeInteger(order.stake) || order.stake <= 0 ||
        !Number.isSafeInteger(cycle.attempts) || cycle.attempts < 0 ||
        !Number.isSafeInteger(cycle.staked) || cycle.staked < 0 ||
        !Number.isSafeInteger(session.uncertainExposure ?? 0) || (session.uncertainExposure ?? 0) < 0) {
      throw new Error("Unconfirmed purchase record is invalid");
    }
    const exposure = (session.uncertainExposure ?? 0) + order.stake;
    const staked = cycle.staked + order.stake, attempts = cycle.attempts + 1;
    if (![exposure, staked, attempts].every(Number.isSafeInteger)) throw new Error("Unconfirmed purchase would overflow the ledger");
    session.uncertainExposure = exposure;
    history.push({ ...structuredClone(order), phase: "unknown" });
    history.push({ cycle: { ...structuredClone(cycle), staked, attempts, unresolved: false, uncertainExposure: order.stake },
      termination: "purchase outcome unknown; not reconciled" });
    this.state.order = null;
    this.state.cycle = null;
  }

  async restore(accountId) {
    if (this.host.ownsExecution() !== true) throw new Error("Exclusive execution ownership is required");
    const saved = await this.store.load(accountId);
    this.running = false;
    if (!saved) { this.state = null; return null; }
    this.state = saved;
    if (this.state.order?.phase === "pricing") {
      this.state.order.phase = "cancelled";
      this.state.reason = "Restarted before purchase";
    } else if (["buying", "unknown"].includes(this.state.order?.phase)) {
      this.archiveUnknown();
      this.state.reason = "Purchase outcome unknown; stopped without retry or reconciliation";
    } else if (this.state.order?.phase === "open") {
      this.state.reason = "Restored; reconcile before restarting";
    } else {
      this.state.reason = "Restored; trading stopped";
    }
    await this.save();
    return structuredClone(this.state);
  }

  async start(config) {
    if (this.running || this.busy) throw new Error("Trading controller is already active");
    if (this.host.ownsExecution() !== true) throw new Error("Exclusive execution ownership is required");
    if (!config || Object.keys(config).some(key => !CONFIG_KEYS.includes(key)) ||
        !Number.isInteger(config.windowSize) || config.windowSize < 20 || config.windowSize > 10000 ||
        !Number.isInteger(config.durationTicks) || config.durationTicks < 1 || config.durationTicks > 10 ||
        !Number.isFinite(config.frequencyWeight) || config.frequencyWeight <= 0 || config.frequencyWeight >= 1) {
      throw new Error("Invalid execution settings");
    }
    this.busy = true;
    const generation = this.generation;
    try {
      const account = this.host.account(), feed = this.host.feed();
      if (!account || !feed || !account.id) throw new Error("Account and feed are required");
      if (!Number.isSafeInteger(feed.segment) || feed.segment < 1) throw new Error("Feed segment is unavailable");
      accountDay(this.now(), config.timeZone);
      const saved = await this.store.load(account.id);
      if (saved && (saved.order?.phase === "buying" || saved.order?.phase === "unknown" || saved.order?.phase === "open")) {
        throw new Error("A previous contract requires reconciliation");
      }
      if (saved && (saved.session.currency !== account.currency || saved.session.isVirtual !== account.isVirtual ||
          saved.config.timeZone !== config.timeZone)) throw new Error("Account identity or time zone changed");
      const day = accountDay(this.now(), config.timeZone);
      const session = saved?.session || { accountId: account.id, isVirtual: account.isVirtual, currency: account.currency, pnl: 0, daily: {} };
      const candidate = saved?.cycle || { source: feed.source, pnl: 0, staked: 0, losses: 0, attempts: 0, unresolved: false };
      if (saved?.cycle && saved.cycle.segment !== feed.segment) throw new Error("Feed segment changed; close the stopped cycle");
      const decision = assessTradeRisk({ config, account, session: { ...session, dailyPnl: session.daily[day] ?? 0 },
        cycle: candidate, feed, stakeQuantum: this.host.stakeQuantum ?? 1 });
      if (!decision.allowed) throw new Error(decision.reason);
      this.state = saved ? { ...saved, config: { ...config }, reason: "Running" } : {
        accountId: account.id, config: { ...config }, session, cycle: null, order: null, history: [], reason: "Running",
      };
      await this.save();
      if (generation !== this.generation) throw new Error("Start cancelled");
      if (this.host.ownsExecution() !== true) throw new Error("Exclusive execution ownership lost");
      this.running = true;
      this.generation++;
    } finally { this.busy = false; }
  }

  requestStop() {
    this.running = false;
    this.generation++;
  }

  async stop(reason = "Stopped by user") {
    this.requestStop();
    if (this.state) {
      this.state.reason = reason;
      await this.save();
    }
  }

  async closeCycle() {
    if (this.running || this.busy) throw new Error("Stop trading before closing a cycle");
    if (!this.state?.cycle) throw new Error("There is no active cycle to close");
    if (this.state.cycle.unresolved || ["buying", "unknown", "open"].includes(this.state.order?.phase)) {
      throw new Error("Reconcile the unresolved order before closing its cycle");
    }
    if (this.state.order?.phase === "pricing") this.state.order.phase = "cancelled";
    this.state.history.push({ cycle: structuredClone(this.state.cycle), termination: "closed by user" });
    this.state.cycle = null;
    this.state.reason = "Cycle closed by user";
    await this.save();
  }

  risk() {
    const account = this.host.account(), feed = this.host.feed();
    if (this.state.cycle.segment !== feed?.segment) return { allowed: false, reason: "Feed segment changed; close the stopped cycle" };
    const day = accountDay(this.now(), this.state.config.timeZone);
    return assessTradeRisk({ config: this.state.config, account, feed, cycle: this.state.cycle,
      session: { ...this.state.session, dailyPnl: this.state.session.daily[day] ?? 0 }, stakeQuantum: this.host.stakeQuantum ?? 1 });
  }

  async onTick() {
    if (!this.running || this.busy) return;
    this.busy = true;
    const generation = this.generation;
    try {
      if (this.host.ownsExecution() !== true) throw new Error("Exclusive execution ownership lost");
      if (this.state.order && ["buying", "unknown", "open"].includes(this.state.order.phase)) return;
      const feed = this.host.feed();
      if (!feed?.continuous || !feed.source || !Number.isSafeInteger(feed.segment) || feed.segment < 1) {
        throw new Error("Feed continuity unavailable");
      }
      if (!this.state.cycle) {
        const row = await this.research.createModelPrediction(this.state.config.windowSize, "combined", this.state.config.frequencyWeight);
        if (!this.running || generation !== this.generation) return;
        if (row.source !== feed.source || row.prediction.model !== "combined-frequency-markov" || !row.prediction.evidence ||
            !Number.isInteger(row.prediction.selectedDigit) || row.prediction.selectedDigit < 0 || row.prediction.selectedDigit > 9) {
          throw new Error("Combined prediction source or evidence is invalid");
        }
        this.state.cycle = { id: row.id, source: row.source, segment: feed.segment, digit: row.prediction.selectedDigit,
          pnl: 0, staked: 0, losses: 0, attempts: 0, unresolved: false };
        await this.save();
      }
      const original = await this.research.getPrediction(this.state.cycle.id);
      if (!this.running || generation !== this.generation) return;
      if (!original || original.source !== this.state.cycle.source ||
          original.prediction?.model !== "combined-frequency-markov" ||
          original.prediction.selectedDigit !== this.state.cycle.digit) {
        throw new Error("Original cycle prediction is unavailable or changed");
      }
      let decision = this.risk();
      if (!decision.allowed) throw new Error(decision.reason);
      const order = { id: crypto.randomUUID(), cycleId: this.state.cycle.id, digit: this.state.cycle.digit,
        accountId: this.state.session.accountId, currency: this.state.session.currency,
        source: this.state.cycle.source, durationTicks: this.state.config.durationTicks,
        stake: decision.stake, phase: "pricing", createdAt: this.now() };
      this.state.order = order;
      await this.save();
      let proposal;
      try {
        proposal = await this.host.proposal({ source: this.state.cycle.source, digit: order.digit,
          stake: order.stake, durationTicks: order.durationTicks });
      } catch {
        throw new Error("Contract proposal failed; purchase not sent");
      }
      if (!this.running || generation !== this.generation) return;
      if (this.host.ownsExecution() !== true) throw new Error("Exclusive execution ownership lost");
      await this.host.verifyAuthorization();
      if (!this.running || generation !== this.generation) return;
      decision = this.risk();
      if (!decision.allowed || decision.stake !== order.stake) throw new Error(decision.reason || "Stake changed");
      if (!proposal || typeof proposal.id !== "string" || !proposal.id || proposal.askPrice !== order.stake) {
        throw new Error("Proposal price or identity is invalid");
      }
      order.proposalId = proposal.id;
      order.quotedPrice = proposal.askPrice;
      order.phase = "buying";
      this.state.cycle.unresolved = true;
      await this.save();
      if (!this.running || generation !== this.generation || this.host.ownsExecution() !== true) {
        order.phase = "cancelled";
        this.state.cycle.unresolved = false;
        await this.save();
        return;
      }
      try {
        decision = this.riskBeforeBuy(order);
      } catch (error) {
        order.phase = "cancelled";
        this.state.cycle.unresolved = false;
        throw error;
      }
      if (!decision.allowed) {
        order.phase = "cancelled";
        this.state.cycle.unresolved = false;
        throw new Error(decision.reason);
      }
      let buy;
      try { buy = await this.host.buy(order.proposalId, order.quotedPrice); }
      catch {
        order.phase = "unknown";
        throw new Error("Purchase outcome unknown; stopped without retry or reconciliation");
      }
      if (!buy || !/^[1-9]\d*$/.test(String(buy.contractId)) || buy.buyPrice !== order.stake ||
          (buy.transactionId !== undefined && !/^[1-9]\d*$/.test(String(buy.transactionId)))) {
        order.phase = "unknown";
        throw new Error("Purchase response is incomplete; stopped without retry or reconciliation");
      }
      order.contractId = String(buy.contractId);
      if (buy.transactionId !== undefined) order.transactionId = String(buy.transactionId);
      order.phase = "open";
      this.state.cycle.attempts++;
      this.state.cycle.staked += order.stake;
      await this.save();
    } catch (error) {
      if (this.state?.order?.phase === "pricing") this.state.order.phase = "cancelled";
      if (this.state?.order?.phase === "unknown") this.archiveUnknown();
      this.running = false;
      this.generation++;
      if (this.state) { this.state.reason = error.message; await this.save(); }
      throw error;
    } finally { this.busy = false; }
  }

  riskBeforeBuy(order) {
    const cycle = { ...this.state.cycle, unresolved: false };
    if (cycle.segment !== this.host.feed()?.segment) return { allowed: false, reason: "Feed segment changed; close the stopped cycle" };
    const day = accountDay(this.now(), this.state.config.timeZone);
    const decision = assessTradeRisk({ config: this.state.config, account: this.host.account(), feed: this.host.feed(), cycle,
      session: { ...this.state.session, dailyPnl: this.state.session.daily[day] ?? 0 }, stakeQuantum: this.host.stakeQuantum ?? 1 });
    if (decision.allowed && decision.stake !== order.stake) return { allowed: false, reason: "Stake changed before purchase" };
    return decision;
  }

  async reconcile() {
    if (this.busy) return false;
    if (this.host.ownsExecution() !== true) throw new Error("Exclusive execution ownership is required");
    const order = this.state?.order;
    if (!order || order.phase !== "open" || !order.contractId) return false;
    this.busy = true;
    try {
      const account = this.host.account();
      if (!account.connected || !account.authorized || account.id !== this.state.accountId ||
          account.isVirtual !== this.state.session.isVirtual || account.currency !== this.state.session.currency) {
        throw new Error("Reconnect the original account to reconcile the contract");
      }
      let result;
      try { result = await this.host.contract(order.contractId, structuredClone(order)); }
      catch (error) { throw new Error(`Contract status unavailable: ${error.message}`); }
      if (!result || String(result.contractId) !== order.contractId) throw new Error("Contract identity cannot be verified");
      if (result.status !== "won" && result.status !== "lost") return false;
      if (!Number.isSafeInteger(result.profit) || !Number.isSafeInteger(result.payout) || result.payout < 0 ||
          result.payout !== order.stake + result.profit ||
          !Number.isSafeInteger(result.settledAt) || result.settledAt < 0 ||
          (result.status === "won" ? result.profit <= 0 : result.profit >= 0)) throw new Error("Contract outcome is incomplete");
      const day = accountDay(result.settledAt, this.state.config.timeZone);
      const cycle = this.state.cycle, session = this.state.session;
      if (![cycle.pnl + result.profit, session.pnl + result.profit,
        (session.daily[day] ?? 0) + result.profit].every(Number.isSafeInteger)) {
        throw new Error("Settlement would overflow the ledger");
      }
      cycle.pnl += result.profit;
      session.pnl += result.profit;
      session.daily[day] = (session.daily[day] ?? 0) + result.profit;
      cycle.unresolved = false;
      order.phase = "settled";
      order.result = { contractId: order.contractId, status: result.status, profit: result.profit, payout: result.payout, settledAt: result.settledAt };
      this.state.history.push(structuredClone(order));
      if (result.status === "lost") cycle.losses++;
      else {
        this.state.history.push({ cycle: structuredClone(cycle), termination: "confirmed match" });
        if (cycle.pnl >= this.state.config.cycleTarget) {
          this.running = false;
          this.state.reason = "Cycle profit target reached";
        }
        this.state.cycle = null;
      }
      if (session.pnl <= -this.state.config.sessionLoss || session.pnl >= this.state.config.sessionTarget ||
          session.daily[day] >= this.state.config.dailyTarget ||
          (result.status === "lost" && cycle.pnl <= -this.state.config.cycleLoss)) {
        this.running = false;
        this.state.reason = "Session, daily or cycle limit reached";
      }
      await this.save();
      return true;
    } catch (error) {
      this.running = false;
      this.generation++;
      this.state.reason = error.message;
      await this.save();
      throw error;
    } finally { this.busy = false; }
  }
}
