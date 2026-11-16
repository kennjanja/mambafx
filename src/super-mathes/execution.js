import { accountDay, assessTradeRisk } from "./tradingRisk.js?v=3";

const CONFIG_KEYS = ["baseStake", "maximumStake", "maximumExposure", "cycleLoss", "sessionLoss", "cycleTarget",
  "sessionTarget", "dailyTarget", "maxAttempts", "martingale", "multiplierNumerator", "multiplierDenominator",
  "timeZone", "windowSize", "frequencyWeight", "durationTicks"];
const MAX_OPEN_ORDERS = 2;
const LIVE_PHASES = new Set(["pricing", "buying", "open", "unknown"]);

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

  orders() { return this.state.orders; }

  liveOrders(cycleId) {
    return this.orders().filter(order => LIVE_PHASES.has(order.phase) && (cycleId === undefined || order.cycleId === cycleId));
  }

  cycleById(id) {
    if (this.state.cycle?.id === id) return this.state.cycle;
    return this.state.closedCycles.find(cycle => cycle.id === id);
  }

  finalizeCycle(cycle) {
    if (!cycle?.closed || this.liveOrders(cycle.id).length) return;
    this.state.history.push({ cycle: structuredClone(cycle), termination: cycle.termination || "cycle completed" });
    this.state.closedCycles = this.state.closedCycles.filter(item => item.id !== cycle.id);
  }

  async restore(accountId) {
    if (this.host.ownsExecution() !== true) throw new Error("Exclusive execution ownership is required");
    const saved = await this.store.load(accountId);
    this.running = false;
    if (!saved) { this.state = null; return null; }
    this.state = saved;
    this.state.history ||= [];
    this.state.closedCycles ||= [];
    this.state.orders ||= saved.order ? [saved.order] : [];
    delete this.state.order;
    for (const order of [...this.orders()]) {
      if (order.phase === "pricing") {
        order.phase = "cancelled";
        this.orders().splice(this.orders().indexOf(order), 1);
      } else if (order.phase === "buying") {
        order.phase = "unknown";
      }
    }
    this.state.cycle && (this.state.cycle.unresolved = false);
    if (this.orders().some(order => order.phase === "unknown")) this.state.reason = "Purchase response missing; recover from the Deriv account before trading";
    else if (this.liveOrders().length) this.state.reason = "Restored; reconcile open contracts before restarting";
    else this.state.reason ||= "Restored; trading stopped";
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
      if (!account || !feed?.continuous || !account.id || !feed.source ||
          !Number.isSafeInteger(feed.segment) || feed.segment < 1 ||
          !Number.isSafeInteger(feed.sequence) || feed.sequence < 1 ||
          !Number.isSafeInteger(feed.epoch) || feed.epoch < 0) throw new Error("Wait for a continuous Super Mathes feed before starting");
      accountDay(this.now(), config.timeZone);
      const saved = await this.store.load(account.id);
      if (saved && ((saved.orders || (saved.order ? [saved.order] : [])).some(order => ["buying", "unknown", "open"].includes(order.phase)))) {
        throw new Error("Open or uncertain contracts must settle before restarting");
      }
      if (saved && (saved.session.currency !== account.currency || saved.session.isVirtual !== account.isVirtual ||
          saved.config.timeZone !== config.timeZone)) throw new Error("Account identity or time zone changed");
      const day = accountDay(this.now(), config.timeZone);
      const session = saved?.session || { accountId: account.id, isVirtual: account.isVirtual, currency: account.currency, pnl: 0, daily: {} };
      let cycle = saved?.cycle || null;
      if (cycle && cycle.segment !== feed.segment) {
        this.state = { ...(saved || {}), accountId: account.id, config: { ...config }, session,
          cycle, closedCycles: saved?.closedCycles || [], orders: [], history: saved?.history || [] };
        cycle.closed = true;
        cycle.termination = "feed continuity changed";
        this.state.cycle = null;
        this.finalizeCycle(cycle);
        cycle = null;
      }
      const candidate = cycle || { source: feed.source, pnl: 0, staked: 0, losses: 0, attempts: 0, unresolved: false };
      const decision = assessTradeRisk({ config, account, session: { ...session, dailyPnl: session.daily[day] ?? 0 },
        cycle: candidate, feed, stakeQuantum: this.host.stakeQuantum ?? 1 });
      if (!decision.allowed) throw new Error(decision.reason);
      this.state = saved ? { ...saved, cycle, orders: [], history: this.state?.history || saved.history || [],
        closedCycles: this.state?.closedCycles || saved.closedCycles || [], config: { ...config },
        resumeAfterRecovery: false, reason: "Running" } : {
        accountId: account.id, config: { ...config }, session, cycle: null, closedCycles: [], orders: [], history: [], reason: "Running",
      };
      this.state.lastSequence = feed.sequence;
      this.state.lastEpoch = feed.epoch;
      await this.save();
      if (generation !== this.generation) throw new Error("Start cancelled");
      if (this.host.ownsExecution() !== true) throw new Error("Exclusive execution ownership lost");
      this.running = true;
      this.generation++;
    } finally { this.busy = false; }
  }

  requestStop(preserveRecoveryResume = false) {
    this.running = false;
    if (this.state && !preserveRecoveryResume) this.state.resumeAfterRecovery = false;
    this.generation++;
  }

  async stop(reason = "Stopped by user", preserveRecoveryResume = false) {
    this.requestStop(preserveRecoveryResume);
    if (this.state) {
      this.state.reason = reason;
      await this.save();
    }
  }

  async recoverUnknown(orderId) {
    if (this.busy) return false;
    if (this.host.ownsExecution() !== true) throw new Error("Exclusive execution ownership is required");
    const order = this.orders().find(item => item.id === orderId && item.phase === "unknown");
    if (!order) return false;
    const now = this.now();
    if (!Number.isSafeInteger(order.purchaseStartedAt) || order.purchaseStartedAt < 0 ||
        !Number.isSafeInteger(now) || now < order.purchaseStartedAt) {
      this.state.reason = "Purchase response is unknown and lacks a safe recovery timestamp";
      await this.save();
      return false;
    }
    if (Number.isSafeInteger(order.lastRecoveryAt) && now - order.lastRecoveryAt < 3000) return false;
    this.busy = true;
    let recoveredContract = null;
    try {
      const account = this.host.account();
      if (!account.connected || !account.authorized || account.id !== order.accountId ||
          account.id !== this.state.accountId || account.isVirtual !== this.state.session.isVirtual ||
          account.currency !== order.currency || account.currency !== this.state.session.currency) {
        throw new Error("Reconnect the original authorized account to recover this purchase");
      }
      if (typeof this.host.recover !== "function") throw new Error("Deriv purchase recovery is unavailable");
      order.lastRecoveryAt = now;
      order.recoveryAttempts = (order.recoveryAttempts || 0) + 1;
      this.state.reason = "Checking Deriv open contracts and transaction history for the missing purchase response";
      await this.save();
      const knownIds = [
        ...this.orders().filter(item => item.id !== order.id).map(item => item.contractId),
        ...this.state.history.map(item => item.contractId || item.result?.contractId),
      ].filter(Boolean);
      const recovery = await this.host.recover(structuredClone(order), knownIds);
      if (recovery?.status === "not_found") {
        this.state.reason = "No matching purchase is visible yet; continuing account reconciliation without resending the buy";
        await this.save();
        return false;
      }
      if (recovery?.status === "ambiguous") {
        this.state.reason = "Multiple Deriv contracts match the uncertain purchase; trading remains stopped for safe manual reconciliation";
        await this.save();
        return false;
      }
      const result = recovery?.contract;
      if (recovery?.status !== "found" || !result || !/^[1-9]\d*$/.test(String(result.contractId)) ||
          !["open", "won", "lost"].includes(result.status) ||
          (recovery.transactionId !== undefined && !/^[1-9]\d*$/.test(String(recovery.transactionId)))) {
        throw new Error("Deriv recovery returned an incomplete contract identity");
      }
      const cycle = this.cycleById(order.cycleId);
      if (!cycle || !Number.isSafeInteger(cycle.attempts) || !Number.isSafeInteger(cycle.staked) ||
          !Number.isSafeInteger(cycle.attempts + 1) || !Number.isSafeInteger(cycle.staked + order.stake)) {
        throw new Error("Recovered contract does not match a valid trading cycle");
      }
      order.contractId = String(result.contractId);
      order.transactionId = recovery.transactionId === undefined ? result.transactionId : String(recovery.transactionId);
      order.phase = "open";
      order.counted = true;
      cycle.attempts++;
      cycle.staked += order.stake;
      recoveredContract = result;
      this.state.reason = `Recovered Deriv contract ${order.contractId}; no duplicate purchase sent`;
      await this.save();
    } catch (error) {
      this.state.reason = error.message;
      await this.save();
      throw error;
    } finally { this.busy = false; }
    if (recoveredContract?.status !== "open") await this.reconcile(order.id);
    return true;
  }

  async resumeRecovered() {
    if (this.busy || this.running || !this.state?.resumeAfterRecovery ||
        this.orders().some(order => order.phase === "unknown")) return false;
    if (this.host.ownsExecution() !== true) throw new Error("Exclusive execution ownership is required");
    const feed = this.host.feed();
    if (!feed?.continuous || !Number.isSafeInteger(feed.sequence) || !Number.isSafeInteger(feed.epoch)) return false;
    if (this.state.cycle && this.state.cycle.segment !== feed.segment) {
      const cycle = this.state.cycle;
      cycle.closed = true;
      cycle.termination = "feed continuity changed during purchase recovery";
      this.state.cycle = null;
      if (this.liveOrders(cycle.id).length) this.state.closedCycles.push(cycle);
      this.finalizeCycle(cycle);
    }
    const cycle = this.state.cycle || { source: feed.source, segment: feed.segment, pnl: 0, staked: 0,
      losses: 0, attempts: 0, unresolved: false };
    const decision = this.assess(cycle);
    if (!decision.allowed) {
      this.state.resumeAfterRecovery = false;
      this.state.reason = decision.reason;
      await this.save();
      return false;
    }
    this.state.lastSequence = feed.sequence;
    this.state.lastEpoch = feed.epoch;
    this.state.resumeAfterRecovery = false;
    this.state.reason = "Purchase recovered; burst trading resumed on the next accepted tick";
    await this.save();
    this.running = true;
    this.generation++;
    return true;
  }

  async closeCycle() {
    if (this.running || this.busy) throw new Error("Stop trading before closing a cycle");
    const cycle = this.state?.cycle;
    if (!cycle) throw new Error("There is no active cycle to close");
    if (this.liveOrders(cycle.id).length) throw new Error("Wait for the current cycle's open contracts to settle");
    cycle.closed = true;
    cycle.termination = "closed by user";
    this.state.cycle = null;
    this.finalizeCycle(cycle);
    this.state.reason = "Cycle closed by user";
    await this.save();
  }

  reservedExposure(excludeOrderId) {
    return (this.state.session.uncertainExposure ?? 0) + this.liveOrders()
      .filter(order => order.id !== excludeOrderId)
      .reduce((sum, order) => sum + order.stake, 0);
  }

  effectiveCycle(cycle, excludeOrderId) {
    const pending = this.liveOrders(cycle.id).filter(order => order.id !== excludeOrderId).length;
    return { ...cycle, losses: cycle.losses + pending, unresolved: false };
  }

  assess(cycle, excludeOrderId) {
    const account = this.host.account(), feed = this.host.feed();
    if (cycle.segment !== feed?.segment) return { allowed: false, reason: "Feed continuity changed; close the stopped cycle" };
    const day = accountDay(this.now(), this.state.config.timeZone);
    const session = { ...this.state.session, dailyPnl: this.state.session.daily[day] ?? 0,
      uncertainExposure: this.reservedExposure(excludeOrderId) };
    return assessTradeRisk({ config: this.state.config, account, session,
      cycle: this.effectiveCycle(cycle, excludeOrderId), feed, stakeQuantum: this.host.stakeQuantum ?? 1 });
  }

  async onTick(observation) {
    if (!this.running || this.busy) return false;
    this.busy = true;
    const generation = this.generation;
    try {
      if (this.host.ownsExecution() !== true) throw new Error("Exclusive execution ownership lost");
      const feed = this.host.feed();
      if (!feed?.continuous || !observation || observation.source !== feed.source ||
          observation.segment !== feed.segment || !Number.isSafeInteger(observation.sequence) ||
          observation.sequence > feed.sequence || observation.epoch > feed.epoch ||
          !Number.isSafeInteger(observation.epoch) || observation.epoch < 0 ||
          !Number.isInteger(observation.digit) || observation.digit < 0 || observation.digit > 9) {
        throw new Error("Feed continuity unavailable; waiting for a valid consecutive observation");
      }
      if (observation.sequence <= this.state.lastSequence) return false;
      if (observation.sequence !== this.state.lastSequence + 1 || observation.epoch <= this.state.lastEpoch) {
        throw new Error("Feed continuity unavailable; an observation was skipped or reordered");
      }
      this.state.lastSequence = observation.sequence;
      this.state.lastEpoch = observation.epoch;
      if (this.liveOrders().length >= MAX_OPEN_ORDERS) {
        this.state.reason = `Burst limit reached (${MAX_OPEN_ORDERS} open or pending contracts)`;
        await this.save();
        return false;
      }
      let cycle = this.state.cycle;
      if (!cycle) {
        let row;
        try {
          row = await this.research.createModelPrediction(this.state.config.windowSize, "combined",
            this.state.config.frequencyWeight, observation.sequence);
        } catch (error) {
          if (/no longer the latest consecutive feed tick/.test(error.message)) {
            this.state.reason = "Waiting for the latest consecutive tick before creating a prediction";
            await this.save();
            return false;
          }
          if (/insufficient|tied/i.test(error.message)) {
            this.state.reason = `Waiting for combined prediction: ${error.message}`;
            await this.save();
            return false;
          }
          throw error;
        }
        if (!this.running || generation !== this.generation) return false;
        if (row.source !== observation.source || row.originSequence !== observation.sequence ||
            row.prediction.timestamp !== observation.epoch ||
            row.prediction.model !== "combined-frequency-markov" || !row.prediction.evidence ||
            !Number.isInteger(row.prediction.selectedDigit) || row.prediction.selectedDigit < 0 || row.prediction.selectedDigit > 9) {
          throw new Error("Combined prediction does not match the current consecutive observation");
        }
        cycle = { id: row.id, source: row.source, segment: observation.segment, digit: row.prediction.selectedDigit,
          pnl: 0, staked: 0, losses: 0, attempts: 0, unresolved: false };
        this.state.cycle = cycle;
        await this.save();
      }
      const original = await this.research.getPrediction(cycle.id);
      if (!this.running || generation !== this.generation) return false;
      if (!original || original.source !== cycle.source ||
          original.prediction?.model !== "combined-frequency-markov" ||
          original.prediction.selectedDigit !== cycle.digit) throw new Error("Original cycle prediction is unavailable or changed");
      const decision = this.assess(cycle);
      if (!decision.allowed) throw new Error(decision.reason);
      const order = { id: crypto.randomUUID(), cycleId: cycle.id, digit: cycle.digit,
        accountId: this.state.session.accountId, currency: this.state.session.currency,
        source: cycle.source, durationTicks: this.state.config.durationTicks, tickSequence: observation.sequence,
        stake: decision.stake, phase: "pricing", createdAt: this.now() };
      this.orders().push(order);
      await this.save();
      let proposal;
      try {
        proposal = await this.host.proposal({ source: cycle.source, digit: order.digit,
          stake: order.stake, durationTicks: order.durationTicks });
      } catch {
        throw new Error("Contract proposal failed; purchase not sent");
      }
      if (!this.running || generation !== this.generation) {
        order.phase = "cancelled";
        this.orders().splice(this.orders().indexOf(order), 1);
        await this.save();
        return false;
      }
      if (this.host.ownsExecution() !== true) throw new Error("Exclusive execution ownership lost");
      await this.host.verifyAuthorization();
      if (!this.running || generation !== this.generation) return false;
      const recheck = this.assess(cycle, order.id);
      if (!recheck.allowed || recheck.stake !== order.stake) throw new Error(recheck.reason || "Stake changed");
      if (!proposal || typeof proposal.id !== "string" || !proposal.id || proposal.askPrice !== order.stake) {
        throw new Error("Proposal price or identity is invalid");
      }
      order.proposalId = proposal.id;
      order.quotedPrice = proposal.askPrice;
      order.purchaseStartedAt = this.now();
      order.phase = "buying";
      await this.save();
      if (!this.running || generation !== this.generation || this.host.ownsExecution() !== true) {
        order.phase = "cancelled";
        this.orders().splice(this.orders().indexOf(order), 1);
        await this.save();
        return false;
      }
      const finalDecision = this.assess(cycle, order.id);
      if (!finalDecision.allowed || finalDecision.stake !== order.stake) {
        order.phase = "cancelled";
        this.orders().splice(this.orders().indexOf(order), 1);
        await this.save();
        throw new Error(finalDecision.reason || "Stake changed");
      }
      let buy;
      try { buy = await this.host.buy(order.proposalId, order.quotedPrice); }
      catch {
        order.phase = "unknown";
        throw new Error("Purchase outcome unknown; trading stopped while Deriv account recovery is pending");
      }
      if (!buy || !/^[1-9]\d*$/.test(String(buy.contractId)) || buy.buyPrice !== order.stake ||
          (buy.transactionId !== undefined && !/^[1-9]\d*$/.test(String(buy.transactionId)))) {
        order.phase = "unknown";
        throw new Error("Purchase response is incomplete; trading stopped while Deriv account recovery is pending");
      }
      order.contractId = String(buy.contractId);
      if (buy.transactionId !== undefined) order.transactionId = String(buy.transactionId);
      order.phase = "open";
      cycle.attempts++;
      cycle.staked += order.stake;
      await this.save();
      return true;
    } catch (error) {
      const order = this.state?.orders?.find(item => item.phase === "pricing" || item.phase === "buying" || item.phase === "unknown");
      if (order?.phase === "pricing") {
        order.phase = "cancelled";
        this.orders().splice(this.orders().indexOf(order), 1);
      }
      if (order?.phase === "unknown") this.state.resumeAfterRecovery = true;
      this.running = false;
      this.generation++;
      if (this.state) { this.state.reason = error.message; await this.save(); }
      throw error;
    } finally { this.busy = false; }
  }

  async reconcile(orderId) {
    if (this.busy) return false;
    if (this.host.ownsExecution() !== true) throw new Error("Exclusive execution ownership is required");
    const order = this.orders().find(item => item.id === orderId && item.phase === "open");
    if (!order) return false;
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
      const cycle = this.cycleById(order.cycleId), session = this.state.session;
      const wasCurrentCycle = this.state.cycle?.id === cycle?.id;
      if (!cycle || ![cycle.pnl + result.profit, session.pnl + result.profit,
        (session.daily[day] ?? 0) + result.profit].every(Number.isSafeInteger)) throw new Error("Settlement would overflow the ledger");
      cycle.pnl += result.profit;
      session.pnl += result.profit;
      session.daily[day] = (session.daily[day] ?? 0) + result.profit;
      order.phase = "settled";
      order.result = { contractId: order.contractId, status: result.status, profit: result.profit, payout: result.payout, settledAt: result.settledAt };
      this.state.history.push(structuredClone(order));
      this.orders().splice(this.orders().indexOf(order), 1);
      if (result.status === "lost") cycle.losses++;
      else if (!cycle.closed) {
        cycle.closed = true;
        cycle.termination = "confirmed match";
        if (this.state.cycle?.id === cycle.id) this.state.cycle = null;
        if (this.liveOrders(cycle.id).length && !this.state.closedCycles.some(item => item.id === cycle.id)) {
          this.state.closedCycles.push(cycle);
        }
      }
      if (cycle.closed) this.finalizeCycle(cycle);
      const outstanding = this.reservedExposure();
      if (session.pnl - outstanding <= -this.state.config.sessionLoss ||
          session.pnl >= this.state.config.sessionTarget || session.daily[day] >= this.state.config.dailyTarget ||
          (wasCurrentCycle && (cycle.pnl <= -this.state.config.cycleLoss || cycle.pnl >= this.state.config.cycleTarget))) {
        this.running = false;
        this.state.resumeAfterRecovery = false;
        this.state.reason = "Session, daily or cycle limit reached";
      } else if (this.running) {
        this.state.reason = result.status === "won" ? "Win confirmed; next tick starts a new prediction cycle" : "Loss confirmed; burst continues on the next tick";
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
