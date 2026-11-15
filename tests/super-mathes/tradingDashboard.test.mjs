import test from "node:test";
import assert from "node:assert/strict";
import { formatAccount, formatPrediction, tradingConfig } from "../../src/super-mathes/tradingDashboard.js";

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
