# LDPE offline candidate evaluation (manifest v2.2)

## Finding

No candidate qualified for holdout or promotion. The approved three-day collection window yielded only about one day of history per index. All 90 candidate cells were classified as inconclusive or underpowered, and the final holdout remained locked. The results do not establish predictive information beyond a uniform digit distribution.

Candidate models remain isolated in `src/ldpe/evaluation/`. The production LDPE ensemble, forecasts, and trading behavior were not changed.

## Registered evaluation

The approved manifest compares hierarchical Dirichlet-multinomial (`hdm`), discounted Dirichlet (`ddir`), depth-3 context-tree weighting (`ctw`), first-order modular-increment Markov (`inc`), and lag-specific conditional tables (`lag`) across six indices and horizons 1, 5, and 10. It registers 90 candidate cells and 180 one-sided paired log-loss hypotheses against uniform and the existing ensemble. A positive difference favors the candidate.

The chronological split, ten-tick boundary purges, 0.0005-nat practical threshold, Holm correction, HAC simultaneous intervals, calibration checks, power projection, and locked holdout rule followed the manifest. Inference used Newey-West lag 200 and 20,000 stationary-bootstrap replicates at mean block lengths 10, 50, and 200. Candidate fitting and tuning used only their permitted chronological prefixes.

Manifest SHA-256: `E6E8E2008FF13B8F5B20537B31BC5EFBD65D07A9E6DA69D1C71BFC8CA8CED2DF`.

## Data coverage and quality

The Deriv public-history endpoint did not provide ticks older than its retained range. Each capture spans roughly 24 hours (two UTC calendar dates), rather than the approved three days; `historyRangeUnavailable` is true for every index.

| Index | Ticks | UTC coverage | Hours |
|---|---:|---|---:|
| R_100 | 44,113 | 2026-10-23 09:09:24 – 2026-10-24 09:39:48 | 24.51 |
| 1HZ10V | 87,986 | 2026-10-23 09:13:29 – 2026-10-24 09:39:54 | 24.44 |
| 1HZ25V | 87,850 | 2026-10-23 09:15:48 – 2026-10-24 09:39:57 | 24.40 |
| 1HZ50V | 87,708 | 2026-10-23 09:18:14 – 2026-10-24 09:40:01 | 24.36 |
| 1HZ75V | 86,687 | 2026-10-23 09:35:20 – 2026-10-24 09:40:06 | 24.08 |
| 1HZ100V | 86,553 | 2026-10-23 09:37:39 – 2026-10-24 09:40:11 | 24.04 |

The captured rows had zero malformed quotes, precision mismatches, duplicate epochs, out-of-order ticks, or detected feed gaps. The quality gate passed for the evaluated development ranges, but that does not offset the insufficient time coverage.

The development evaluation used 24,232–48,371 paired forecasts per index/horizon cell; the registered minimum is 100,000. Only two development calendar days were available, versus the seven-day stability/holdout requirement. Estimated power at the registered planning effect of 0.001 nats reached 0.70 in 27 of 90 cells. **All 90 cells failed at least the sample and calendar-coverage gates.**

Raw JSONL captures and the full machine-readable result are kept outside the repository in `%USERPROFILE%\.mambafx\ldpe-evaluation-v2\`. The per-index capture SHA-256 values are:

| Index | SHA-256 |
|---|---|
| R_100 | `B047ED8A974FE636EB8C14190EBBF946157AA051D51A8013A1481547528F370C` |
| 1HZ10V | `5D7E898F3D086E535D8E2C73BC2116163C8989D988FD2798A6474A6B3F162498` |
| 1HZ25V | `7040207D51CDBF081CB670ED9F20B98A659686813AC7D6A9E17F4A71914ED7E9` |
| 1HZ50V | `E3C02FB199F400CD5B2B8ED650D7DBF2348A734C7D8B3EA844B73ABB1CBD465A` |
| 1HZ75V | `BECCB931F8BF2A3F3C7015EC0E98853D1E2295D53738CA14E23366B4829520E0` |
| 1HZ100V | `295C35A36B264F9BA0E8C029A64ED8FBFB3932FC0D912F6010BA3E1B96DACC07` |

## Results

| Candidate | Weighted ΔLL vs uniform | Weighted ΔLL vs ensemble | Positive cells vs uniform / ensemble |
|---|---:|---:|---:|
| HDM | -0.000110 | +0.000309 | 0 / 18; 18 / 18 |
| Discounted Dirichlet | -0.002247 | -0.001828 | 0 / 18; 0 / 18 |
| CTW depth 3 | -0.000110 | +0.000309 | 0 / 18; 18 / 18 |
| Modular increment | -0.000462 | -0.000043 | 5 / 18; 12 / 18 |
| Lag tables | -0.000367 | +0.000052 | 0 / 18; 11 / 18 |

These are descriptive, forecast-count-weighted summaries over each family's 18 index/horizon cells; they are not additional registered hypothesis tests. Across the 793,023 paired forecasts, the existing ensemble had log loss 2.303004, Brier score 0.900084, and top-1 hit rate 10.049%. Uniform had log loss 2.302585, Brier 0.900000, and top-1 hit rate 10.000%.

Nine of 180 comparisons had Holm-adjusted *p* ≤ 0.05; all nine were against the existing ensemble, and none were against uniform. Seven also had positive Bonferroni/HAC simultaneous lower bounds. `inc` on 1HZ50V at horizon 5 was the only comparison that met both the practical threshold and Holm significance against the ensemble: ΔLL +0.000556 nats (Holm-adjusted *p* = 0.0000064; simultaneous 95% family-wise interval [0.000181, 0.000931]). Against uniform, the same cell's ΔLL was effectively zero (-0.000000031; adjusted *p* = 1). It therefore does not demonstrate predictive edge beyond uniform or pass the required paired-reference rule.

The eight existing model modules and the uniform baseline were also scored descriptively on 793,023 matured forecasts each. Their log loss / top-1 hit rate was: uniform 2.302585 / 10.000%; Dirichlet 2.302696 / 9.998%; `freqShort` 2.372968 / 10.056%; `freqLong` 2.307098 / 10.007%; `decayed` 2.307589 / 10.026%; `trans1` 2.303895 / 10.018%; `trans2` 2.315682 / 9.935%; `gap` 2.304388 / 10.034%; `streak` 2.306138 / 9.990%. These per-module figures are descriptive and do not isolate causal value within the weighted ensemble. The manifest's separate exploratory gap/streak permutation-surrogate analysis was not run; no surrogate p-values are claimed.

## Conclusion

The short capture is useful as a preliminary diagnostic, not a model-selection dataset. The small ensemble-relative gains do not translate into gains against uniform, and the registered sample, coverage, and stability gates failed. No candidate was selected; holdout was not accessed; no candidate was added to live forecasting or execution.
