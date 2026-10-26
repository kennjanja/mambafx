# Analysis-engine validation on real R_25 data

Reproduce: `node scripts/validate-ticks.mjs <ticks.csv> --symbol R_25 --out report.json`

## Data
- Source: local file `deriv_r25_10day_output/R_25_10day_ticks.csv` (Deriv `ticks_history`, saved by the owner's downloader).
- R_25, 431,999 ticks, 2026-10-13T18:48:22Z to 2026-10-23T18:48:22Z, 3 decimals.
- Integrity: 0 invalid prices, 0 duplicate epochs, 0 out-of-order rows, modal interval 2 s, max gap 6 s, no gaps over 10 intervals. Nothing was filled or altered.
- Candles are built from ticks (UTC-aligned buckets; partial first/last bucket dropped): 1m 14,399; 5m 2,879; 10m 1,439; 30m 479; 1h 239; 4h 59.
- Window is only 10 days of one instrument: it cannot represent other regimes.

## Method (unchanged rules, verified in code and tests)
Event known at its confirmation bar; entry = next bar's open; outcome = close of the h-th bar (h = 1,3,5,10,20); direction from the event; ties count as misses; same kind+direction events within 5 bars collapse to the first. First 60% = development, last 40% = held-out; no rule or weight was tuned on either. Wilson 95% intervals; n < 30 gets no verdict.
Added in this pass: the reference is the unconditional rate for the same direction/horizon/sample (not 50%), results are grouped by direction, and zone first-touch (retest) events were added next to zone-formation events.

## Results (held-out 40%, groups with n >= 30, kind x direction x horizon)
| Timeframe | Tests | Above baseline | Below baseline |
|---|---|---|---|
| 1m | 225 | 7 | 4 |
| 5m | 93 | 3 | 2 |
| 10m | 15 | 0 | 1 |
| 30m, 1h, 4h | 0 | – | – |
| Total | 333 | 10 | 7 |

- 17 of 333 groups were flagged, versus about 17 expected by chance at 95% (and the observations are serially dependent, so intervals are optimistic).
- 9 groups looked different from baseline in the development period; 0 repeated in the same direction in the held-out period, 1 reversed.
- Unconditional up-rate is about 49–52% at short horizons, so the right reference is near 50% for this data.

## Conclusion
No detector shows a directional effect that survives the held-out period beyond what chance explains. This is a null result on one 10-day sample, not proof of no effect. Higher timeframes have too few events to say anything.
A directional hit rate is not profitability: payout, contract settlement rules and costs were not modelled.
