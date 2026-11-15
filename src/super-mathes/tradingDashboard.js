import { toMajor, toMinor } from "./derivExecution.js?v=1";
import { ACCOUNTING_SCALE } from "./tradingRuntime.js?v=2";

function text(value) {
  return value == null ? "—" : String(value);
}

export function formatAccount(account) {
  if (!account?.connected) return account?.loggedIn ? "Signed in; no account connected." : "Not signed in to Deriv.";
  return `${text(account.accountId)} | ${account.isVirtual === true ? "Demo" : account.isVirtual === false ? "Real" : "Account type unknown"} | ${text(account.balance)} ${text(account.currency)} | Connected`;
}

export function formatPrediction(records) {
  const record = records.find(row => row.prediction.model === "combined-frequency-markov");
  const p = record?.prediction;
  if (!p) return "No combined research prediction recorded for the active source.";
  return `Source: ${record.source}\nFrequency: ${text(p.evidence?.frequencyLeader)} | Markov: ${text(p.evidence?.markovLeader)}\nSelected: ${p.selectedDigit} | Combined probability: ${(p.probabilities[p.selectedDigit] * 100).toFixed(2)}%\n` +
    p.probabilities.map((value, digit) => `${digit}: ${(value * 100).toFixed(2)}%`).join("  ") +
    "\nThis is a research record, not a trading instruction.";
}

export function tradingConfig(values) {
  const amount = key => toMinor(values[key], ACCOUNTING_SCALE);
  const multiplier = toMinor(values.multiplier, 4);
  const steps = Number(values.maxSteps), durationTicks = Number(values.durationTicks);
  const windowSize = Number(values.windowSize), frequencyWeight = Number(values.frequencyWeight);
  if (!Number.isSafeInteger(steps) || steps < 0 || steps > 1000) throw new Error("Invalid maximum Martingale steps");
  return {
    baseStake: amount("baseStake"), maximumStake: amount("maximumStake"), maximumExposure: amount("maximumExposure"),
    cycleLoss: amount("stopLoss"), sessionLoss: amount("stopLoss"), cycleTarget: amount("takeProfit"),
    sessionTarget: amount("takeProfit"), dailyTarget: amount("takeProfit"),
    maxAttempts: values.martingale ? steps + 1 : 0, martingale: values.martingale,
    multiplierNumerator: multiplier, multiplierDenominator: 10000,
    timeZone: "Africa/Nairobi", durationTicks, windowSize, frequencyWeight,
  };
}

export function formatTradingState(snapshot) {
  const state = snapshot?.state;
  if (!state) return snapshot?.error || "No execution history for the selected account.";
  if (state.accountingScale !== ACCOUNTING_SCALE) return "Execution history has an incompatible accounting scale.";
  const money = n => toMajor(n, ACCOUNTING_SCALE);
  const cycle = state.cycle, order = state.order;
  const wins = state.history.filter(row => row.result?.status === "won").length;
  const losses = state.history.filter(row => row.result?.status === "lost").length;
  return `${snapshot.owned ? (snapshot.running ? "Running" : "Stopped") : "Last saved state; another tab may own execution"} — ${state.reason}` +
    `${snapshot.error ? ` | ${snapshot.error}` : ""}\nAccount: ${state.accountId}\n` +
    `Digit: ${text(cycle?.digit)} | Attempts: ${cycle?.attempts ?? 0} | Stake: ${order ? money(order.stake) : "—"}\n` +
    `Contract: ${text(order?.contractId)} | Status: ${text(order?.phase)}\n` +
    `Confirmed wins: ${wins} | losses: ${losses} | Cycle P/L: ${cycle ? money(cycle.pnl) : "—"} | Confirmed session P/L: ${money(state.session.pnl)} ${state.session.currency}` +
    `\nUnconfirmed purchase exposure: ${money(state.session.uncertainExposure ?? 0)} ${state.session.currency}`;
}

export function formatTradingHistory(state) {
  if (!state?.history?.length) return "No confirmed settlements.";
  if (state.accountingScale !== ACCOUNTING_SCALE) return "Execution history has an incompatible accounting scale.";
  const money = n => toMajor(n, ACCOUNTING_SCALE);
  return state.history.slice().reverse().map(row => {
    if (row.cycle) return `Cycle ${row.cycle.id} | digit ${row.cycle.digit} | ${row.cycle.attempts} attempts | attempted stake ${money(row.cycle.staked)} | payout ${row.cycle.uncertainExposure ? "unknown" : money(row.cycle.staked + row.cycle.pnl)} | confirmed P/L ${money(row.cycle.pnl)} | ${row.termination}`;
    if (row.phase === "unknown") return `Unconfirmed purchase | digit ${row.digit} | attempted stake ${money(row.stake)} | outcome and payout unknown`;
    return `Contract ${row.contractId} | digit ${row.digit} | ${row.result.status} | stake ${money(row.stake)} | payout ${money(row.result.payout)} | P/L ${money(row.result.profit)}`;
  }).join("\n");
}

export function attachTradingDashboard(service, accountStatus, refreshBalance, runtime) {
  const page = document.getElementById("page-supermathes");
  const research = page?.querySelector("section");
  if (!research) throw new Error("Super Mathes research view is unavailable");

  const navigation = document.createElement("nav");
  navigation.className = "sm-trading-nav";
  navigation.setAttribute("aria-label", "Super Mathes views");
  const researchButton = document.createElement("button");
  const tradingButton = document.createElement("button");
  for (const [button, label] of [[researchButton, "Research"], [tradingButton, "Trading Dashboard"]]) {
    button.type = "button";
    button.className = "gc-btn";
    button.textContent = label;
    navigation.append(button);
  }
  const trading = document.createElement("section");
  trading.className = "gc-card sm-trading";
  trading.hidden = true;
  trading.innerHTML = `
    <h2>Super Mathes Trading Dashboard</h2>
    <p>These unvalidated research models do not establish a trading advantage. Real accounts use real money.</p>
    <h3>Account</h3><pre data-field="account">Checking connection…</pre>
    <button type="button" class="gc-btn" data-action="balance">Refresh account balance</button>
    <button type="button" class="gc-btn" data-action="account">Connect or select account</button>
    <p role="status" data-field="balance-message"></p>
    <h3>Cycle prediction (or latest combined research prediction)</h3><pre data-field="prediction">Waiting for a combined prediction.</pre>
    <h3>Trading settings</h3>
    <p>Contract type: Digit Matches. The selected digit remains fixed until a confirmed win or the cycle is closed.</p>
    <p>If a purchase response is lost, trading stops without retry or recovery. Starting again can create an additional contract; unconfirmed stake counts against the session stop loss.</p>
    <p>Daily targets reset at midnight in Africa/Nairobi.</p>
    <form class="sm-trading-form" data-form="settings">
      <label>Duration (ticks) <input name="durationTicks" type="number" min="1" max="10" value="1" required></label>
      <label>Base stake <input name="baseStake" type="number" min="0.00000001" step="any" value="1" required></label>
      <label>Maximum stake <input name="maximumStake" type="number" min="0.00000001" step="any" value="1" required></label>
      <label>Maximum cycle exposure <input name="maximumExposure" type="number" min="0.00000001" step="any" value="1" required></label>
      <label>Stop loss <input name="stopLoss" type="number" min="0.00000001" step="any" value="1" required></label>
      <label>Take profit <input name="takeProfit" type="number" min="0.00000001" step="any" value="1" required></label>
      <label class="sm-checkbox"><input name="martingale" type="checkbox"> Enable Martingale</label>
      <label>Martingale multiplier <input name="multiplier" type="number" min="1" max="10" step="0.0001" value="2" required></label>
      <label>Maximum Martingale steps <input name="maxSteps" type="number" min="0" max="1000" value="0" required></label>
      <label>Research window <input name="windowSize" type="number" min="20" max="10000" value="100" required></label>
      <label>Frequency weight <input name="frequencyWeight" type="number" min="0.01" max="0.99" step="0.01" value="0.5" required></label>
      <button type="submit" class="gc-btn" data-action="start">Start trading</button>
      <button type="button" class="gc-btn" data-action="stop">Stop trading</button>
      <button type="button" class="gc-btn" data-action="close-cycle">Close stopped cycle</button>
    </form>
    <p role="status" data-field="message"></p>
    <h3>Live trading</h3><pre data-field="activity">No execution history for the selected account.</pre>
    <h3>Trading history</h3><pre data-field="history">No confirmed settlements.</pre>
  `;
  page.insertBefore(navigation, research);
  page.append(trading);
  function show(view) {
    research.hidden = view !== "research";
    trading.hidden = view !== "trading";
    researchButton.setAttribute("aria-pressed", String(view === "research"));
    tradingButton.setAttribute("aria-pressed", String(view === "trading"));
  }
  researchButton.addEventListener("click", () => show("research"));
  tradingButton.addEventListener("click", () => { show("trading"); render(); });
  trading.querySelector('[data-action="account"]').addEventListener("click", () => window.showPage("grid"));
  trading.querySelector('[data-action="balance"]').addEventListener("click", async () => {
    const message = trading.querySelector('[data-field="balance-message"]');
    try {
      await refreshBalance();
      message.textContent = "Account balance refreshed from Deriv.";
      await render();
    } catch (error) {
      message.textContent = `Unable to refresh balance: ${error.message}`;
    }
  });
  trading.querySelector('[data-form="settings"]').addEventListener("submit", async event => {
    event.preventDefault();
    const form = event.currentTarget, values = {};
    for (const name of ["durationTicks", "baseStake", "maximumStake", "maximumExposure", "stopLoss", "takeProfit",
      "multiplier", "maxSteps", "windowSize", "frequencyWeight"]) values[name] = form.elements[name].value;
    values.martingale = form.elements.martingale.checked;
    const message = trading.querySelector('[data-field="message"]');
    try {
      const selected = accountStatus();
      if (selected?.isVirtual === false && !window.confirm("Start automated trading with real money?")) return;
      await runtime.start(tradingConfig(values), selected);
      message.textContent = "Trading started.";
    } catch (error) { message.textContent = `Unable to start: ${error.message}`; }
    await render();
  });
  trading.querySelector('[data-action="stop"]').addEventListener("click", async () => {
    const message = trading.querySelector('[data-field="message"]');
    try { await runtime.stop(); message.textContent = "Trading stopped; open contracts continue to be monitored."; }
    catch (error) { message.textContent = `Unable to stop safely: ${error.message}`; }
    await render();
  });
  trading.querySelector('[data-action="close-cycle"]').addEventListener("click", async () => {
    const message = trading.querySelector('[data-field="message"]');
    if (!window.confirm("Close this stopped cycle? Its original prediction and confirmed results will remain in history.")) return;
    try { await runtime.closeCycle(); message.textContent = "Stopped cycle closed."; }
    catch (error) { message.textContent = `Unable to close cycle: ${error.message}`; }
    await render();
  });
  show("research");

  let busy = false, hydratedAccount = null, displayedAccount = null;
  async function render() {
    if (busy || trading.hidden || !page.classList.contains("active")) return;
    busy = true;
    try {
      const selected = accountStatus();
      trading.querySelector('[data-field="account"]').textContent = formatAccount(selected);
      if ((selected?.accountId || null) !== displayedAccount) {
        trading.querySelector('[data-form="settings"]').reset();
        displayedAccount = selected?.accountId || null;
        hydratedAccount = null;
      }
      const source = service.status.activeSource;
      let snapshot = runtime.snapshot();
      if (!snapshot.owned && selected?.accountId) {
        const state = await runtime.readHistory(selected.accountId);
        snapshot = { ...snapshot, state, running: false };
      }
      const original = snapshot.state?.cycle ? await service.getPrediction(snapshot.state.cycle.id) : null;
      const records = original ? [original] : source && !snapshot.state?.cycle ? await service.listPredictions(source, 10) : [];
      trading.querySelector('[data-field="prediction"]').textContent = snapshot.state?.cycle && !original ?
        "Original cycle prediction is unavailable." : formatPrediction(records);
      if (snapshot.state?.accountId === selected?.accountId && snapshot.state.accountingScale === ACCOUNTING_SCALE &&
          hydratedAccount !== selected.accountId) {
        const c = snapshot.state.config, elements = trading.querySelector('[data-form="settings"]').elements;
        const values = { baseStake: toMajor(c.baseStake, ACCOUNTING_SCALE), maximumStake: toMajor(c.maximumStake, ACCOUNTING_SCALE),
          maximumExposure: toMajor(c.maximumExposure, ACCOUNTING_SCALE), stopLoss: toMajor(c.sessionLoss, ACCOUNTING_SCALE),
          takeProfit: toMajor(c.sessionTarget, ACCOUNTING_SCALE), durationTicks: c.durationTicks,
          multiplier: c.multiplierNumerator / c.multiplierDenominator, maxSteps: c.martingale ? c.maxAttempts - 1 : 0,
          windowSize: c.windowSize, frequencyWeight: c.frequencyWeight };
        for (const [name, value] of Object.entries(values)) elements[name].value = String(value);
        elements.martingale.checked = c.martingale;
        hydratedAccount = selected.accountId;
      }
      trading.querySelector('[data-field="activity"]').textContent = formatTradingState(snapshot);
      trading.querySelector('[data-field="history"]').textContent = formatTradingHistory(snapshot.state);
    } catch (error) {
      trading.querySelector('[data-field="prediction"]').textContent = `Unable to load research data: ${error.message}`;
    } finally { busy = false; }
  }
  setInterval(render, 1500);
}
