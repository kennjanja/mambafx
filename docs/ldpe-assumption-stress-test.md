# LDPE synthetic assumption stress test

Generated 2026-10-24T11:44:30.955Z. Each scenario used 15,000 ticks per seed, 3 deterministic seeds, and horizons 1 and 5. The first 20% was reserved for candidate tuning/warm-up; scores are from subsequent forecasts.

> **Synthetic data only.** These mechanisms were deliberately planted by the generator. This tests whether models can exploit known synthetic dependencies; it is not evidence that Deriv indices have these properties or that any edge is tradable.

At horizon 1, the generator's exact conditional distribution is also scored as an oracle upper bound. At horizon 5, the oracle column is omitted because this benchmark does not compute the exact five-step conditional distribution. Model estimates use the observed prefix only. All models are scored on the same target outcomes within each scenario and horizon.

Scores are forecast-count-weighted across seeds. ΔLL is `log loss of reference - log loss of model`, in millinats per forecast; positive is better. Top-1 handles exact probability ties by splitting credit equally across tied digits (so a uniform forecast scores 10%, not whichever digit happens to be first). Brier and top-1 are descriptive. This benchmark does not make a production promotion decision.

The current LDPE has eight model modules (Dirichlet, freqShort, freqLong, decayed, trans1, trans2, gap, streak); all eight are included, alongside the current ensemble and all five new candidate families.

The generator samples each next digit from a softmax distribution over additive feature scores. Standalone mechanism strengths are intentionally strong positive controls; the combined scenario scales each feature to 40% and adds weaker recent-frequency feedback so it remains stochastic.

| Scenario | Planted conditional rule |
|---|---|
| biased-frequency | Add 1.8 logit to digit 4 and 1.1 to digit 7 on every tick. |
| markov-dependence | Add 2.2 logit to the immediately previous digit. |
| lag-memory | Add 2.2 logit to the digit four positions before the next outcome. |
| due-gap | Once the longest digit absence reaches 10 ticks, add 2.5 logit to that digit. |
| streak-persistence | After a run reaches two ticks, add 2.0 logit to the run digit. |
| increment-memory | When the last two modulo-10 increments match, add 2.3 logit to the digit predicted by repeating that increment. |
| regime-shift | Add 2.0 logit to digit 2 in the first half, then digit 8 in the second half. |
| combined-all | Apply all seven features at 40% strength; also add `0.2 × ln((recentCount + 1)/(recentWindowSize/10 + 1))` from the most recent 100 digits. |

## At a glance

| Scenario | Horizon | Best current module vs uniform | ΔLL | Best candidate vs uniform | ΔLL |

|---|---:|---|---:|---|---:|

| biased-frequency | 1 | Current Dirichlet | +288.075 | Candidate CTW-3 | +288.066 |
| biased-frequency | 5 | Current Dirichlet | +290.616 | Candidate CTW-3 | +290.603 |
| markov-dependence | 1 | Current trans1 | +501.587 | Candidate modular increment | +501.359 |
| markov-dependence | 5 | Current Dirichlet | -1.625 | Candidate modular increment | +1.300 |
| lag-memory | 1 | Current gap | +379.738 | Candidate lag tables | +163.915 |
| lag-memory | 5 | Current gap | +85.100 | Candidate lag tables | +37.889 |
| due-gap | 1 | Current gap | +448.218 | Candidate lag tables | +38.024 |
| due-gap | 5 | Current gap | +153.656 | Candidate lag tables | +37.221 |
| streak-persistence | 1 | Current streak | +39.710 | Candidate modular increment | +51.896 |
| streak-persistence | 5 | Current Dirichlet | -0.510 | Candidate modular increment | +0.103 |
| increment-memory | 1 | Current Dirichlet | -0.695 | Candidate modular increment | +18.307 |
| increment-memory | 5 | Current Dirichlet | -0.295 | Candidate modular increment | +0.012 |
| regime-shift | 1 | Current decayed | +390.263 | Candidate discounted Dirichlet | +376.503 |
| regime-shift | 5 | Current decayed | +384.629 | Candidate discounted Dirichlet | +371.056 |
| combined-all | 1 | Current streak | +653.908 | Candidate CTW-3 | +593.808 |
| combined-all | 5 | Current streak | +435.601 | Candidate lag tables | +405.518 |

## biased-frequency — horizon 1

A stable non-uniform marginal digit distribution

| Model | N | Log loss | Brier | Top-1 | ΔLL vs uniform (millinats) | ΔLL vs ensemble (millinats) |
|---|---:|---:|---:|---:|---:|---:|
| Uniform baseline | 35,997 | 2.302585 | 0.900000 | 10.00% | +0.000 | -287.229 |
| Current ensemble | 35,997 | 2.015356 | 0.819577 | 34.69% | +287.229 | +0.000 |
| Current Dirichlet | 35,997 | 2.014510 | 0.819439 | 34.69% | +288.075 | +0.845 |
| Current freqShort | 35,997 | 2.081620 | 0.833113 | 33.84% | +220.965 | -66.264 |
| Current freqLong | 35,997 | 2.018295 | 0.820062 | 34.69% | +284.290 | -2.939 |
| Current decayed | 35,997 | 2.018980 | 0.820280 | 34.69% | +283.605 | -3.624 |
| Current trans1 | 35,997 | 2.019556 | 0.820354 | 34.69% | +283.029 | -4.200 |
| Current trans2 | 35,997 | 2.053512 | 0.827861 | 34.15% | +249.074 | -38.156 |
| Current gap | 35,997 | 2.021871 | 0.820752 | 34.65% | +280.714 | -6.515 |
| Current streak | 35,997 | 2.025895 | 0.821850 | 34.53% | +276.690 | -10.539 |
| Candidate HDM | 35,997 | 2.014592 | 0.819448 | 34.69% | +287.993 | +0.764 |
| Candidate discounted Dirichlet | 35,997 | 2.016136 | 0.819723 | 34.69% | +286.449 | -0.781 |
| Candidate CTW-3 | 35,997 | 2.014519 | 0.819443 | 34.69% | +288.066 | +0.836 |
| Candidate modular increment | 35,997 | 2.236772 | 0.884189 | 18.70% | +65.813 | -221.416 |
| Candidate lag tables | 35,997 | 2.015565 | 0.819601 | 34.68% | +287.020 | -0.210 |
| Generator oracle (h=1) | 35,997 | 2.013914 | 0.819360 | 34.69% | +288.671 | +1.442 |

## biased-frequency — horizon 5

A stable non-uniform marginal digit distribution

| Model | N | Log loss | Brier | Top-1 | ΔLL vs uniform (millinats) | ΔLL vs ensemble (millinats) |
|---|---:|---:|---:|---:|---:|---:|
| Uniform baseline | 35,985 | 2.302585 | 0.900000 | 10.00% | +0.000 | -289.745 |
| Current ensemble | 35,985 | 2.012840 | 0.817925 | 35.26% | +289.745 | +0.000 |
| Current Dirichlet | 35,985 | 2.011969 | 0.817729 | 35.26% | +290.616 | +0.870 |
| Current freqShort | 35,985 | 2.081333 | 0.831963 | 34.47% | +221.252 | -68.493 |
| Current freqLong | 35,985 | 2.016211 | 0.818447 | 35.26% | +286.374 | -3.371 |
| Current decayed | 35,985 | 2.016405 | 0.818560 | 35.26% | +286.180 | -3.565 |
| Current trans1 | 35,985 | 2.016706 | 0.818652 | 35.26% | +285.879 | -3.866 |
| Current trans2 | 35,985 | 2.050958 | 0.826250 | 34.63% | +251.627 | -38.118 |
| Current gap | 35,985 | 2.019701 | 0.819190 | 35.21% | +282.884 | -6.862 |
| Current streak | 35,985 | 2.022911 | 0.820008 | 35.12% | +279.675 | -10.071 |
| Candidate HDM | 35,985 | 2.011995 | 0.817728 | 35.26% | +290.590 | +0.845 |
| Candidate discounted Dirichlet | 35,985 | 2.013600 | 0.817998 | 35.26% | +288.985 | -0.760 |
| Candidate CTW-3 | 35,985 | 2.011982 | 0.817731 | 35.26% | +290.603 | +0.858 |
| Candidate modular increment | 35,985 | 2.296563 | 0.898782 | 18.27% | +6.022 | -283.723 |
| Candidate lag tables | 35,985 | 2.013093 | 0.817952 | 35.25% | +289.492 | -0.253 |

## markov-dependence — horizon 1

The next digit depends strongly on the previous digit

| Model | N | Log loss | Brier | Top-1 | ΔLL vs uniform (millinats) | ΔLL vs ensemble (millinats) |
|---|---:|---:|---:|---:|---:|---:|
| Uniform baseline | 35,997 | 2.302585 | 0.900000 | 10.00% | +0.000 | -495.720 |
| Current ensemble | 35,997 | 1.806865 | 0.728985 | 49.83% | +495.720 | +0.000 |
| Current Dirichlet | 35,997 | 2.302854 | 0.900054 | 10.31% | -0.269 | -495.989 |
| Current freqShort | 35,997 | 2.343916 | 0.907275 | 13.59% | -41.331 | -537.051 |
| Current freqLong | 35,997 | 2.306365 | 0.900753 | 10.95% | -3.780 | -499.500 |
| Current decayed | 35,997 | 2.297946 | 0.899057 | 12.00% | +4.639 | -491.081 |
| Current trans1 | 35,997 | 1.800998 | 0.724641 | 49.83% | +501.587 | +5.867 |
| Current trans2 | 35,997 | 1.836123 | 0.733455 | 49.81% | +466.462 | -29.258 |
| Current gap | 35,997 | 1.802810 | 0.724947 | 49.83% | +499.775 | +4.055 |
| Current streak | 35,997 | 1.821672 | 0.729564 | 49.78% | +480.913 | -14.807 |
| Candidate HDM | 35,997 | 2.302914 | 0.900066 | 10.29% | -0.328 | -496.048 |
| Candidate discounted Dirichlet | 35,997 | 2.300530 | 0.899587 | 11.26% | +2.055 | -493.665 |
| Candidate CTW-3 | 35,997 | 1.801245 | 0.724643 | 49.83% | +501.340 | +5.620 |
| Candidate modular increment | 35,997 | 1.801226 | 0.724625 | 49.83% | +501.359 | +5.639 |
| Candidate lag tables | 35,997 | 2.096790 | 0.847541 | 44.35% | +205.795 | -289.925 |
| Generator oracle (h=1) | 35,997 | 1.795458 | 0.723719 | 49.83% | +507.127 | +11.407 |

## markov-dependence — horizon 5

The next digit depends strongly on the previous digit

| Model | N | Log loss | Brier | Top-1 | ΔLL vs uniform (millinats) | ΔLL vs ensemble (millinats) |
|---|---:|---:|---:|---:|---:|---:|
| Uniform baseline | 35,985 | 2.302585 | 0.900000 | 10.00% | +0.000 | +1.728 |
| Current ensemble | 35,985 | 2.304313 | 0.900339 | 10.47% | -1.728 | +0.000 |
| Current Dirichlet | 35,985 | 2.304210 | 0.900322 | 9.96% | -1.625 | +0.103 |
| Current freqShort | 35,985 | 2.475060 | 0.930351 | 10.28% | -172.475 | -170.747 |
| Current freqLong | 35,985 | 2.314025 | 0.902236 | 10.11% | -11.440 | -9.712 |
| Current decayed | 35,985 | 2.314041 | 0.902267 | 10.20% | -11.456 | -9.728 |
| Current trans1 | 35,985 | 2.310057 | 0.901475 | 10.53% | -7.471 | -5.743 |
| Current trans2 | 35,985 | 2.347495 | 0.908181 | 10.25% | -44.910 | -43.182 |
| Current gap | 35,985 | 2.310502 | 0.901535 | 10.45% | -7.917 | -6.188 |
| Current streak | 35,985 | 2.329080 | 0.905005 | 10.28% | -26.495 | -24.767 |
| Candidate HDM | 35,985 | 2.304285 | 0.900336 | 9.80% | -1.700 | +0.028 |
| Candidate discounted Dirichlet | 35,985 | 2.307509 | 0.900979 | 10.11% | -4.923 | -3.195 |
| Candidate CTW-3 | 35,985 | 2.304239 | 0.900327 | 9.96% | -1.654 | +0.074 |
| Candidate modular increment | 35,985 | 2.301285 | 0.899729 | 11.57% | +1.300 | +3.029 |
| Candidate lag tables | 35,985 | 2.305448 | 0.900576 | 10.12% | -2.863 | -1.135 |

## lag-memory — horizon 1

A digit from four ticks earlier predicts the next digit

| Model | N | Log loss | Brier | Top-1 | ΔLL vs uniform (millinats) | ΔLL vs ensemble (millinats) |
|---|---:|---:|---:|---:|---:|---:|
| Uniform baseline | 35,997 | 2.302585 | 0.900000 | 10.00% | +0.000 | -329.483 |
| Current ensemble | 35,997 | 1.973102 | 0.798484 | 42.92% | +329.483 | +0.000 |
| Current Dirichlet | 35,997 | 2.303554 | 0.900190 | 10.18% | -0.969 | -330.452 |
| Current freqShort | 35,997 | 2.333185 | 0.904981 | 13.93% | -30.600 | -360.083 |
| Current freqLong | 35,997 | 2.306449 | 0.900739 | 10.76% | -3.863 | -333.347 |
| Current decayed | 35,997 | 2.299086 | 0.899288 | 11.71% | +3.499 | -325.984 |
| Current trans1 | 35,997 | 2.307890 | 0.901029 | 10.63% | -5.305 | -334.788 |
| Current trans2 | 35,997 | 2.351755 | 0.908785 | 10.78% | -49.170 | -378.653 |
| Current gap | 35,997 | 1.922848 | 0.770419 | 42.47% | +379.738 | +50.255 |
| Current streak | 35,997 | 2.314025 | 0.902156 | 10.71% | -11.440 | -340.923 |
| Candidate HDM | 35,997 | 2.303613 | 0.900202 | 10.16% | -1.027 | -330.511 |
| Candidate discounted Dirichlet | 35,997 | 2.289629 | 0.897195 | 13.65% | +12.956 | -316.527 |
| Candidate CTW-3 | 35,997 | 2.303560 | 0.900191 | 10.19% | -0.975 | -330.458 |
| Candidate modular increment | 35,997 | 2.308532 | 0.901172 | 10.27% | -5.947 | -335.430 |
| Candidate lag tables | 35,997 | 2.138670 | 0.860969 | 49.53% | +163.915 | -165.568 |
| Generator oracle (h=1) | 35,997 | 1.797658 | 0.724610 | 49.73% | +504.927 | +175.444 |

## lag-memory — horizon 5

A digit from four ticks earlier predicts the next digit

| Model | N | Log loss | Brier | Top-1 | ΔLL vs uniform (millinats) | ΔLL vs ensemble (millinats) |
|---|---:|---:|---:|---:|---:|---:|
| Uniform baseline | 35,985 | 2.302585 | 0.900000 | 10.00% | +0.000 | -76.058 |
| Current ensemble | 35,985 | 2.226527 | 0.879986 | 24.12% | +76.058 | +0.000 |
| Current Dirichlet | 35,985 | 2.303642 | 0.900214 | 9.94% | -1.057 | -77.115 |
| Current freqShort | 35,985 | 2.412122 | 0.919088 | 11.46% | -109.537 | -185.595 |
| Current freqLong | 35,985 | 2.312369 | 0.901927 | 10.44% | -9.784 | -85.842 |
| Current decayed | 35,985 | 2.307594 | 0.900960 | 11.29% | -5.008 | -81.067 |
| Current trans1 | 35,985 | 2.311515 | 0.901755 | 10.18% | -8.930 | -84.988 |
| Current trans2 | 35,985 | 2.362233 | 0.910820 | 10.10% | -59.648 | -135.706 |
| Current gap | 35,985 | 2.217485 | 0.875606 | 23.97% | +85.100 | +9.042 |
| Current streak | 35,985 | 2.318625 | 0.903079 | 10.07% | -16.040 | -92.098 |
| Candidate HDM | 35,985 | 2.303656 | 0.900215 | 9.97% | -1.070 | -77.129 |
| Candidate discounted Dirichlet | 35,985 | 2.304934 | 0.900462 | 10.74% | -2.349 | -78.407 |
| Candidate CTW-3 | 35,985 | 2.303644 | 0.900214 | 9.93% | -1.059 | -77.117 |
| Candidate modular increment | 35,985 | 2.302585 | 0.900000 | 9.67% | +0.000 | -76.058 |
| Candidate lag tables | 35,985 | 2.264696 | 0.891598 | 25.59% | +37.889 | -38.169 |

## due-gap — horizon 1

The longest-absent digit becomes more likely after a threshold

| Model | N | Log loss | Brier | Top-1 | ΔLL vs uniform (millinats) | ΔLL vs ensemble (millinats) |
|---|---:|---:|---:|---:|---:|---:|
| Uniform baseline | 35,997 | 2.302585 | 0.900000 | 10.00% | +0.000 | -371.439 |
| Current ensemble | 35,997 | 1.931146 | 0.797462 | 53.65% | +371.439 | +0.000 |
| Current Dirichlet | 35,997 | 2.303219 | 0.900127 | 9.52% | -0.634 | -372.073 |
| Current freqShort | 35,997 | 2.380682 | 0.915012 | 6.62% | -78.097 | -449.536 |
| Current freqLong | 35,997 | 2.307134 | 0.900908 | 8.70% | -4.549 | -375.988 |
| Current decayed | 35,997 | 2.311576 | 0.901791 | 7.67% | -8.991 | -380.430 |
| Current trans1 | 35,997 | 2.289550 | 0.898031 | 10.88% | +13.035 | -358.404 |
| Current trans2 | 35,997 | 2.313057 | 0.902466 | 11.79% | -10.471 | -381.911 |
| Current gap | 35,997 | 1.854368 | 0.761065 | 53.72% | +448.218 | +76.778 |
| Current streak | 35,997 | 2.293261 | 0.898715 | 10.78% | +9.324 | -362.115 |
| Candidate HDM | 35,997 | 2.303182 | 0.900119 | 9.48% | -0.597 | -372.036 |
| Candidate discounted Dirichlet | 35,997 | 2.306565 | 0.900795 | 8.12% | -3.980 | -375.419 |
| Candidate CTW-3 | 35,997 | 2.301669 | 0.899882 | 9.55% | +0.917 | -370.523 |
| Candidate modular increment | 35,997 | 2.270006 | 0.894713 | 11.14% | +32.579 | -338.860 |
| Candidate lag tables | 35,997 | 2.264561 | 0.892505 | 14.86% | +38.024 | -333.415 |
| Generator oracle (h=1) | 35,997 | 1.615764 | 0.649343 | 57.50% | +686.821 | +315.382 |

## due-gap — horizon 5

The longest-absent digit becomes more likely after a threshold

| Model | N | Log loss | Brier | Top-1 | ΔLL vs uniform (millinats) | ΔLL vs ensemble (millinats) |
|---|---:|---:|---:|---:|---:|---:|
| Uniform baseline | 35,985 | 2.302585 | 0.900000 | 10.00% | +0.000 | -129.504 |
| Current ensemble | 35,985 | 2.173081 | 0.873310 | 19.39% | +129.504 | +0.000 |
| Current Dirichlet | 35,985 | 2.302883 | 0.900060 | 10.00% | -0.298 | -129.802 |
| Current freqShort | 35,985 | 2.341903 | 0.907996 | 7.88% | -39.318 | -168.822 |
| Current freqLong | 35,985 | 2.304939 | 0.900472 | 9.64% | -2.354 | -131.858 |
| Current decayed | 35,985 | 2.306713 | 0.900828 | 9.10% | -4.128 | -133.632 |
| Current trans1 | 35,985 | 2.288613 | 0.897940 | 10.62% | +13.972 | -115.532 |
| Current trans2 | 35,985 | 2.309367 | 0.902014 | 11.31% | -6.782 | -136.286 |
| Current gap | 35,985 | 2.148929 | 0.868432 | 19.31% | +153.656 | +24.152 |
| Current streak | 35,985 | 2.291983 | 0.898578 | 10.61% | +10.602 | -118.902 |
| Candidate HDM | 35,985 | 2.302863 | 0.900056 | 10.12% | -0.278 | -129.782 |
| Candidate discounted Dirichlet | 35,985 | 2.304405 | 0.900365 | 9.50% | -1.820 | -131.324 |
| Candidate CTW-3 | 35,985 | 2.301941 | 0.899911 | 10.06% | +0.644 | -128.860 |
| Candidate modular increment | 35,985 | 2.302092 | 0.899902 | 11.07% | +0.493 | -129.011 |
| Candidate lag tables | 35,985 | 2.265364 | 0.892678 | 14.80% | +37.221 | -92.283 |

## streak-persistence — horizon 1

A current digit run is likely to continue

| Model | N | Log loss | Brier | Top-1 | ΔLL vs uniform (millinats) | ΔLL vs ensemble (millinats) |
|---|---:|---:|---:|---:|---:|---:|
| Uniform baseline | 35,997 | 2.302585 | 0.900000 | 10.00% | +0.000 | -41.857 |
| Current ensemble | 35,997 | 2.260728 | 0.886509 | 14.99% | +41.857 | +0.000 |
| Current Dirichlet | 35,997 | 2.303035 | 0.900090 | 10.15% | -0.450 | -42.307 |
| Current freqShort | 35,997 | 2.365605 | 0.911327 | 11.32% | -63.020 | -104.877 |
| Current freqLong | 35,997 | 2.306493 | 0.900777 | 10.38% | -3.908 | -45.765 |
| Current decayed | 35,997 | 2.305812 | 0.900633 | 10.75% | -3.227 | -45.083 |
| Current trans1 | 35,997 | 2.296261 | 0.898418 | 14.78% | +6.324 | -35.533 |
| Current trans2 | 35,997 | 2.292538 | 0.889452 | 15.13% | +10.047 | -31.810 |
| Current gap | 35,997 | 2.298514 | 0.898794 | 14.71% | +4.071 | -37.786 |
| Current streak | 35,997 | 2.262875 | 0.885121 | 14.87% | +39.710 | -2.147 |
| Candidate HDM | 35,997 | 2.303130 | 0.900109 | 10.02% | -0.545 | -42.401 |
| Candidate discounted Dirichlet | 35,997 | 2.303891 | 0.900258 | 10.62% | -1.306 | -43.163 |
| Candidate CTW-3 | 35,997 | 2.303036 | 0.900090 | 10.14% | -0.450 | -42.307 |
| Candidate modular increment | 35,997 | 2.250689 | 0.881931 | 15.19% | +51.896 | +10.039 |
| Candidate lag tables | 35,997 | 2.295478 | 0.898409 | 14.59% | +7.107 | -34.750 |
| Generator oracle (h=1) | 35,997 | 2.244998 | 0.880845 | 15.07% | +57.587 | +15.730 |

## streak-persistence — horizon 5

A current digit run is likely to continue

| Model | N | Log loss | Brier | Top-1 | ΔLL vs uniform (millinats) | ΔLL vs ensemble (millinats) |
|---|---:|---:|---:|---:|---:|---:|
| Uniform baseline | 35,985 | 2.302585 | 0.900000 | 10.00% | +0.000 | +0.639 |
| Current ensemble | 35,985 | 2.303224 | 0.900127 | 10.12% | -0.639 | +0.000 |
| Current Dirichlet | 35,985 | 2.303095 | 0.900102 | 10.29% | -0.510 | +0.129 |
| Current freqShort | 35,985 | 2.391820 | 0.916616 | 9.93% | -89.235 | -88.596 |
| Current freqLong | 35,985 | 2.308593 | 0.901206 | 10.02% | -6.008 | -5.370 |
| Current decayed | 35,985 | 2.309262 | 0.901333 | 9.79% | -6.677 | -6.038 |
| Current trans1 | 35,985 | 2.308927 | 0.901254 | 9.84% | -6.342 | -5.703 |
| Current trans2 | 35,985 | 2.351826 | 0.909003 | 10.01% | -49.241 | -48.602 |
| Current gap | 35,985 | 2.310396 | 0.901523 | 10.20% | -7.810 | -7.172 |
| Current streak | 35,985 | 2.319435 | 0.903208 | 9.92% | -16.850 | -16.211 |
| Candidate HDM | 35,985 | 2.303033 | 0.900090 | 10.28% | -0.448 | +0.190 |
| Candidate discounted Dirichlet | 35,985 | 2.305578 | 0.900598 | 10.07% | -2.993 | -2.354 |
| Candidate CTW-3 | 35,985 | 2.303100 | 0.900103 | 10.29% | -0.514 | +0.124 |
| Candidate modular increment | 35,985 | 2.302482 | 0.899978 | 10.20% | +0.103 | +0.741 |
| Candidate lag tables | 35,985 | 2.304074 | 0.900293 | 10.43% | -1.488 | -0.850 |

## increment-memory — horizon 1

Modulo-10 increments tend to repeat

| Model | N | Log loss | Brier | Top-1 | ΔLL vs uniform (millinats) | ΔLL vs ensemble (millinats) |
|---|---:|---:|---:|---:|---:|---:|
| Uniform baseline | 35,997 | 2.302585 | 0.900000 | 10.00% | +0.000 | -2.764 |
| Current ensemble | 35,997 | 2.299821 | 0.899249 | 11.58% | +2.764 | +0.000 |
| Current Dirichlet | 35,997 | 2.303280 | 0.900138 | 10.08% | -0.695 | -3.459 |
| Current freqShort | 35,997 | 2.369664 | 0.911962 | 10.44% | -67.079 | -69.843 |
| Current freqLong | 35,997 | 2.306707 | 0.900819 | 10.07% | -4.122 | -6.886 |
| Current decayed | 35,997 | 2.307133 | 0.900901 | 10.11% | -4.548 | -7.313 |
| Current trans1 | 35,997 | 2.308508 | 0.901169 | 9.92% | -5.923 | -8.688 |
| Current trans2 | 35,997 | 2.327627 | 0.903428 | 14.69% | -25.042 | -27.807 |
| Current gap | 35,997 | 2.310211 | 0.901487 | 10.22% | -7.626 | -10.391 |
| Current streak | 35,997 | 2.307294 | 0.900272 | 10.46% | -4.709 | -7.473 |
| Candidate HDM | 35,997 | 2.303393 | 0.900161 | 10.03% | -0.808 | -3.573 |
| Candidate discounted Dirichlet | 35,997 | 2.304530 | 0.900386 | 10.19% | -1.945 | -4.709 |
| Candidate CTW-3 | 35,997 | 2.303287 | 0.900139 | 10.07% | -0.702 | -3.466 |
| Candidate modular increment | 35,997 | 2.284278 | 0.895453 | 17.11% | +18.307 | +15.543 |
| Candidate lag tables | 35,997 | 2.303219 | 0.900120 | 10.40% | -0.634 | -3.398 |
| Generator oracle (h=1) | 35,997 | 2.209386 | 0.867238 | 17.11% | +93.199 | +90.434 |

## increment-memory — horizon 5

Modulo-10 increments tend to repeat

| Model | N | Log loss | Brier | Top-1 | ΔLL vs uniform (millinats) | ΔLL vs ensemble (millinats) |
|---|---:|---:|---:|---:|---:|---:|
| Uniform baseline | 35,985 | 2.302585 | 0.900000 | 10.00% | +0.000 | +0.463 |
| Current ensemble | 35,985 | 2.303048 | 0.900092 | 10.32% | -0.463 | +0.000 |
| Current Dirichlet | 35,985 | 2.302881 | 0.900058 | 10.29% | -0.295 | +0.167 |
| Current freqShort | 35,985 | 2.374909 | 0.913009 | 9.92% | -72.324 | -71.861 |
| Current freqLong | 35,985 | 2.307110 | 0.900901 | 9.79% | -4.525 | -4.062 |
| Current decayed | 35,985 | 2.307700 | 0.901020 | 9.86% | -5.115 | -4.652 |
| Current trans1 | 35,985 | 2.307896 | 0.901047 | 10.24% | -5.311 | -4.848 |
| Current trans2 | 35,985 | 2.351348 | 0.908878 | 10.30% | -48.763 | -48.300 |
| Current gap | 35,985 | 2.309321 | 0.901304 | 10.16% | -6.736 | -6.273 |
| Current streak | 35,985 | 2.313787 | 0.902156 | 10.36% | -11.202 | -10.739 |
| Candidate HDM | 35,985 | 2.302847 | 0.900051 | 10.33% | -0.262 | +0.201 |
| Candidate discounted Dirichlet | 35,985 | 2.304792 | 0.900440 | 9.90% | -2.207 | -1.744 |
| Candidate CTW-3 | 35,985 | 2.302898 | 0.900061 | 10.29% | -0.313 | +0.150 |
| Candidate modular increment | 35,985 | 2.302573 | 0.899998 | 11.01% | +0.012 | +0.475 |
| Candidate lag tables | 35,985 | 2.303344 | 0.900152 | 10.42% | -0.759 | -0.296 |

## regime-shift — horizon 1

The favored digit changes halfway through the series

| Model | N | Log loss | Brier | Top-1 | ΔLL vs uniform (millinats) | ΔLL vs ensemble (millinats) |
|---|---:|---:|---:|---:|---:|---:|
| Uniform baseline | 35,997 | 2.302585 | 0.900000 | 10.00% | +0.000 | -391.151 |
| Current ensemble | 35,997 | 1.911434 | 0.769262 | 44.82% | +391.151 | +0.000 |
| Current Dirichlet | 35,997 | 2.104079 | 0.858242 | 20.88% | +198.507 | -192.644 |
| Current freqShort | 35,997 | 1.961674 | 0.777817 | 44.97% | +340.911 | -50.240 |
| Current freqLong | 35,997 | 1.918214 | 0.772117 | 43.53% | +384.371 | -6.780 |
| Current decayed | 35,997 | 1.912322 | 0.769541 | 44.09% | +390.263 | -0.888 |
| Current trans1 | 35,997 | 2.050423 | 0.830496 | 30.88% | +252.162 | -138.989 |
| Current trans2 | 35,997 | 2.047309 | 0.818918 | 35.60% | +255.276 | -135.874 |
| Current gap | 35,997 | 1.986207 | 0.801789 | 38.42% | +316.379 | -74.772 |
| Current streak | 35,997 | 2.054572 | 0.830969 | 30.92% | +248.013 | -143.137 |
| Candidate HDM | 35,997 | 2.117852 | 0.864474 | 20.56% | +184.733 | -206.418 |
| Candidate discounted Dirichlet | 35,997 | 1.926082 | 0.776143 | 42.86% | +376.503 | -14.648 |
| Candidate CTW-3 | 35,997 | 2.068569 | 0.839562 | 29.56% | +234.016 | -157.135 |
| Candidate modular increment | 35,997 | 2.175735 | 0.864150 | 23.65% | +126.850 | -264.300 |
| Candidate lag tables | 35,997 | 2.030903 | 0.823631 | 32.74% | +271.682 | -119.469 |
| Generator oracle (h=1) | 35,997 | 1.895483 | 0.763449 | 45.06% | +407.102 | +15.951 |

## regime-shift — horizon 5

The favored digit changes halfway through the series

| Model | N | Log loss | Brier | Top-1 | ΔLL vs uniform (millinats) | ΔLL vs ensemble (millinats) |
|---|---:|---:|---:|---:|---:|---:|
| Uniform baseline | 35,985 | 2.302585 | 0.900000 | 10.00% | +0.000 | -384.423 |
| Current ensemble | 35,985 | 1.918162 | 0.771752 | 44.54% | +384.423 | +0.000 |
| Current Dirichlet | 35,985 | 2.110877 | 0.859988 | 20.81% | +191.708 | -192.715 |
| Current freqShort | 35,985 | 1.970337 | 0.780640 | 44.71% | +332.249 | -52.175 |
| Current freqLong | 35,985 | 1.923833 | 0.774348 | 43.20% | +378.752 | -5.671 |
| Current decayed | 35,985 | 1.917956 | 0.771652 | 43.86% | +384.629 | +0.206 |
| Current trans1 | 35,985 | 2.058144 | 0.832889 | 30.41% | +244.441 | -139.983 |
| Current trans2 | 35,985 | 2.053996 | 0.821034 | 35.23% | +248.589 | -135.835 |
| Current gap | 35,985 | 1.990309 | 0.803520 | 38.17% | +312.276 | -72.147 |
| Current streak | 35,985 | 2.062692 | 0.833258 | 30.41% | +239.894 | -144.530 |
| Candidate HDM | 35,985 | 2.124422 | 0.865950 | 20.51% | +178.163 | -206.260 |
| Candidate discounted Dirichlet | 35,985 | 1.931529 | 0.778217 | 42.58% | +371.056 | -13.368 |
| Candidate CTW-3 | 35,985 | 2.076555 | 0.842185 | 29.08% | +226.031 | -158.393 |
| Candidate modular increment | 35,985 | 2.287646 | 0.896892 | 23.30% | +14.939 | -369.484 |
| Candidate lag tables | 35,985 | 2.036922 | 0.825318 | 32.49% | +265.663 | -118.760 |

## combined-all — horizon 1

All of the above mechanisms act together, plus recent-frequency feedback

| Model | N | Log loss | Brier | Top-1 | ΔLL vs uniform (millinats) | ΔLL vs ensemble (millinats) |
|---|---:|---:|---:|---:|---:|---:|
| Uniform baseline | 35,997 | 2.302585 | 0.900000 | 10.00% | +0.000 | -641.845 |
| Current ensemble | 35,997 | 1.660741 | 0.660168 | 48.24% | +641.845 | +0.000 |
| Current Dirichlet | 35,997 | 2.111439 | 0.862282 | 19.63% | +191.146 | -450.698 |
| Current freqShort | 35,997 | 1.903677 | 0.771590 | 39.18% | +398.908 | -242.936 |
| Current freqLong | 35,997 | 1.967472 | 0.812741 | 32.42% | +335.113 | -306.731 |
| Current decayed | 35,997 | 1.939552 | 0.800565 | 34.85% | +363.033 | -278.812 |
| Current trans1 | 35,997 | 1.753092 | 0.703635 | 46.76% | +549.493 | -92.352 |
| Current trans2 | 35,997 | 1.689565 | 0.660689 | 46.98% | +613.020 | -28.825 |
| Current gap | 35,997 | 1.716170 | 0.687280 | 48.23% | +586.415 | -55.429 |
| Current streak | 35,997 | 1.648677 | 0.648962 | 47.31% | +653.908 | +12.064 |
| Candidate HDM | 35,997 | 2.112847 | 0.862829 | 19.47% | +189.738 | -452.107 |
| Candidate discounted Dirichlet | 35,997 | 1.885159 | 0.773161 | 39.01% | +417.426 | -224.418 |
| Candidate CTW-3 | 35,997 | 1.708777 | 0.675280 | 46.62% | +593.808 | -48.036 |
| Candidate modular increment | 35,997 | 1.714257 | 0.671804 | 47.05% | +588.328 | -53.517 |
| Candidate lag tables | 35,997 | 1.759164 | 0.707634 | 46.14% | +543.421 | -98.424 |
| Generator oracle (h=1) | 35,997 | 1.525638 | 0.614747 | 51.47% | +776.947 | +135.103 |

## combined-all — horizon 5

All of the above mechanisms act together, plus recent-frequency feedback

| Model | N | Log loss | Brier | Top-1 | ΔLL vs uniform (millinats) | ΔLL vs ensemble (millinats) |
|---|---:|---:|---:|---:|---:|---:|
| Uniform baseline | 35,985 | 2.302585 | 0.900000 | 10.00% | +0.000 | -451.648 |
| Current ensemble | 35,985 | 1.850937 | 0.751949 | 40.79% | +451.648 | +0.000 |
| Current Dirichlet | 35,985 | 2.077908 | 0.852100 | 23.73% | +224.678 | -226.971 |
| Current freqShort | 35,985 | 1.977527 | 0.797346 | 37.15% | +325.058 | -126.590 |
| Current freqLong | 35,985 | 1.956856 | 0.811072 | 32.63% | +345.729 | -105.919 |
| Current decayed | 35,985 | 1.931362 | 0.799153 | 34.75% | +371.223 | -80.425 |
| Current trans1 | 35,985 | 1.900700 | 0.770884 | 39.44% | +401.885 | -49.764 |
| Current trans2 | 35,985 | 1.887660 | 0.753998 | 39.38% | +414.925 | -36.723 |
| Current gap | 35,985 | 1.883708 | 0.764761 | 40.43% | +418.877 | -32.771 |
| Current streak | 35,985 | 1.866984 | 0.748711 | 39.56% | +435.601 | -16.047 |
| Candidate HDM | 35,985 | 2.078835 | 0.852395 | 23.73% | +223.751 | -227.898 |
| Candidate discounted Dirichlet | 35,985 | 1.928514 | 0.794664 | 35.73% | +374.071 | -77.577 |
| Candidate CTW-3 | 35,985 | 1.899767 | 0.770007 | 39.43% | +402.818 | -48.830 |
| Candidate modular increment | 35,985 | 2.042524 | 0.819230 | 36.80% | +260.061 | -191.587 |
| Candidate lag tables | 35,985 | 1.897067 | 0.771426 | 38.95% | +405.518 | -46.131 |

## Interpretation guide

- A planted-mechanism scenario is a positive control: the generator is deliberately informative. A model beating uniform there demonstrates recovery of that synthetic signal only.

- The combined scenario is intentionally difficult: mechanisms may reinforce or conflict. Individual mechanisms are reported separately so a composite score cannot hide which assumptions a model handles.

- The “oracle” is the exact next-digit distribution used by the generator, not an implementable forecast model.

- No real tick data, accounts, order placement, or production LDPE paths are used or changed.
