# LDPE evaluation on real Deriv ticks (2026-10-24)

Script: `node tests/ldpe/evaluate-real.mjs 20000 5` (public tick history, no login, no orders; unchanged engine, horizon 5, chronological scoring).

| Index | Scored | Digit chi² p | Δ log loss vs uniform (95% block-bootstrap CI) | Top-1 (chance 10%) | TRADE forecasts / hit rate |
|---|---|---|---|---|---|
| 1HZ10V | 19,995 | 0.176 | +5.0e-7 [-2.7e-5, 2.9e-5] | 10.05% | 255 / 12.55% |
| 1HZ25V | 19,995 | 0.180 | +1.3e-5 [-2.0e-5, 4.2e-5] | 10.21% | 177 / 8.47% |
| 1HZ50V | 19,995 | 0.549 | +2.9e-6 [-2.2e-5, 2.6e-5] | 9.92% | 74 / 12.16% |
| 1HZ75V | 19,995 | 0.386 | +6.6e-5 [-4.8e-5, 2.6e-4] | 10.36% | 494 / 10.12% |
| 1HZ100V | 19,995 | 0.152 | +7.5e-6 [-2.0e-5, 3.3e-5] | 10.11% | 66 / 6.06% |

Positive Δ log loss means worse than the uniform 10% baseline; every confidence interval includes zero.

## Reading

* Raw digits are consistent with uniform (all chi² p-values > 0.15).
* The ensemble's log loss and Brier score are indistinguishable from uniform on every index, with the point estimate slightly on the wrong side, as expected when estimation noise is added to a flat truth.
* Top-1 accuracy is 10% within sampling error. "TRADE" hit rates (6-12.6% on 66-494 forecasts, binomial sd about 1.5-4 points) are also within chance.
* The same engine does detect planted structure on simulated series (`docs/ldpe-evaluation-simulated.txt`), so the null result on real data is not a harness defect.

## Conclusion

On this data the available information does not support a forecast better than 10% per digit. Adding models, features or a more elaborate ensemble cannot create information that is not in the series, and each extra degree of freedom increases the chance of a spurious in-sample improvement. No model changes were made. The existing safeguards (shrinkage to uniform, thresholds, calibration check, structural-break detection) are retained. A TRADE signal should be read as an operational threshold, not as evidence of an edge.

Limits: 20,000 ticks per index (about 5.5 hours of 1-second data) on one day; horizon 5 only; the test cannot rule out an effect smaller than the CI half-widths (about 3e-5 nats). Re-run the script on more data to tighten the interval.
