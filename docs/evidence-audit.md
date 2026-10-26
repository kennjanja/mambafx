# Evidence weights and proxy indicators — audit (§8)

Subject: `src/analysis/evidence.js`, `src/analysis/levels.js`. Reproduce the numbers with
`node scripts/audit-evidence.mjs <ticks.csv> --tf 60,300 --step 40`.
The audit script is **descriptive only**: it reads no forward returns, so it cannot tune weights on outcomes.

## 1. Weights and contribution

Each group contributes `strongest bullish item − strongest bearish item` (max, not sum), items scaled by
a per-item factor. `balance = Σ group net / 15.5`, bounded to [-1, 1]. It is **not a probability**.

| Group (weight key) | Weight |
|---|---|
| structure (`structureBias`) | 2 |
| break | 3 |
| liquidity | 2 |
| location (premium/discount) | 1 |
| zone | 2 |
| candle | 1 |
| level | 1 |
| trend (EMA alignment) | 1.5 |
| htf (higher-timeframe agreement) | 2 |

Fixed denominator 15.5 (missing groups count as zero, they are not renormalised). A lean needs
|balance| ≥ 0.35 and ≥ 2 agreeing groups; any multi-timeframe conflict caps the verdict to inconclusive.
**All weights are provisional, heuristic and untuned.** They were not changed by this audit.

## 2. Genuine calculations vs proxies

| Item | Status |
|---|---|
| ATR, EMA, swing pivots, structure (BOS/CHoCH), zones, S/R levels, Fib/premium-discount | genuine price-based calculations (still heuristic rules) |
| Anchored VWAP | **proxy**: equal-weighted typical price (no traded volume in the feed) |
| Volume profile POC/VAH/VAL | **proxy**: time-at-price profile |
| Wyckoff effort-vs-result | uses candle range as a volume stand-in (**proxy**) |

VWAP/profile are chart overlays; they are not inputs to the evidence balance. The UI chip reads
"Profile POC/VA (proxy)"; chart labels carry `*`/"(proxy)".

## 3. Double counting and correlation (real R_25 ticks, 10 days, window 300, step 40)

Samples: 1m = 353, 5m = 65. No HTF candles were supplied, so `htf` is inactive here.

- **Structure and break overlap (structural).** The same BOS/CHoCH can enter `structure` (weight 2) and, if
  within 12 bars, `break` (weight 3). Measured: when a structure item was present, the same event was also in
  the break group in 188/353 samples (1m) and 37/65 (5m). This is a real double count and is **not corrected**
  (changing it is a weight/logic change that needs validation first).
- **Correlated group nets:** structure–trend +0.72 (1m) / +0.68 (5m); location–trend −0.72 / −0.75
  (premium/discount is mean-reversion flavoured, EMA alignment is trend flavoured — they partly cancel);
  break–location −0.60 / −0.62; break–trend +0.55 / +0.56.
- **Share of total |net|, 1m:** structure 0.185, break 0.18, zone 0.147, liquidity 0.114, trend 0.106,
  location 0.103, level 0.09, candle 0.074. Verdicts 1m: 33 bullish / 34 bearish / 286 inconclusive; 5m: 9 / 7 / 49.
- Within a group, correlated items already count once (max, covered by an existing test).

## 4. Defect fixed (label bug)

When the verdict was `inconclusive`, `supporting` held all bullish items and `conflicting` all bearish items,
and the UI printed them under "Supporting"/"Conflicting" although nothing was being supported (286/286 inconclusive
1m samples and 49/49 at 5m before the fix). Now `supporting`/`conflicting` are defined only relative to a lean;
neutral `bullishItems`/`bearishItems` are exposed and the UI shows "Bullish evidence"/"Bearish evidence" when
inconclusive. Weights and verdict logic are unchanged. Limitations text now states weights are provisional, that
VWAP/profile are proxies and not balance inputs, and that groups are not independent. Tests:
`tests/analysis/evidence-audit.test.mjs`.

## 5. What this does not show

- No forward-return analysis was run; nothing here says the balance or any indicator is predictive or profitable.
- One 10-day R_25 sample only; no live Deriv validation.
- Any future weight change must use a chronological train/validation split with an untouched final test set,
  with the test set evaluated once.
