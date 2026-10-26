# Bazu vs shared analysis engine — detector audit (§7)

Scope: EMA, ATR, BOS, CHoCH, FVG and order blocks. **No Bazu behaviour was changed.** The only source edit is
`export` on `atrSeries` in `src/bazu/structure.js` so it can be tested. Every claim below is pinned by
`tests/bazu/detectorAudit.test.mjs` (10 tests, synthetic seeded random walks; 7 seeds × 400 candles; no real-market data).

Rule applied: detectors are unified only when the semantics are provably equal. The Bazu signal weights and calibration were fitted on
Bazu's own values, so a "cleaner" definition would silently shift live signals.

## Summary

| Detector | Bazu implementation | Shared implementation | Relationship (measured) | Verdict |
|---|---|---|---|---|
| EMA | `ta3m.emaSeries`: seeded with `x[0]`, defined from index 0 | `levels.ema`: seeded with SMA of first n, `null` before n-1 | Same recurrence afterwards, so gap(i) = gap(n-1)·(1-k)^(i-n+1) exactly | Accidental seeding difference. **Keep**; matters on short frames (n=20, 25 candles leaves ~60% of the seed gap) |
| ATR (structure) | `structure.js atrSeries`: Wilder RMA seeded from the first TR, NaN before n-1 | `core.atrSeries`: Wilder, SMA seed over n TRs, `null` before n-1 | Gap decays as ((n-1)/n)^m exactly; same first defined index | Accidental. **Keep**. Already unified where equal: `crt3m.wilderAtr` delegates to the shared ATR (bit-identical parity test) |
| ATR (`robustAtr`) | median of last n true ranges, defined from min(n,5) candles | Wilder | One spike moves the median <5% and Wilder >1.5× | **Intentional** (spike-robust). Not comparable |
| BOS/CHoCH (`structure.js` → mtf) | break of the *latest swing by index* (< i), not consumed, so one swing is re-reported on every later close beyond it; label from last 4 swings; right-edge **not causal** | break of the latest *confirmed* pivot, consumed on first break, label from the direction of the previous break; causal | ≥90% of shared break bars are mtf break bars; mtf reports >2× as many; BOS-vs-CHoCH label agrees on <90% of common bars | Different definitions. Non-causality is a defect of the raw mtf detector, **mitigated** in Bazu (see below). Keep |
| BOS/CHoCH (`factors3m.structureState`) | trend = last two swing highs and lows (HH/HL or LH/LL); break = last close vs `hi[1]`/`lo[1]`; only swings with `index+2 ≤ last` (causal); not consumed | consumed, trend = last break | Reports the same break on consecutive bars; trend notion disagrees with shared on >30% of sampled bars | Different, intentional. Keep |
| FVG | `mtf.detectFVG`: any 3-candle gap, no size filter, stamped on the middle candle; Bazu delays availability by 1 | `zones.js`: same gap, requires size ≥ 0.4·ATR, confirmed on the third candle, with fill/invert/expire lifecycle | Every shared FVG equals an mtf FVG (same bar, direction and bounds); mtf has >1.5× as many | Same geometry; shared adds filter and lifecycle. Timing equal after Bazu's +1 shift. Candidate for sharing **only** with a min-size of 0 and no lifecycle, which gives no benefit |
| Order block | `mtf.detectOrderBlock`: body ≥ 2× mean body of previous 10, walk back ≤5 candles to last opposite colour, zone = body, no break required, no mitigation. `context3m` keeps it for 60 bars, available after 6 | ATR displacement + same-direction BOS/CHoCH within 5 bars, walk back ≤10, zone = full range, mitigation/invalidation/breaker lifecycle | ≥80% of shared OBs coincide (bar and direction) with an mtf OB; shared zone always contains the mtf body; mtf reports more | Different detectors. Keep |

## Causality in detail

- Raw `mtf.detectStructureBreaks` / `detectLiquiditySweep` treat a swing at index j < i as known at bar i, but a lookback-2 swing is only
  confirmed at j+2. Measured on seed 7: the BOS/CHoCH output of a truncated series disagrees with the full series' output for the same bars
  at 25 of 340 prefix lengths (7%); similar for sweeps (7–12 of 340 per seed). This is a latent lookahead in the raw detector.
- `structure.js` already neutralises it by treating every event as available only `lookback` candles later (`avail(bos, LB)`; FVG +1; OB +6).
  `tests/bazu/detectorAudit.test.mjs` re-proves that truncation never changes earlier `bosDir/chochDir/sweepDir/fvgDir/obDir/trendHHHL` values.
- `factors3m.structureState` filters swings to `index+2 ≤ last` and `context3m` shifts order blocks by 6, so both are causal.
- Anyone calling the raw mtf detectors directly on the live edge would get a lookahead; none of Bazu's call sites does.

## Intentional vs accidental

- Intentional: `robustAtr` (median), structureState's HH/HL trend, OB "body" zone and no-break rule, FVG without a size filter
  (Bazu feeds many weak imbalances to calibrated features).
- Accidental (legacy, harmless once converged): first-value EMA seed and first-TR ATR seed. Not changed because the live signal weights
  and logged calibration used these exact values.
- Defect, mitigated: right-edge lookahead of the raw mtf break/sweep detectors.

## Already unified (earlier phases)

- Swing pivots: `src/bazu/sharedEngineAdapter.js` equals `mtf findSwingPoints` (tests/analysis/bazu-adapter.test.mjs). `structure.js` uses the adapter;
  `factors3m.js`, `context3m.js` and `page.js` still import the mtf function directly. The outputs are identical, so swapping those imports is safe but was
  left out of this change to keep the diff minimal.
- Wilder ATR in `crt3m.wilderAtr`.

## Not verified

Real-market data was not used here. The overlap percentages come from synthetic random walks, so they describe the definitions, not live frequency.
