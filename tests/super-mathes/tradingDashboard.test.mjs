import test from "node:test";
import assert from "node:assert/strict";
import { formatAccount, formatPrediction, formatTradingHistory, formatTradingState, tradingConfig } from "../../src/super-mathes/tradingDashboard.js";

test("account display distinguishes Demo, Real and disconnected states", () => {
  assert.match(formatAccount({ connected: true, isVirtual: true, accountId: "VRTC1", balance: 10, currency: "USD" }), /VRTC1 \| Demo \| 10 USD/);
  assert.match(formatAccount({ connected: true, isVirtual: false, accountId: "CR1", balance: null, currency: "USD" }), /CR1 \| Real \| — USD/);
  assert.equal(formatAccount({ connected: false, loggedIn: true }), "Signed in; no account connected.");
  assert.equal(formatAccount(null), "Not signed in to Deriv.");
});

test("prediction display uses the latest combined research record, not another model", () => {
  const records = [
    { prediction: { model: "smoothed-frequency" } },
    { source: "market", prediction: { model: "combined-frequency-markov", selectedDigit: 3,
      probabilities: [0.05, 0.05, 0.05, 0.30, 0.1, 0.1, 0.1, 0.1, 0.1, 0.05],
      evidence: { frequencyLeader: 3, markovLeader: 5 } } },
  ];
  const result = formatPrediction(records);
  assert.match(result, /Frequency: 3 \| Markov: 5/);
  assert.match(result, /Selected: 3 \| Combined probability: 30\.00%/);
  for (let digit = 0; digit < 10; digit++) assert.match(result, new RegExp(`${digit}: \\d+\\.\\d{2}%`));
  assert.match(result, /research record, not a trading instruction/);
  assert.match(formatPrediction(records.slice(0, 1)), /No combined research prediction/);
});

test("trading settings automatically use Nairobi time without requiring account metadata", () => {
  const config = tradingConfig({ baseStake: "1", maximumStake: "1", maximumExposure: "1", stopLoss: "1",
    takeProfit: "1", multiplier: "2", maxSteps: "0", martingale: false, durationTicks: "1",
    windowSize: "100", frequencyWeight: "0.5" });
  assert.equal(config.timeZone, "Africa/Nairobi");
});

test("rejects a base stake with more than two decimal places", () => {
  assert.throws(() => tradingConfig({ baseStake: "1.001" }), /two decimal places/);
});

test("unconfirmed purchases are shown without inventing a payout or profit", () => {
  const state = { accountingScale: 8, accountId: "VRTC1", reason: "Stopped",
    session: { pnl: 0, currency: "USD", uncertainExposure: 100000000 }, cycle: null, order: null,
    history: [{ phase: "unknown", digit: 3, stake: 100000000 },
      { cycle: { id: "p1", digit: 3, attempts: 1, staked: 100000000, pnl: 0, uncertainExposure: 100000000 },
        termination: "purchase outcome unknown; not reconciled" }] };
  assert.match(formatTradingState({ owned: true, running: false, state }), /Unconfirmed purchase exposure: 1 USD/);
  assert.match(formatTradingHistory(state), /payout unknown/);
  assert.match(formatTradingHistory(state), /outcome and payout unknown/);
});

test("live trading state shows both overlapping contracts and their separate attempts", () => {
  const state = { accountingScale: 8, accountId: "VRTC1", reason: "Running",
    session: { pnl: 0, currency: "USD" }, cycle: { id: "p1", digit: 3, attempts: 2, staked: 300000000, pnl: 0 },
    orders: [
      { cycleId: "p1", digit: 3, stake: 100000000, contractId: "11", phase: "open" },
      { cycleId: "p1", digit: 3, stake: 200000000, contractId: "12", phase: "open" },
    ], history: [] };
  const formatted = formatTradingState({ owned: true, running: true, state });
  assert.match(formatted, /Attempt 1 \| digit 3 \| stake 1 \| contract 11 \| open/);
  assert.match(formatted, /Attempt 2 \| digit 3 \| stake 2 \| contract 12 \| open/);
});
