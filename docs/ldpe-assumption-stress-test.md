LDPE synthetic assumption-true comparison
Current freqLong

SYNTHETIC - not evidence about real markets

Generated 2026-10-24T14:29:00.421Z. Each scenario used 15,000 ticks per seed, 3 deterministic seeds, and horizons 1, 5, 10. The first 20% was reserved for candidate tuning/warm-up. All models within a cell share the exact same scored origins and outcomes.

For horizon 1, the oracle uses the exact generator probabilities. At horizons 5 and 10, it is exact for the independent frequency/regime/null generators and for finite-context Markov, lag, streak, and increment generators; due-gap and combined use a conditional Monte Carlo oracle with 5,000 paths per selected origin and Jeffreys 0.5-count smoothing. Since that computation is expensive, horizons 5 and 10 use 300 evenly spaced scored origins per seed; horizon 1 scores every post-warmup origin. Oracle estimates are labeled in the tables, and model-vs-oracle bands include a conservative Monte Carlo uncertainty margin for the estimated oracle.

Log loss, Brier, and hit rate are forecast-count-weighted across seeds. Gain captured is (LL_uniform - LL_model) / (LL_uniform - LL_oracle); it is not applicable when the oracle gain is zero. The reported 95% intervals use paired circular block bootstrap (1,000 replicates; block length is 50 or twice the horizon, capped at one-third of the sample). Model-vs-oracle intervals use a simultaneous max-deviation bootstrap band across all tested models.

Hit rate splits credit equally across exact probability ties, so a uniform forecast scores 10%.

The weighted mixture is prequential: it updates expert log-loss weights only after outcomes arrive, retains a 5% uniform floor, and caps each cluster at 40%. No live execution, thresholds, stakes, risk controls, network, or order placement are involved.

Scenario
Strength
Planted rule
null-uniform
0
i.i.d. uniform; false-positive control and exact oracle = uniform.
biased-frequency
1
Add 1.8 logit to digit 4 and 1.1 to digit 7 on every tick.
markov-dependence
1
Add 2.2 logit to the immediately previous digit.
lag-memory
1
Add 2.2 logit to the digit four positions before the next outcome.
due-gap
1
Once the longest digit absence reaches 10 ticks, add 2.5 logit to that digit.
streak-persistence
1
After a run reaches two ticks, add 2.0 logit to the run digit.
increment-memory
1
When the last two modulo-10 increments match, add 2.3 logit to the repeated-increment prediction.
regime-shift
1
Add 2.0 logit to digit 2 in the first half, then digit 8 in the second half.
combined-all
0.4
All seven features at 40% strength, plus weaker 100-tick frequency feedback.

Summary: best current, ensemble, and best new

Scenario
H
Oracle
Best current vs oracle (LL diff, 95% CI)
Ensemble vs oracle (LL diff, 95% CI)
Best new vs oracle (LL diff, 95% CI)
Best current vs best new (LL diff, 95% CI)
null-uniform
1
exact
Current Dirichlet − True generator oracle: +0.00047 [-0.0037, +0.0046]
Current ensemble (final vector) − True generator oracle: +0.00001 [-0.0041, +0.0041]
New weighted mixture − True generator oracle: +0.00039 [-0.0037, +0.0045]
Current Dirichlet − New weighted mixture: +0.00008 [-0.0002, +0.0003]

null-uniform — horizon 1 (exact)

Strength 0: i.i.d. uniform digits; oracle equals uniform

Group
Model
N
Log loss
Brier
Hit rate
Gain captured
LL(model−oracle), 95% block CI
BASELINE
Uniform baseline
35,997
2.302585
0.900000
10.00%
n/a
+0.00000 [-0.0041, +0.0041]
CURRENT
Current ensemble (final vector)
35,997
2.302594
0.900002
9.92%
n/a
+0.00001 [-0.0041, +0.0041]
CURRENT
Current Dirichlet
35,997
2.303055
0.900094
10.24%
n/a
+0.00047 [-0.0037, +0.0046]
CURRENT
Current freqShort
35,997
2.371222
0.912283
10.21%
n/a
+0.06864 [+0.0645, +0.0728]
CURRENT
Current freqLong
35,997
2.306677
0.900812
9.81%
n/a
+0.00409 [-0.0000, +0.0082]
CURRENT
Current decayed
35,997
2.307541
0.900988
9.74%
n/a
+0.00496 [+0.0008, +0.0091]
CURRENT
Current trans1
35,997
2.308050
0.901084
10.00%
n/a
+0.00547 [+0.0013, +0.0096]
CURRENT
Current trans2
35,997
2.351291
0.908957
10.07%
n/a
+0.04871 [+0.0446, +0.0528]
CURRENT
Current gap
35,997
2.310340
0.901524
9.94%
n/a
+0.00776 [+0.0036, +0.0119]
CURRENT
Current streak
35,997
2.313446
0.902069
10.05%
n/a
+0.01086 [+0.0067, +0.0150]
NEW
Candidate HDM
35,997
2.303074
0.900097
10.32%
n/a
+0.00049 [-0.0036, +0.0046]
NEW
Candidate discounted Dirichlet
35,997
2.304727
0.900427
9.87%
n/a
+0.00214 [-0.0020, +0.0063]
NEW
Candidate CTW-3
35,997
2.303059
0.900094
10.21%
n/a
+0.00047 [-0.0036, +0.0046]
NEW
Candidate modular increment
35,997
2.308519
0.901159
10.05%
n/a
+0.00593 [+0.0018, +0.0101]
NEW
Candidate lag tables
35,997
2.304101
0.900303
10.11%
n/a
+0.00152 [-0.0026, +0.0056]
NEW
New softmax regression
35,997
2.336709
0.907025
9.85%
n/a
+0.03412 [+0.0300, +0.0382]
NEW
New gapRamp (L=122)
35,997
2.304541
0.900427
9.96%
n/a
+0.00196 [-0.0022, +0.0061]
NEW
New weighted mixture
35,997
2.302980
0.900079
10.33%
n/a
+0.00039 [-0.0037, +0.0045]
ORACLE
True generator oracle
35,997
2.302585
0.900000
10.00%
n/a
+0.00000 [+0.0000, +0.0000]

Mean earned mixture weights in the scored window:

Expert
Mean weight





Current Dirichlet
10.04%





Current freqShort
0.01%





Current freqLong
2.83%





Current decayed
5.37%





Candidate HDM
14.17%





Candidate discounted Dirichlet
7.58%





Current trans1
1.21%





Current trans2
0.00%





Candidate CTW-3
13.30%





Candidate modular increment
0.58%





Candidate lag tables
21.09%





New softmax regression
0.82%





Current gap
1.79%





New gapRamp (L=122)
20.78%





Current streak
0.42%





null-uniform
5
exact
Current Dirichlet − True generator oracle: +0.00069 [-0.0279, +0.0293]
Current ensemble (final vector) − True generator oracle: -0.00004 [-0.0286, +0.0285]
Candidate modular increment − True generator oracle: +0.00000 [-0.0286, +0.0286]
Current Dirichlet − Candidate modular increment: +0.00069 [-0.0013, +0.0029]

null-uniform — horizon 5 (exact)

Strength 0: i.i.d. uniform digits; oracle equals uniform

Group
Model
N
Log loss
Brier
Hit rate
Gain captured
LL(model−oracle), 95% block CI
BASELINE
Uniform baseline
900
2.302585
0.900000
10.00%
n/a
+0.00000 [-0.0286, +0.0286]
CURRENT
Current ensemble (final vector)
900
2.302542
0.899991
10.34%
n/a
-0.00004 [-0.0286, +0.0285]
CURRENT
Current Dirichlet
900
2.303278
0.900133
9.44%
n/a
+0.00069 [-0.0279, +0.0293]
CURRENT
Current freqShort
900
2.353969
0.908604
10.88%
n/a
+0.05138 [+0.0228, +0.0800]
CURRENT
Current freqLong
900
2.305224
0.900511
10.83%
n/a
+0.00264 [-0.0259, +0.0312]
CURRENT
Current decayed
900
2.304891
0.900462
10.22%
n/a
+0.00231 [-0.0263, +0.0309]
CURRENT
Current trans1
900
2.307061
0.900875
10.34%
n/a
+0.00448 [-0.0241, +0.0331]
CURRENT
Current trans2
900
2.353479
0.908816
10.37%
n/a
+0.05089 [+0.0223, +0.0795]
CURRENT
Current gap
900
2.314318
0.902382
8.44%
n/a
+0.01173 [-0.0168, +0.0403]
CURRENT
Current streak
900
2.318053
0.902974
9.37%
n/a
+0.01547 [-0.0131, +0.0440]
NEW
Candidate HDM
900
2.303298
0.900137
10.11%
n/a
+0.00071 [-0.0279, +0.0293]
NEW
Candidate discounted Dirichlet
900
2.303799
0.900230
11.44%
n/a
+0.00121 [-0.0274, +0.0298]
NEW
Candidate CTW-3
900
2.303360
0.900149
9.39%
n/a
+0.00078 [-0.0278, +0.0294]
NEW
Candidate modular increment
900
2.302588
0.900001
10.22%
n/a
+0.00000 [-0.0286, +0.0286]
NEW
Candidate lag tables
900
2.305034
0.900467
10.00%
n/a
+0.00245 [-0.0261, +0.0310]
NEW
New softmax regression
900
2.326437
0.904716
11.33%
n/a
+0.02385 [-0.0047, +0.0524]
NEW
New gapRamp (L=122)
900
2.308422
0.901230
9.11%
n/a
+0.00584 [-0.0227, +0.0344]
NEW
New weighted mixture
900
2.303600
0.900199
9.89%
n/a
+0.00101 [-0.0276, +0.0296]
ORACLE
True generator oracle
900
2.302585
0.900000
10.00%
n/a
+0.00000 [+0.0000, +0.0000]

Mean earned mixture weights in the scored window:

Expert
Mean weight





Current Dirichlet
10.28%





Current freqShort
0.01%





Current freqLong
1.77%





Current decayed
5.31%





Candidate HDM
15.10%





Candidate discounted Dirichlet
7.54%





Current trans1
0.73%





Current trans2
0.00%





Candidate CTW-3
7.59%





Candidate modular increment
18.04%





Candidate lag tables
13.08%





New softmax regression
0.55%





Current gap
1.54%





New gapRamp (L=122)
18.07%





Current streak
0.39%





null-uniform
10
exact
Current Dirichlet − True generator oracle: -0.00140 [-0.0305, +0.0277]
Current ensemble (final vector) − True generator oracle: -0.00007 [-0.0292, +0.0291]
Candidate HDM − True generator oracle: -0.00154 [-0.0307, +0.0276]
Current Dirichlet − Candidate HDM: +0.00014 [-0.0002, +0.0005]

null-uniform — horizon 10 (exact)

Strength 0: i.i.d. uniform digits; oracle equals uniform

Group
Model
N
Log loss
Brier
Hit rate
Gain captured
LL(model−oracle), 95% block CI
BASELINE
Uniform baseline
900
2.302585
0.900000
10.00%
n/a
+0.00000 [-0.0291, +0.0291]
CURRENT
Current ensemble (final vector)
900
2.302516
0.899986
9.68%
n/a
-0.00007 [-0.0292, +0.0291]
CURRENT
Current Dirichlet
900
2.301181
0.899728
8.72%
n/a
-0.00140 [-0.0305, +0.0277]
CURRENT
Current freqShort
900
2.384082
0.914322
10.43%
n/a
+0.08150 [+0.0524, +0.1106]
CURRENT
Current freqLong
900
2.307248
0.900947
9.78%
n/a
+0.00466 [-0.0245, +0.0338]
CURRENT
Current decayed
900
2.309229
0.901378
8.89%
n/a
+0.00664 [-0.0225, +0.0358]
CURRENT
Current trans1
900
2.308188
0.901090
10.64%
n/a
+0.00560 [-0.0235, +0.0347]
CURRENT
Current trans2
900
2.352239
0.909294
9.33%
n/a
+0.04965 [+0.0205, +0.0788]
CURRENT
Current gap
900
2.308197
0.901173
10.00%
n/a
+0.00561 [-0.0235, +0.0347]
CURRENT
Current streak
900
2.316935
0.902832
11.43%
n/a
+0.01435 [-0.0148, +0.0435]
NEW
Candidate HDM
900
2.301046
0.899703
9.33%
n/a
-0.00154 [-0.0307, +0.0276]
NEW
Candidate discounted Dirichlet
900
2.304660
0.900439
9.22%
n/a
+0.00208 [-0.0271, +0.0312]
NEW
Candidate CTW-3
900
2.301235
0.899740
9.06%
n/a
-0.00135 [-0.0305, +0.0278]
NEW
Candidate modular increment
900
2.302585
0.900000
10.00%
n/a
-0.00000 [-0.0291, +0.0291]
NEW
Candidate lag tables
900
2.303601
0.900197
9.89%
n/a
+0.00102 [-0.0281, +0.0301]
NEW
New softmax regression
900
2.348051
0.908989
10.11%
n/a
+0.04547 [+0.0163, +0.0746]
NEW
New gapRamp (L=122)
900
2.301983
0.899864
11.44%
n/a
-0.00060 [-0.0297, +0.0285]
NEW
New weighted mixture
900
2.301772
0.899841
10.11%
n/a
-0.00081 [-0.0299, +0.0283]
ORACLE
True generator oracle
900
2.302585
0.900000
10.00%
n/a
+0.00000 [+0.0000, +0.0000]

Mean earned mixture weights in the scored window:

Expert
Mean weight





Current Dirichlet
9.84%





Current freqShort
0.01%





Current freqLong
3.36%





Current decayed
5.48%





Candidate HDM
13.63%





Candidate discounted Dirichlet
7.67%





Current trans1
0.83%





Current trans2
0.00%





Candidate CTW-3
7.76%





Candidate modular increment
18.42%





Candidate lag tables
12.35%





New softmax regression
0.63%





Current gap
1.46%





New gapRamp (L=122)
18.17%





Current streak
0.37%





biased-frequency
1
exact
Current Dirichlet − True generator oracle: +0.00060 [-0.0089, +0.0101]
Current ensemble (final vector) − True generator oracle: +0.00144 [-0.0081, +0.0110]
Candidate CTW-3 − True generator oracle: +0.00061 [-0.0089, +0.0101]
Current Dirichlet − Candidate CTW-3: -0.00001 [-0.0000, +0.0000]

biased-frequency — horizon 1 (exact)

A stable non-uniform marginal digit distribution

Group
Model
N
Log loss
Brier
Hit rate
Gain captured
LL(model−oracle), 95% block CI
BASELINE
Uniform baseline
35,997
2.302585
0.900000
10.00%
0.000
+0.28867 [+0.2791, +0.2982]
CURRENT
Current ensemble (final vector)
35,997
2.015356
0.819577
34.69%
0.995
+0.00144 [-0.0081, +0.0110]
CURRENT
Current Dirichlet
35,997
2.014510
0.819439
34.69%
0.998
+0.00060 [-0.0089, +0.0101]
CURRENT
Current freqShort
35,997
2.081620
0.833113
33.84%
0.765
+0.06771 [+0.0582, +0.0772]
CURRENT
Current freqLong
35,997
2.018295
0.820062
34.69%
0.985
+0.00438 [-0.0052, +0.0139]
CURRENT
Current decayed
35,997
2.018980
0.820280
34.69%
0.982
+0.00507 [-0.0045, +0.0146]
CURRENT
Current trans1
35,997
2.019556
0.820354
34.69%
0.980
+0.00564 [-0.0039, +0.0152]
CURRENT
Current trans2
35,997
2.053512
0.827861
34.15%
0.863
+0.03960 [+0.0301, +0.0491]
CURRENT
Current gap
35,997
2.021871
0.820752
34.65%
0.972
+0.00796 [-0.0016, +0.0175]
CURRENT
Current streak
35,997
2.025895
0.821850
34.53%
0.958
+0.01198 [+0.0024, +0.0215]
NEW
Candidate HDM
35,997
2.014592
0.819448
34.69%
0.998
+0.00068 [-0.0089, +0.0102]
NEW
Candidate discounted Dirichlet
35,997
2.016136
0.819723
34.69%
0.992
+0.00222 [-0.0073, +0.0118]
NEW
Candidate CTW-3
35,997
2.014519
0.819443
34.69%
0.998
+0.00061 [-0.0089, +0.0101]
NEW
Candidate modular increment
35,997
2.236772
0.884189
18.70%
0.228
+0.22286 [+0.2133, +0.2324]
NEW
Candidate lag tables
35,997
2.015565
0.819601
34.68%
0.994
+0.00165 [-0.0079, +0.0112]
NEW
New softmax regression
35,997
2.045879
0.828515
33.98%
0.889
+0.03197 [+0.0224, +0.0415]
NEW
New gapRamp (L=122)
35,997
2.339301
0.907550
6.13%
-0.127
+0.32539 [+0.3158, +0.3349]
NEW
New weighted mixture
35,997
2.015214
0.819626
34.69%
0.995
+0.00130 [-0.0082, +0.0108]
ORACLE
True generator oracle
35,997
2.013914
0.819360
34.69%
1.000
+0.00000 [+0.0000, +0.0000]

Mean earned mixture weights in the scored window:

Expert
Mean weight





Current Dirichlet
10.05%





Current freqShort
0.03%





Current freqLong
2.04%





Current decayed
5.76%





Candidate HDM
14.04%





Candidate discounted Dirichlet
8.08%





Current trans1
3.24%





Current trans2
0.00%





Candidate CTW-3
34.36%





Candidate modular increment
0.00%





Candidate lag tables
0.85%





New softmax regression
1.54%





Current gap
16.16%





New gapRamp (L=122)
0.00%





Current streak
3.84%





biased-frequency
5
exact
Current decayed − True generator oracle: +0.00025 [-0.0691, +0.0696]
Current ensemble (final vector) − True generator oracle: -0.00024 [-0.0696, +0.0692]
New weighted mixture − True generator oracle: -0.00061 [-0.0700, +0.0688]
Current decayed − New weighted mixture: +0.00086 [-0.0042, +0.0061]

biased-frequency — horizon 5 (exact)

A stable non-uniform marginal digit distribution

Group
Model
N
Log loss
Brier
Hit rate
Gain captured
LL(model−oracle), 95% block CI
BASELINE
Uniform baseline
900
2.302585
0.900000
10.00%
0.000
+0.26010 [+0.1907, +0.3295]
CURRENT
Current ensemble (final vector)
900
2.042249
0.827728
33.44%
1.001
-0.00024 [-0.0696, +0.0692]
CURRENT
Current Dirichlet
900
2.043530
0.828224
33.44%
0.996
+0.00105 [-0.0683, +0.0704]
CURRENT
Current freqShort
900
2.077358
0.834278
32.83%
0.866
+0.03487 [-0.0345, +0.1043]
CURRENT
Current freqLong
900
2.044299
0.827809
33.44%
0.993
+0.00181 [-0.0676, +0.0712]
CURRENT
Current decayed
900
2.042735
0.827649
33.44%
0.999
+0.00025 [-0.0691, +0.0696]
CURRENT
Current trans1
900
2.048509
0.828775
33.44%
0.977
+0.00602 [-0.0634, +0.0754]
CURRENT
Current trans2
900
2.059811
0.830047
33.50%
0.933
+0.01733 [-0.0521, +0.0867]
CURRENT
Current gap
900
2.047460
0.828707
33.56%
0.981
+0.00497 [-0.0644, +0.0744]
CURRENT
Current streak
900
2.055727
0.830088
33.24%
0.949
+0.01324 [-0.0562, +0.0826]
NEW
Candidate HDM
900
2.043613
0.828232
33.44%
0.996
+0.00113 [-0.0683, +0.0705]
NEW
Candidate discounted Dirichlet
900
2.043470
0.827827
33.44%
0.996
+0.00099 [-0.0684, +0.0704]
NEW
Candidate CTW-3
900
2.043575
0.828240
33.44%
0.996
+0.00109 [-0.0683, +0.0705]
NEW
Candidate modular increment
900
2.296775
0.898824
19.00%
0.022
+0.25429 [+0.1849, +0.3237]
NEW
Candidate lag tables
900
2.043176
0.828060
33.44%
0.997
+0.00069 [-0.0687, +0.0701]
NEW
New softmax regression
900
2.061779
0.833817
32.89%
0.926
+0.01929 [-0.0501, +0.0887]
NEW
New gapRamp (L=122)
900
2.345143
0.908784
4.67%
-0.164
+0.30266 [+0.2333, +0.3721]
NEW
New weighted mixture
900
2.041879
0.827662
33.44%
1.002
-0.00061 [-0.0700, +0.0688]
ORACLE
True generator oracle
900
2.042485
0.828043
33.44%
1.000
+0.00000 [+0.0000, +0.0000]

Mean earned mixture weights in the scored window:

Expert
Mean weight





Current Dirichlet
9.98%





Current freqShort
0.01%





Current freqLong
2.53%





Current decayed
5.35%





Candidate HDM
14.34%





Candidate discounted Dirichlet
7.78%





Current trans1
3.11%





Current trans2
0.00%





Candidate CTW-3
34.69%





Candidate modular increment
0.00%





Candidate lag tables
0.80%





New softmax regression
1.40%





Current gap
16.21%





New gapRamp (L=122)
0.00%





Current streak
3.79%





biased-frequency
10
exact
Current Dirichlet − True generator oracle: -0.00013 [-0.0683, +0.0680]
Current ensemble (final vector) − True generator oracle: +0.00169 [-0.0665, +0.0699]
Candidate CTW-3 − True generator oracle: -0.00008 [-0.0682, +0.0681]
Current Dirichlet − Candidate CTW-3: -0.00005 [-0.0002, +0.0000]

biased-frequency — horizon 10 (exact)

A stable non-uniform marginal digit distribution

Group
Model
N
Log loss
Brier
Hit rate
Gain captured
LL(model−oracle), 95% block CI
BASELINE
Uniform baseline
900
2.302585
0.900000
10.00%
0.000
+0.27599 [+0.2078, +0.3442]
CURRENT
Current ensemble (final vector)
900
2.028288
0.822237
34.67%
0.994
+0.00169 [-0.0665, +0.0699]
CURRENT
Current Dirichlet
900
2.026461
0.821898
34.67%
1.000
-0.00013 [-0.0683, +0.0680]
CURRENT
Current freqShort
900
2.112317
0.836777
34.83%
0.689
+0.08572 [+0.0176, +0.1539]
CURRENT
Current freqLong
900
2.034987
0.823264
34.67%
0.970
+0.00839 [-0.0598, +0.0766]
CURRENT
Current decayed
900
2.035951
0.823986
34.67%
0.966
+0.00935 [-0.0588, +0.0775]
CURRENT
Current trans1
900
2.027594
0.821710
34.67%
0.996
+0.00100 [-0.0672, +0.0692]
CURRENT
Current trans2
900
2.068118
0.830459
34.43%
0.850
+0.04152 [-0.0266, +0.1097]
CURRENT
Current gap
900
2.033264
0.821912
34.56%
0.976
+0.00667 [-0.0615, +0.0748]
CURRENT
Current streak
900
2.029047
0.822209
34.73%
0.991
+0.00245 [-0.0657, +0.0706]
NEW
Candidate HDM
900
2.026842
0.821954
34.67%
0.999
+0.00025 [-0.0679, +0.0684]
NEW
Candidate discounted Dirichlet
900
2.029904
0.822607
34.67%
0.988
+0.00331 [-0.0649, +0.0715]
NEW
Candidate CTW-3
900
2.026516
0.821895
34.67%
1.000
-0.00008 [-0.0682, +0.0681]
NEW
Candidate modular increment
900
2.302492
0.899981
17.67%
0.000
+0.27590 [+0.2077, +0.3441]
NEW
Candidate lag tables
900
2.029867
0.822890
34.67%
0.988
+0.00327 [-0.0649, +0.0714]
NEW
New softmax regression
900
2.066173
0.833496
33.78%
0.857
+0.03958 [-0.0286, +0.1077]
NEW
New gapRamp (L=122)
900
2.335226
0.906688
7.00%
-0.118
+0.30863 [+0.2405, +0.3768]
NEW
New weighted mixture
900
2.026838
0.821843
34.67%
0.999
+0.00024 [-0.0679, +0.0684]
ORACLE
True generator oracle
900
2.026596
0.822110
34.67%
1.000
+0.00000 [+0.0000, +0.0000]

Mean earned mixture weights in the scored window:

Expert
Mean weight





Current Dirichlet
9.96%





Current freqShort
0.01%





> 
|  |  |  |
| --- | ---: | --- |
|  |  |  |
|  |  |  |
|  |  |  |
|  |  |  |
|  |  |  |
|  |  |  |
|  |  |  |
|  |  |  |
|  |  |  |
|  |  |  |  |  |  |  |
| --- | ---: | --- | --- | --- | --- | --- |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
| --- | ---: | --- | --- | --- | --- | --- |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
| --- | ---: | --- | --- | --- | --- | --- |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
| --- | ---: | --- | --- | --- | --- | --- |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
| --- | ---: | --- | --- | --- | --- | --- |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
| --- | ---: | --- | --- | --- | --- | --- |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
| --- | ---: | --- | --- | --- | --- | --- |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  | 2.95% |  |  |  |  |  |
| Current decayed | 5.37% |  |  |  |  |  |
| Candidate HDM | 13.93% |  |  |  |  |  |
| Candidate discounted Dirichlet | 7.78% |  |  |  |  |  |
| Current trans1 | 3.32% |  |  |  |  |  |
| Current trans2 | 0.00% |  |  |  |  |  |
| Candidate CTW-3 | 34.04% |  |  |  |  |  |
| Candidate modular increment | 0.00% |  |  |  |  |  |
| Candidate lag tables | 1.30% |  |  |  |  |  |
| New softmax regression | 1.34% |  |  |  |  |  |
| Current gap | 16.25% |  |  |  |  |  |
| New gapRamp (L=122) | 0.00% |  |  |  |  |  |
| Current streak | 3.75% |  |  |  |  |  |
| markov-dependence | 1 | exact | Current trans1 − True generator oracle: +0.00554 [-0.0075, +0.0185] | Current ensemble (final vector) − True generator oracle: +0.01141 [-0.0016, +0.0244] | New weighted mixture − True generator oracle: +0.00484 [-0.0081, +0.0178] | Current trans1 − New weighted mixture: +0.00070 [-0.0004, +0.0017] |

### markov-dependence — horizon 1 (exact)

The next digit depends strongly on the previous digit

| Group | Model | N | Log loss | Brier | Hit rate | Gain captured | LL(model−oracle), 95% block CI |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| BASELINE | Uniform baseline | 35,997 | 2.302585 | 0.900000 | 10.00% | 0.000 | +0.50713 [+0.4941, +0.5201] |
| CURRENT | Current ensemble (final vector) | 35,997 | 1.806865 | 0.728985 | 49.83% | 0.978 | +0.01141 [-0.0016, +0.0244] |
| CURRENT | Current Dirichlet | 35,997 | 2.302854 | 0.900054 | 10.31% | -0.001 | +0.50740 [+0.4944, +0.5204] |
| CURRENT | Current freqShort | 35,997 | 2.343916 | 0.907275 | 13.59% | -0.082 | +0.54846 [+0.5355, +0.5614] |
| CURRENT | Current freqLong | 35,997 | 2.306365 | 0.900753 | 10.95% | -0.007 | +0.51091 [+0.4979, +0.5239] |
| CURRENT | Current decayed | 35,997 | 2.297946 | 0.899057 | 12.00% | 0.009 | +0.50249 [+0.4895, +0.5155] |
| CURRENT | Current trans1 | 35,997 | 1.800998 | 0.724641 | 49.83% | 0.989 | +0.00554 [-0.0075, +0.0185] |
| CURRENT | Current trans2 | 35,997 | 1.836123 | 0.733455 | 49.81% | 0.920 | +0.04067 [+0.0277, +0.0537] |
| CURRENT | Current gap | 35,997 | 1.802810 | 0.724947 | 49.83% | 0.986 | +0.00735 [-0.0056, +0.0203] |
| CURRENT | Current streak | 35,997 | 1.821672 | 0.729564 | 49.78% | 0.948 | +0.02621 [+0.0132, +0.0392] |
| NEW | Candidate HDM | 35,997 | 2.302914 | 0.900066 | 10.29% | -0.001 | +0.50746 [+0.4945, +0.5204] |
| NEW | Candidate discounted Dirichlet | 35,997 | 2.300530 | 0.899587 | 11.26% | 0.004 | +0.50507 [+0.4921, +0.5181] |
| NEW | Candidate CTW-3 | 35,997 | 1.801245 | 0.724643 | 49.83% | 0.989 | +0.00579 [-0.0072, +0.0188] |
| NEW | Candidate modular increment | 35,997 | 1.801226 | 0.724625 | 49.83% | 0.989 | +0.00577 [-0.0072, +0.0188] |
| NEW | Candidate lag tables | 35,997 | 2.096790 | 0.847541 | 44.35% | 0.406 | +0.30133 [+0.2883, +0.3143] |
| NEW | New softmax regression | 35,997 | 1.826105 | 0.732646 | 49.83% | 0.940 | +0.03065 [+0.0177, +0.0436] |
| NEW | New gapRamp (L=122) | 35,997 | 2.359185 | 0.911303 | 5.59% | -0.112 | +0.56373 [+0.5507, +0.5767] |
| NEW | New weighted mixture | 35,997 | 1.800300 | 0.725329 | 49.83% | 0.990 | +0.00484 [-0.0081, +0.0178] |
| ORACLE | True generator oracle | 35,997 | 1.795458 | 0.723719 | 49.83% | 1.000 | +0.00000 [+0.0000, +0.0000] |

Mean earned mixture weights in the scored window:

| Expert | Mean weight |  |  |  |  |  |
| --- | ---: | --- | --- | --- | --- | --- |
| Current Dirichlet | 0.00% |  |  |  |  |  |
| Current freqShort | 0.00% |  |  |  |  |  |
| Current freqLong | 0.00% |  |  |  |  |  |
| Current decayed | 0.00% |  |  |  |  |  |
| Candidate HDM | 0.00% |  |  |  |  |  |
| Candidate discounted Dirichlet | 0.00% |  |  |  |  |  |
| Current trans1 | 20.05% |  |  |  |  |  |
| Current trans2 | 0.00% |  |  |  |  |  |
| Candidate CTW-3 | 1.77% |  |  |  |  |  |
| Candidate modular increment | 18.16% |  |  |  |  |  |
| Candidate lag tables | 0.00% |  |  |  |  |  |
| New softmax regression | 0.02% |  |  |  |  |  |
| Current gap | 40.00% |  |  |  |  |  |
| New gapRamp (L=122) | 0.00% |  |  |  |  |  |
| Current streak | 20.00% |  |  |  |  |  |
| markov-dependence | 5 | exact | Current Dirichlet − True generator oracle: +0.00623 [-0.0336, +0.0461] | Current ensemble (final vector) − True generator oracle: +0.00356 [-0.0363, +0.0434] | Candidate modular increment − True generator oracle: -0.00032 [-0.0402, +0.0395] | Current Dirichlet − Candidate modular increment: +0.00655 [-0.0003, +0.0132] |

### markov-dependence — horizon 5 (exact)

The next digit depends strongly on the previous digit

| Group | Model | N | Log loss | Brier | Hit rate | Gain captured | LL(model−oracle), 95% block CI |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| BASELINE | Uniform baseline | 900 | 2.302585 | 0.900000 | 10.00% | 0.000 | +0.00274 [-0.0371, +0.0426] |
| CURRENT | Current ensemble (final vector) | 900 | 2.303401 | 0.900158 | 10.34% | -0.297 | +0.00356 [-0.0363, +0.0434] |
| CURRENT | Current Dirichlet | 900 | 2.306073 | 0.900674 | 8.83% | -1.272 | +0.00623 [-0.0336, +0.0461] |
| CURRENT | Current freqShort | 900 | 2.489610 | 0.935074 | 8.56% | -68.180 | +0.18977 [+0.1499, +0.2296] |
| CURRENT | Current freqLong | 900 | 2.320857 | 0.903640 | 10.02% | -6.661 | +0.02102 [-0.0188, +0.0609] |
| CURRENT | Current decayed | 900 | 2.320888 | 0.903711 | 9.44% | -6.672 | +0.02105 [-0.0188, +0.0609] |
| CURRENT | Current trans1 | 900 | 2.313204 | 0.902049 | 10.15% | -3.871 | +0.01336 [-0.0265, +0.0532] |
| CURRENT | Current trans2 | 900 | 2.349413 | 0.908348 | 10.59% | -17.071 | +0.04957 [+0.0097, +0.0894] |
| CURRENT | Current gap | 900 | 2.318143 | 0.902980 | 10.17% | -5.672 | +0.01830 [-0.0215, +0.0582] |
| CURRENT | Current streak | 900 | 2.329948 | 0.905269 | 10.25% | -9.975 | +0.03011 [-0.0097, +0.0700] |
| NEW | Candidate HDM | 900 | 2.306056 | 0.900675 | 8.89% | -1.265 | +0.00621 [-0.0336, +0.0461] |
| NEW | Candidate discounted Dirichlet | 900 | 2.312988 | 0.902029 | 9.00% | -3.792 | +0.01315 [-0.0267, +0.0530] |
| NEW | Candidate CTW-3 | 900 | 2.306105 | 0.900681 | 8.83% | -1.283 | +0.00626 [-0.0336, +0.0461] |
| NEW | Candidate modular increment | 900 | 2.299526 | 0.899356 | 12.44% | 1.115 | -0.00032 [-0.0402, +0.0395] |
| NEW | Candidate lag tables | 900 | 2.306585 | 0.900751 | 11.78% | -1.458 | +0.00674 [-0.0331, +0.0466] |
| NEW | New softmax regression | 900 | 2.381449 | 0.916703 | 11.11% | -28.750 | +0.08161 [+0.0418, +0.1215] |
| NEW | New gapRamp (L=122) | 900 | 2.314130 | 0.902462 | 9.11% | -4.209 | +0.01429 [-0.0256, +0.0541] |
| NEW | New weighted mixture | 900 | 2.304317 | 0.900347 | 10.00% | -0.631 | +0.00448 [-0.0354, +0.0443] |
| ORACLE | True generator oracle | 900 | 2.299842 | 0.899420 | 12.44% | 1.000 | +0.00000 [+0.0000, +0.0000] |

Mean earned mixture weights in the scored window:

| Expert | Mean weight |  |  |  |  |  |
| --- | ---: | --- | --- | --- | --- | --- |
| Current Dirichlet | 9.48% |  |  |  |  |  |
| Current freqShort | 0.00% |  |  |  |  |  |
| Current freqLong | 0.21% |  |  |  |  |  |
| Current decayed | 2.54% |  |  |  |  |  |
| Candidate HDM | 22.55% |  |  |  |  |  |
| Candidate discounted Dirichlet | 5.20% |  |  |  |  |  |
| Current trans1 | 0.20% |  |  |  |  |  |
| Current trans2 | 0.01% |  |  |  |  |  |
| Candidate CTW-3 | 3.06% |  |  |  |  |  |
| Candidate modular increment | 25.86% |  |  |  |  |  |
| Candidate lag tables | 10.79% |  |  |  |  |  |
| New softmax regression | 0.08% |  |  |  |  |  |
| Current gap | 3.63% |  |  |  |  |  |
| New gapRamp (L=122) | 16.33% |  |  |  |  |  |
| Current streak | 0.06% |  |  |  |  |  |
| markov-dependence | 10 | exact | Current Dirichlet − True generator oracle: +0.00028 [-0.0377, +0.0383] | Current ensemble (final vector) − True generator oracle: +0.00011 [-0.0379, +0.0381] | New weighted mixture − True generator oracle: -0.00026 [-0.0383, +0.0377] | Current Dirichlet − New weighted mixture: +0.00054 [-0.0018, +0.0031] |

### markov-dependence — horizon 10 (exact)

The next digit depends strongly on the previous digit

| Group | Model | N | Log loss | Brier | Hit rate | Gain captured | LL(model−oracle), 95% block CI |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| BASELINE | Uniform baseline | 900 | 2.302585 | 0.900000 | 10.00% | 0.000 | -0.00000 [-0.0380, +0.0380] |
| CURRENT | Current ensemble (final vector) | 900 | 2.302696 | 0.900030 | 10.07% | 29.075 | +0.00011 [-0.0379, +0.0381] |
| CURRENT | Current Dirichlet | 900 | 2.302865 | 0.900014 | 11.94% | 73.449 | +0.00028 [-0.0377, +0.0383] |
| CURRENT | Current freqShort | 900 | 2.492180 | 0.932781 | 10.36% | 49679.857 | +0.18959 [+0.1516, +0.2276] |
| CURRENT | Current freqLong | 900 | 2.308988 | 0.901370 | 9.83% | 1677.841 | +0.00640 [-0.0316, +0.0444] |
| CURRENT | Current decayed | 900 | 2.311649 | 0.902056 | 9.78% | 2375.124 | +0.00906 [-0.0289, +0.0471] |
| CURRENT | Current trans1 | 900 | 2.309403 | 0.901288 | 12.50% | 1786.527 | +0.00681 [-0.0312, +0.0448] |
| CURRENT | Current trans2 | 900 | 2.342533 | 0.907820 | 10.17% | 10467.695 | +0.03994 [+0.0019, +0.0779] |
| CURRENT | Current gap | 900 | 2.312044 | 0.901809 | 9.44% | 2478.498 | +0.00945 [-0.0285, +0.0475] |
| CURRENT | Current streak | 900 | 2.330049 | 0.905244 | 10.20% | 7196.406 | +0.02746 [-0.0105, +0.0655] |
| NEW | Candidate HDM | 900 | 2.303168 | 0.900074 | 11.78% | 152.867 | +0.00058 [-0.0374, +0.0386] |
| NEW | Candidate discounted Dirichlet | 900 | 2.303128 | 0.900159 | 10.33% | 142.193 | +0.00054 [-0.0375, +0.0385] |
| NEW | Candidate CTW-3 | 900 | 2.302871 | 0.900015 | 11.89% | 74.807 | +0.00028 [-0.0377, +0.0383] |
| NEW | Candidate modular increment | 900 | 2.302628 | 0.900009 | 9.89% | 11.170 | +0.00004 [-0.0380, +0.0380] |
| NEW | Candidate lag tables | 900 | 2.309115 | 0.901280 | 9.67% | 1710.986 | +0.00653 [-0.0315, +0.0445] |
| NEW | New softmax regression | 900 | 2.363846 | 0.913497 | 10.22% | 16052.371 | +0.06126 [+0.0233, +0.0993] |
| NEW | New gapRamp (L=122) | 900 | 2.307416 | 0.901108 | 9.11% | 1265.752 | +0.00483 [-0.0332, +0.0428] |
| NEW | New weighted mixture | 900 | 2.302329 | 0.899936 | 11.22% | -67.017 | -0.00026 [-0.0383, +0.0377] |
| ORACLE | True generator oracle | 900 | 2.302589 | 0.900001 | 9.89% | 1.000 | +0.00000 [+0.0000, +0.0000] |

Mean earned mixture weights in the scored window:

| Expert | Mean weight |  |  |  |  |  |
| --- | ---: | --- | --- | --- | --- | --- |
| Current Dirichlet | 10.46% |  |  |  |  |  |
| Current freqShort | 0.00% |  |  |  |  |  |
| Current freqLong | 0.56% |  |  |  |  |  |
| Current decayed | 2.99% |  |  |  |  |  |
| Candidate HDM | 19.53% |  |  |  |  |  |
| Candidate discounted Dirichlet | 6.16% |  |  |  |  |  |
| Current trans1 | 0.20% |  |  |  |  |  |
| Current trans2 | 0.01% |  |  |  |  |  |
| Candidate CTW-3 | 5.42% |  |  |  |  |  |
| Candidate modular increment | 27.41% |  |  |  |  |  |
| Candidate lag tables | 6.89% |  |  |  |  |  |
| New softmax regression | 0.07% |  |  |  |  |  |
| Current gap | 2.19% |  |  |  |  |  |
| New gapRamp (L=122) | 18.07% |  |  |  |  |  |
| Current streak | 0.04% |  |  |  |  |  |
| lag-memory | 1 | exact | Current gap − True generator oracle: +0.12519 [+0.1125, +0.1379] | Current ensemble (final vector) − True generator oracle: +0.17544 [+0.1627, +0.1882] | New softmax regression − True generator oracle: +0.02902 [+0.0163, +0.0417] | Current gap − New softmax regression: +0.09617 [+0.0898, +0.1024] |

### lag-memory — horizon 1 (exact)

A digit from four ticks earlier predicts the next digit

| Group | Model | N | Log loss | Brier | Hit rate | Gain captured | LL(model−oracle), 95% block CI |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| BASELINE | Uniform baseline | 35,997 | 2.302585 | 0.900000 | 10.00% | 0.000 | +0.50493 [+0.4922, +0.5177] |
| CURRENT | Current ensemble (final vector) | 35,997 | 1.973102 | 0.798484 | 42.92% | 0.653 | +0.17544 [+0.1627, +0.1882] |
| CURRENT | Current Dirichlet | 35,997 | 2.303554 | 0.900190 | 10.18% | -0.002 | +0.50590 [+0.4932, +0.5186] |
| CURRENT | Current freqShort | 35,997 | 2.333185 | 0.904981 | 13.93% | -0.061 | +0.53553 [+0.5228, +0.5483] |
| CURRENT | Current freqLong | 35,997 | 2.306449 | 0.900739 | 10.76% | -0.008 | +0.50879 [+0.4961, +0.5215] |
| CURRENT | Current decayed | 35,997 | 2.299086 | 0.899288 | 11.71% | 0.007 | +0.50143 [+0.4887, +0.5142] |
| CURRENT | Current trans1 | 35,997 | 2.307890 | 0.901029 | 10.63% | -0.011 | +0.51023 [+0.4975, +0.5230] |
| CURRENT | Current trans2 | 35,997 | 2.351755 | 0.908785 | 10.78% | -0.097 | +0.55410 [+0.5414, +0.5668] |
| CURRENT | Current gap | 35,997 | 1.922848 | 0.770419 | 42.47% | 0.752 | +0.12519 [+0.1125, +0.1379] |
| CURRENT | Current streak | 35,997 | 2.314025 | 0.902156 | 10.71% | -0.023 | +0.51637 [+0.5036, +0.5291] |
| NEW | Candidate HDM | 35,997 | 2.303613 | 0.900202 | 10.16% | -0.002 | +0.50595 [+0.4932, +0.5187] |
| NEW | Candidate discounted Dirichlet | 35,997 | 2.289629 | 0.897195 | 13.65% | 0.026 | +0.49197 [+0.4792, +0.5047] |
| NEW | Candidate CTW-3 | 35,997 | 2.303560 | 0.900191 | 10.19% | -0.002 | +0.50590 [+0.4932, +0.5186] |
| NEW | Candidate modular increment | 35,997 | 2.308532 | 0.901172 | 10.27% | -0.012 | +0.51087 [+0.4981, +0.5236] |
| NEW | Candidate lag tables | 35,997 | 2.138670 | 0.860969 | 49.53% | 0.325 | +0.34101 [+0.3283, +0.3537] |
| NEW | New softmax regression | 35,997 | 1.826679 | 0.732877 | 49.73% | 0.943 | +0.02902 [+0.0163, +0.0417] |
| NEW | New gapRamp (L=122) | 35,997 | 2.345185 | 0.908804 | 5.59% | -0.084 | +0.54753 [+0.5348, +0.5603] |
| NEW | New weighted mixture | 35,997 | 1.862662 | 0.754771 | 49.73% | 0.871 | +0.06500 [+0.0523, +0.0777] |
| ORACLE | True generator oracle | 35,997 | 1.797658 | 0.724610 | 49.73% | 1.000 | +0.00000 [+0.0000, +0.0000] |

Mean earned mixture weights in the scored window:

| Expert | Mean weight |  |  |  |  |  |
| --- | ---: | --- | --- | --- | --- | --- |
| Current Dirichlet | 1.07% |  |  |  |  |  |
| Current freqShort | 0.13% |  |  |  |  |  |
| Current freqLong | 0.20% |  |  |  |  |  |
| Current decayed | 2.47% |  |  |  |  |  |
| Candidate HDM | 1.42% |  |  |  |  |  |
| Candidate discounted Dirichlet | 14.62% |  |  |  |  |  |
| Current trans1 | 0.00% |  |  |  |  |  |
| Current trans2 | 0.00% |  |  |  |  |  |
| Candidate CTW-3 | 0.00% |  |  |  |  |  |
| Candidate modular increment | 0.00% |  |  |  |  |  |
| Candidate lag tables | 0.00% |  |  |  |  |  |
| New softmax regression | 40.00% |  |  |  |  |  |
| Current gap | 40.00% |  |  |  |  |  |
| New gapRamp (L=122) | 0.00% |  |  |  |  |  |
| Current streak | 0.08% |  |  |  |  |  |
| lag-memory | 5 | exact | Current gap − True generator oracle: +0.02562 [-0.0344, +0.0856] | Current ensemble (final vector) − True generator oracle: +0.03201 [-0.0280, +0.0920] | New weighted mixture − True generator oracle: +0.01488 [-0.0451, +0.0749] | Current gap − New weighted mixture: +0.01074 [+0.0007, +0.0217] |

### lag-memory — horizon 5 (exact)

A digit from four ticks earlier predicts the next digit

| Group | Model | N | Log loss | Brier | Hit rate | Gain captured | LL(model−oracle), 95% block CI |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| BASELINE | Uniform baseline | 900 | 2.302585 | 0.900000 | 10.00% | 0.000 | +0.11518 [+0.0552, +0.1752] |
| CURRENT | Current ensemble (final vector) | 900 | 2.219424 | 0.877998 | 24.56% | 0.722 | +0.03201 [-0.0280, +0.0920] |
| CURRENT | Current Dirichlet | 900 | 2.304457 | 0.900384 | 9.44% | -0.016 | +0.11705 [+0.0570, +0.1771] |
| CURRENT | Current freqShort | 900 | 2.382304 | 0.913923 | 12.38% | -0.692 | +0.19489 [+0.1349, +0.2549] |
| CURRENT | Current freqLong | 900 | 2.308158 | 0.901097 | 12.11% | -0.048 | +0.12075 [+0.0607, +0.1808] |
| CURRENT | Current decayed | 900 | 2.304139 | 0.900252 | 12.78% | -0.013 | +0.11673 [+0.0567, +0.1767] |
| CURRENT | Current trans1 | 900 | 2.302341 | 0.899890 | 12.39% | 0.002 | +0.11493 [+0.0549, +0.1749] |
| CURRENT | Current trans2 | 900 | 2.355674 | 0.909753 | 10.00% | -0.461 | +0.16827 [+0.1082, +0.2283] |
| CURRENT | Current gap | 900 | 2.213028 | 0.873433 | 24.56% | 0.778 | +0.02562 [-0.0344, +0.0856] |
| CURRENT | Current streak | 900 | 2.312872 | 0.902208 | 10.64% | -0.089 | +0.12546 [+0.0654, +0.1855] |
| NEW | Candidate HDM | 900 | 2.304391 | 0.900369 | 9.89% | -0.016 | +0.11698 [+0.0570, +0.1770] |
| NEW | Candidate discounted Dirichlet | 900 | 2.303496 | 0.900169 | 11.44% | -0.008 | +0.11609 [+0.0561, +0.1761] |
| NEW | Candidate CTW-3 | 900 | 2.304407 | 0.900375 | 9.61% | -0.016 | +0.11700 [+0.0570, +0.1770] |
| NEW | Candidate modular increment | 900 | 2.302585 | 0.900000 | 11.22% | -0.000 | +0.11518 [+0.0552, +0.1752] |
| NEW | Candidate lag tables | 900 | 2.263690 | 0.891423 | 24.78% | 0.338 | +0.07628 [+0.0163, +0.1363] |
| NEW | New softmax regression | 900 | 2.223101 | 0.876813 | 26.33% | 0.690 | +0.03569 [-0.0243, +0.0957] |
| NEW | New gapRamp (L=122) | 900 | 2.327515 | 0.905230 | 7.67% | -0.216 | +0.14011 [+0.0801, +0.2001] |
| NEW | New weighted mixture | 900 | 2.202291 | 0.872684 | 26.67% | 0.871 | +0.01488 [-0.0451, +0.0749] |
| ORACLE | True generator oracle | 900 | 2.187409 | 0.867967 | 27.00% | 1.000 | +0.00000 [+0.0000, +0.0000] |

Mean earned mixture weights in the scored window:

| Expert | Mean weight |  |  |  |  |  |
| --- | ---: | --- | --- | --- | --- | --- |
| Current Dirichlet | 4.57% |  |  |  |  |  |
| Current freqShort | 0.00% |  |  |  |  |  |
| Current freqLong | 0.32% |  |  |  |  |  |
| Current decayed | 3.19% |  |  |  |  |  |
| Candidate HDM | 7.74% |  |  |  |  |  |
| Candidate discounted Dirichlet | 4.13% |  |  |  |  |  |
| Current trans1 | 0.00% |  |  |  |  |  |
| Current trans2 | 0.00% |  |  |  |  |  |
| Candidate CTW-3 | 0.01% |  |  |  |  |  |
| Candidate modular increment | 0.11% |  |  |  |  |  |
| Candidate lag tables | 0.49% |  |  |  |  |  |
| New softmax regression | 39.38% |  |  |  |  |  |
| Current gap | 39.98% |  |  |  |  |  |
| New gapRamp (L=122) | 0.02% |  |  |  |  |  |
| Current streak | 0.05% |  |  |  |  |  |
| lag-memory | 10 | exact | Current gap − True generator oracle: +0.01095 [-0.0302, +0.0521] | Current ensemble (final vector) − True generator oracle: +0.01546 [-0.0257, +0.0566] | New weighted mixture − True generator oracle: +0.01576 [-0.0254, +0.0569] | Current gap − New weighted mixture: -0.00481 [-0.0228, +0.0115] |

### lag-memory — horizon 10 (exact)

A digit from four ticks earlier predicts the next digit

| Group | Model | N | Log loss | Brier | Hit rate | Gain captured | LL(model−oracle), 95% block CI |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| BASELINE | Uniform baseline | 900 | 2.302585 | 0.900000 | 10.00% | 0.000 | +0.02646 [-0.0147, +0.0676] |
| CURRENT | Current ensemble (final vector) | 900 | 2.291583 | 0.897509 | 15.07% | 0.416 | +0.01546 [-0.0257, +0.0566] |
| CURRENT | Current Dirichlet | 900 | 2.305271 | 0.900544 | 10.00% | -0.102 | +0.02914 [-0.0120, +0.0703] |
| CURRENT | Current freqShort | 900 | 2.474465 | 0.928707 | 10.50% | -6.496 | +0.19834 [+0.1572, +0.2395] |
| CURRENT | Current freqLong | 900 | 2.316402 | 0.902748 | 9.67% | -0.522 | +0.04027 [-0.0008, +0.0814] |
| CURRENT | Current decayed | 900 | 2.316044 | 0.902685 | 9.44% | -0.509 | +0.03992 [-0.0012, +0.0810] |
| CURRENT | Current trans1 | 900 | 2.314155 | 0.902290 | 8.98% | -0.437 | +0.03803 [-0.0031, +0.0791] |
| CURRENT | Current trans2 | 900 | 2.375383 | 0.913794 | 10.07% | -2.751 | +0.09926 [+0.0581, +0.1404] |
| CURRENT | Current gap | 900 | 2.287077 | 0.895974 | 16.11% | 0.586 | +0.01095 [-0.0302, +0.0521] |
| CURRENT | Current streak | 900 | 2.316583 | 0.902921 | 10.15% | -0.529 | +0.04046 [-0.0007, +0.0816] |
| NEW | Candidate HDM | 900 | 2.305007 | 0.900489 | 10.33% | -0.092 | +0.02888 [-0.0122, +0.0700] |
| NEW | Candidate discounted Dirichlet | 900 | 2.310851 | 0.901705 | 9.11% | -0.312 | +0.03472 [-0.0064, +0.0758] |
| NEW | Candidate CTW-3 | 900 | 2.305344 | 0.900559 | 10.11% | -0.104 | +0.02922 [-0.0119, +0.0703] |
| NEW | Candidate modular increment | 900 | 2.302585 | 0.900000 | 10.50% | 0.000 | +0.02646 [-0.0147, +0.0676] |
| NEW | Candidate lag tables | 900 | 2.299476 | 0.899254 | 14.78% | 0.117 | +0.02335 [-0.0178, +0.0645] |
| NEW | New softmax regression | 900 | 2.328110 | 0.904643 | 13.33% | -0.965 | +0.05198 [+0.0109, +0.0931] |
| NEW | New gapRamp (L=122) | 900 | 2.314739 | 0.902500 | 10.33% | -0.459 | +0.03861 [-0.0025, +0.0797] |
| NEW | New weighted mixture | 900 | 2.291883 | 0.897585 | 15.56% | 0.405 | +0.01576 [-0.0254, +0.0569] |
| ORACLE | True generator oracle | 900 | 2.276128 | 0.893674 | 17.56% | 1.000 | +0.00000 [+0.0000, +0.0000] |

Mean earned mixture weights in the scored window:

| Expert | Mean weight |  |  |  |  |  |
| --- | ---: | --- | --- | --- | --- | --- |
| Current Dirichlet | 6.72% |  |  |  |  |  |
| Current freqShort | 0.00% |  |  |  |  |  |
| Current freqLong | 0.30% |  |  |  |  |  |
| Current decayed | 3.22% |  |  |  |  |  |
| Candidate HDM | 12.70% |  |  |  |  |  |
| Candidate discounted Dirichlet | 5.02% |  |  |  |  |  |
| Current trans1 | 0.12% |  |  |  |  |  |
| Current trans2 | 0.00% |  |  |  |  |  |
| Candidate CTW-3 | 1.43% |  |  |  |  |  |
| Candidate modular increment | 14.27% |  |  |  |  |  |
| Candidate lag tables | 23.54% |  |  |  |  |  |
| New softmax regression | 0.61% |  |  |  |  |  |
| Current gap | 28.69% |  |  |  |  |  |
| New gapRamp (L=122) | 3.31% |  |  |  |  |  |
| Current streak | 0.08% |  |  |  |  |  |
| due-gap | 1 | exact | Current gap − True generator oracle: +0.23860 [+0.2246, +0.2526] | Current ensemble (final vector) − True generator oracle: +0.31538 [+0.3014, +0.3294] | New weighted mixture − True generator oracle: +0.39118 [+0.3772, +0.4052] | Current gap − New weighted mixture: -0.15257 [-0.1584, -0.1472] |

### due-gap — horizon 1 (exact)

The longest-absent digit becomes more likely after a threshold

| Group | Model | N | Log loss | Brier | Hit rate | Gain captured | LL(model−oracle), 95% block CI |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| BASELINE | Uniform baseline | 35,997 | 2.302585 | 0.900000 | 10.00% | 0.000 | +0.68682 [+0.6728, +0.7008] |
| CURRENT | Current ensemble (final vector) | 35,997 | 1.931146 | 0.797462 | 53.65% | 0.541 | +0.31538 [+0.3014, +0.3294] |
| CURRENT | Current Dirichlet | 35,997 | 2.303219 | 0.900127 | 9.52% | -0.001 | +0.68746 [+0.6734, +0.7015] |
| CURRENT | Current freqShort | 35,997 | 2.380682 | 0.915012 | 6.62% | -0.114 | +0.76492 [+0.7509, +0.7789] |
| CURRENT | Current freqLong | 35,997 | 2.307134 | 0.900908 | 8.70% | -0.007 | +0.69137 [+0.6773, +0.7054] |
| CURRENT | Current decayed | 35,997 | 2.311576 | 0.901791 | 7.67% | -0.013 | +0.69581 [+0.6818, +0.7098] |
| CURRENT | Current trans1 | 35,997 | 2.289550 | 0.898031 | 10.88% | 0.019 | +0.67379 [+0.6598, +0.6878] |
| CURRENT | Current trans2 | 35,997 | 2.313057 | 0.902466 | 11.79% | -0.015 | +0.69729 [+0.6833, +0.7113] |
| CURRENT | Current gap | 35,997 | 1.854368 | 0.761065 | 53.72% | 0.653 | +0.23860 [+0.2246, +0.2526] |
| CURRENT | Current streak | 35,997 | 2.293261 | 0.898715 | 10.78% | 0.014 | +0.67750 [+0.6635, +0.6915] |
| NEW | Candidate HDM | 35,997 | 2.303182 | 0.900119 | 9.48% | -0.001 | +0.68742 [+0.6734, +0.7014] |
| NEW | Candidate discounted Dirichlet | 35,997 | 2.306565 | 0.900795 | 8.12% | -0.006 | +0.69080 [+0.6768, +0.7048] |
| NEW | Candidate CTW-3 | 35,997 | 2.301669 | 0.899882 | 9.55% | 0.001 | +0.68590 [+0.6719, +0.6999] |
| NEW | Candidate modular increment | 35,997 | 2.270006 | 0.894713 | 11.14% | 0.047 | +0.65424 [+0.6402, +0.6683] |
| NEW | Candidate lag tables | 35,997 | 2.264561 | 0.892505 | 14.86% | 0.055 | +0.64880 [+0.6348, +0.6628] |
| NEW | New softmax regression | 35,997 | 2.240767 | 0.888993 | 14.45% | 0.090 | +0.62500 [+0.6110, +0.6390] |
| NEW | New gapRamp (L=122) | 35,997 | 2.276532 | 0.894700 | 57.50% | 0.038 | +0.66077 [+0.6467, +0.6748] |
| NEW | New weighted mixture | 35,997 | 2.006941 | 0.823836 | 50.85% | 0.430 | +0.39118 [+0.3772, +0.4052] |
| ORACLE | True generator oracle | 35,997 | 1.615764 | 0.649343 | 57.50% | 1.000 | +0.00000 [+0.0000, +0.0000] |

Mean earned mixture weights in the scored window:

| Expert | Mean weight |  |  |  |  |  |
| --- | ---: | --- | --- | --- | --- | --- |
| Current Dirichlet | 3.63% |  |  |  |  |  |
| Current freqShort | 0.00% |  |  |  |  |  |
| Current freqLong | 1.06% |  |  |  |  |  |
| Current decayed | 1.21% |  |  |  |  |  |
| Candidate HDM | 5.34% |  |  |  |  |  |
| Candidate discounted Dirichlet | 2.19% |  |  |  |  |  |
| Current trans1 | 0.29% |  |  |  |  |  |
| Current trans2 | 0.03% |  |  |  |  |  |
| Candidate CTW-3 | 0.23% |  |  |  |  |  |
| Candidate modular increment | 0.89% |  |  |  |  |  |
| Candidate lag tables | 3.86% |  |  |  |  |  |
| New softmax regression | 34.71% |  |  |  |  |  |
| Current gap | 40.00% |  |  |  |  |  |
| New gapRamp (L=122) | 0.00% |  |  |  |  |  |
| Current streak | 6.57% |  |  |  |  |  |
| due-gap | 5 | estimated; 5000 Monte Carlo paths | Current gap − True generator oracle: +0.06758 [+0.0205, +0.1147] | Current ensemble (final vector) − True generator oracle: +0.09139 [+0.0443, +0.1385] | New weighted mixture − True generator oracle: +0.10910 [+0.0620, +0.1562] | Current gap − New weighted mixture: -0.04152 [-0.0581, -0.0226] |

### due-gap — horizon 5 (estimated; 5000 Monte Carlo paths)

The longest-absent digit becomes more likely after a threshold

| Group | Model | N | Log loss | Brier | Hit rate | Gain captured | LL(model−oracle), 95% block CI |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| BASELINE | Uniform baseline | 900 | 2.302585 | 0.900000 | 10.00% | 0.000 | +0.22656 [+0.1794, +0.2737] |
| CURRENT | Current ensemble (final vector) | 900 | 2.167414 | 0.871960 | 19.11% | 0.597 | +0.09139 [+0.0443, +0.1385] |
| CURRENT | Current Dirichlet | 900 | 2.303914 | 0.900266 | 8.98% | -0.006 | +0.22789 [+0.1808, +0.2750] |
| CURRENT | Current freqShort | 900 | 2.340732 | 0.908007 | 7.56% | -0.168 | +0.26470 [+0.2176, +0.3118] |
| CURRENT | Current freqLong | 900 | 2.307746 | 0.901028 | 9.65% | -0.023 | +0.23172 [+0.1846, +0.2788] |
| CURRENT | Current decayed | 900 | 2.309418 | 0.901370 | 8.78% | -0.030 | +0.23339 [+0.1863, +0.2805] |
| CURRENT | Current trans1 | 900 | 2.286173 | 0.897813 | 10.17% | 0.072 | +0.21015 [+0.1630, +0.2573] |
| CURRENT | Current trans2 | 900 | 2.282120 | 0.898496 | 10.01% | 0.090 | +0.20609 [+0.1590, +0.2532] |
| CURRENT | Current gap | 900 | 2.143612 | 0.866439 | 19.33% | 0.702 | +0.06758 [+0.0205, +0.1147] |
| CURRENT | Current streak | 900 | 2.282853 | 0.897590 | 10.39% | 0.087 | +0.20683 [+0.1597, +0.2539] |
| NEW | Candidate HDM | 900 | 2.303991 | 0.900281 | 9.44% | -0.006 | +0.22796 [+0.1809, +0.2751] |
| NEW | Candidate discounted Dirichlet | 900 | 2.306585 | 0.900800 | 8.67% | -0.018 | +0.23056 [+0.1834, +0.2777] |
| NEW | Candidate CTW-3 | 900 | 2.301351 | 0.899870 | 8.81% | 0.005 | +0.22532 [+0.1782, +0.2724] |
| NEW | Candidate modular increment | 900 | 2.302008 | 0.899885 | 11.78% | 0.003 | +0.22598 [+0.1789, +0.2731] |
| NEW | Candidate lag tables | 900 | 2.265857 | 0.892746 | 14.78% | 0.162 | +0.18983 [+0.1427, +0.2369] |
| NEW | New softmax regression | 900 | 2.247788 | 0.890376 | 13.67% | 0.242 | +0.17176 [+0.1247, +0.2189] |
| NEW | New gapRamp (L=122) | 900 | 2.292154 | 0.897936 | 6.22% | 0.046 | +0.21613 [+0.1690, +0.2632] |
| NEW | New weighted mixture | 900 | 2.185131 | 0.876113 | 18.56% | 0.518 | +0.10910 [+0.0620, +0.1562] |
| ORACLE | True generator oracle | 900 | 2.076027 | 0.849426 | 23.33% | 1.000 | +0.00000 [+0.0000, +0.0000] |

Mean earned mixture weights in the scored window:

| Expert | Mean weight |  |  |  |  |  |
| --- | ---: | --- | --- | --- | --- | --- |
| Current Dirichlet | 3.68% |  |  |  |  |  |
| Current freqShort | 0.05% |  |  |  |  |  |
| Current freqLong | 1.65% |  |  |  |  |  |
| Current decayed | 2.13% |  |  |  |  |  |
| Candidate HDM | 4.58% |  |  |  |  |  |
| Candidate discounted Dirichlet | 2.86% |  |  |  |  |  |
| Current trans1 | 0.28% |  |  |  |  |  |
| Current trans2 | 0.01% |  |  |  |  |  |
| Candidate CTW-3 | 0.32% |  |  |  |  |  |
| Candidate modular increment | 0.70% |  |  |  |  |  |
| Candidate lag tables | 5.47% |  |  |  |  |  |
| New softmax regression | 33.22% |  |  |  |  |  |
| Current gap | 40.00% |  |  |  |  |  |
| New gapRamp (L=122) | 0.00% |  |  |  |  |  |
| Current streak | 5.06% |  |  |  |  |  |
| due-gap | 10 | estimated; 5000 Monte Carlo paths | Current gap − True generator oracle: +0.01325 [-0.0327, +0.0592] | Current ensemble (final vector) − True generator oracle: +0.01257 [-0.0334, +0.0585] | New weighted mixture − True generator oracle: +0.01685 [-0.0291, +0.0628] | Current gap − New weighted mixture: -0.00360 [-0.0160, +0.0092] |

### due-gap — horizon 10 (estimated; 5000 Monte Carlo paths)

The longest-absent digit becomes more likely after a threshold

| Group | Model | N | Log loss | Brier | Hit rate | Gain captured | LL(model−oracle), 95% block CI |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| BASELINE | Uniform baseline | 900 | 2.302585 | 0.900000 | 10.00% | 0.000 | +0.06190 [+0.0160, +0.1078] |
| CURRENT | Current ensemble (final vector) | 900 | 2.253252 | 0.890164 | 15.78% | 0.797 | +0.01257 [-0.0334, +0.0585] |
| CURRENT | Current Dirichlet | 900 | 2.302190 | 0.899921 | 9.17% | 0.006 | +0.06151 [+0.0156, +0.1074] |
| CURRENT | Current freqShort | 900 | 2.297811 | 0.898892 | 12.44% | 0.077 | +0.05713 [+0.0112, +0.1031] |
| CURRENT | Current freqLong | 900 | 2.303804 | 0.900251 | 9.25% | -0.020 | +0.06312 [+0.0172, +0.1091] |
| CURRENT | Current decayed | 900 | 2.300703 | 0.899630 | 10.33% | 0.030 | +0.06002 [+0.0141, +0.1059] |
| CURRENT | Current trans1 | 900 | 2.304412 | 0.900371 | 10.59% | -0.030 | +0.06373 [+0.0178, +0.1097] |
| CURRENT | Current trans2 | 900 | 2.343532 | 0.907426 | 11.37% | -0.661 | +0.10285 [+0.0569, +0.1488] |
| CURRENT | Current gap | 900 | 2.253930 | 0.890317 | 15.33% | 0.786 | +0.01325 [-0.0327, +0.0592] |
| CURRENT | Current streak | 900 | 2.309495 | 0.901160 | 10.73% | -0.112 | +0.06881 [+0.0229, +0.1147] |
| NEW | Candidate HDM | 900 | 2.302210 | 0.899925 | 8.94% | 0.006 | +0.06153 [+0.0156, +0.1075] |
| NEW | Candidate discounted Dirichlet | 900 | 2.294730 | 0.898444 | 11.78% | 0.127 | +0.05405 [+0.0081, +0.1000] |
| NEW | Candidate CTW-3 | 900 | 2.302177 | 0.899918 | 8.89% | 0.007 | +0.06150 [+0.0156, +0.1074] |
| NEW | Candidate modular increment | 900 | 2.302585 | 0.900000 | 12.67% | 0.000 | +0.06190 [+0.0160, +0.1078] |
| NEW | Candidate lag tables | 900 | 2.289072 | 0.897191 | 14.33% | 0.218 | +0.04839 [+0.0025, +0.0943] |
| NEW | New softmax regression | 900 | 2.292541 | 0.897834 | 13.78% | 0.162 | +0.05186 [+0.0059, +0.0978] |
| NEW | New gapRamp (L=122) | 900 | 2.311968 | 0.901889 | 5.00% | -0.152 | +0.07129 [+0.0254, +0.1172] |
| NEW | New weighted mixture | 900 | 2.257526 | 0.890728 | 14.33% | 0.728 | +0.01685 [-0.0291, +0.0628] |
| ORACLE | True generator oracle | 900 | 2.240681 | 0.888204 | 14.00% | 1.000 | +0.00000 [+0.0000, +0.0000] |

Mean earned mixture weights in the scored window:

| Expert | Mean weight |  |  |  |  |  |
| --- | ---: | --- | --- | --- | --- | --- |
| Current Dirichlet | 2.47% |  |  |  |  |  |
| Current freqShort | 4.87% |  |  |  |  |  |
| Current freqLong | 2.49% |  |  |  |  |  |
| Current decayed | 3.13% |  |  |  |  |  |
| Candidate HDM | 2.46% |  |  |  |  |  |
| Candidate discounted Dirichlet | 7.15% |  |  |  |  |  |
| Current trans1 | 0.15% |  |  |  |  |  |
| Current trans2 | 0.00% |  |  |  |  |  |
| Candidate CTW-3 | 0.89% |  |  |  |  |  |
| Candidate modular increment | 1.75% |  |  |  |  |  |
| Candidate lag tables | 7.61% |  |  |  |  |  |
| New softmax regression | 26.92% |  |  |  |  |  |
| Current gap | 39.92% |  |  |  |  |  |
| New gapRamp (L=122) | 0.08% |  |  |  |  |  |
| Current streak | 0.11% |  |  |  |  |  |
| streak-persistence | 1 | exact | Current streak − True generator oracle: +0.01788 [+0.0114, +0.0244] | Current ensemble (final vector) − True generator oracle: +0.01657 [+0.0100, +0.0231] | Candidate modular increment − True generator oracle: +0.00569 [-0.0008, +0.0122] | Current streak − Candidate modular increment: +0.01219 [+0.0097, +0.0146] |

### streak-persistence — horizon 1 (exact)

A current digit run is likely to continue

| Group | Model | N | Log loss | Brier | Hit rate | Gain captured | LL(model−oracle), 95% block CI |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| BASELINE | Uniform baseline | 35,997 | 2.302585 | 0.900000 | 10.00% | 0.000 | +0.05759 [+0.0511, +0.0641] |
| CURRENT | Current ensemble (final vector) | 35,997 | 2.261564 | 0.886829 | 14.99% | 0.712 | +0.01657 [+0.0100, +0.0231] |
| CURRENT | Current Dirichlet | 35,997 | 2.303035 | 0.900090 | 10.15% | -0.008 | +0.05804 [+0.0515, +0.0646] |
| CURRENT | Current freqShort | 35,997 | 2.365605 | 0.911327 | 11.32% | -1.094 | +0.12061 [+0.1141, +0.1271] |
| CURRENT | Current freqLong | 35,997 | 2.306493 | 0.900777 | 10.38% | -0.068 | +0.06150 [+0.0550, +0.0680] |
| CURRENT | Current decayed | 35,997 | 2.305812 | 0.900633 | 10.75% | -0.056 | +0.06081 [+0.0543, +0.0673] |
| CURRENT | Current trans1 | 35,997 | 2.296261 | 0.898418 | 14.78% | 0.110 | +0.05126 [+0.0447, +0.0578] |
| CURRENT | Current trans2 | 35,997 | 2.292538 | 0.889452 | 15.13% | 0.174 | +0.04754 [+0.0410, +0.0541] |
| CURRENT | Current gap | 35,997 | 2.298514 | 0.898794 | 14.71% | 0.071 | +0.05352 [+0.0470, +0.0600] |
| CURRENT | Current streak | 35,997 | 2.262875 | 0.885121 | 14.87% | 0.690 | +0.01788 [+0.0114, +0.0244] |
| NEW | Candidate HDM | 35,997 | 2.303130 | 0.900109 | 10.02% | -0.009 | +0.05813 [+0.0516, +0.0647] |
| NEW | Candidate discounted Dirichlet | 35,997 | 2.303891 | 0.900258 | 10.62% | -0.023 | +0.05889 [+0.0524, +0.0654] |
| NEW | Candidate CTW-3 | 35,997 | 2.303036 | 0.900090 | 10.14% | -0.008 | +0.05804 [+0.0515, +0.0646] |
| NEW | Candidate modular increment | 35,997 | 2.250689 | 0.881931 | 15.19% | 0.901 | +0.00569 [-0.0008, +0.0122] |
| NEW | Candidate lag tables | 35,997 | 2.295478 | 0.898409 | 14.59% | 0.123 | +0.05048 [+0.0440, +0.0570] |
| NEW | New softmax regression | 35,997 | 2.308695 | 0.898516 | 14.37% | -0.106 | +0.06370 [+0.0572, +0.0702] |
| NEW | New gapRamp (L=122) | 35,997 | 2.309110 | 0.901328 | 9.53% | -0.113 | +0.06411 [+0.0576, +0.0706] |
| NEW | New weighted mixture | 35,997 | 2.253871 | 0.884380 | 15.08% | 0.846 | +0.00887 [+0.0023, +0.0154] |
| ORACLE | True generator oracle | 35,997 | 2.244998 | 0.880845 | 15.07% | 1.000 | +0.00000 [+0.0000, +0.0000] |

Mean earned mixture weights in the scored window:

| Expert | Mean weight |  |  |  |  |  |
| --- | ---: | --- | --- | --- | --- | --- |
| Current Dirichlet | 4.61% |  |  |  |  |  |
| Current freqShort | 0.02% |  |  |  |  |  |
| Current freqLong | 1.44% |  |  |  |  |  |
| Current decayed | 3.52% |  |  |  |  |  |
| Candidate HDM | 6.47% |  |  |  |  |  |
| Candidate discounted Dirichlet | 4.10% |  |  |  |  |  |
| Current trans1 | 0.24% |  |  |  |  |  |
| Current trans2 | 0.05% |  |  |  |  |  |
| Candidate CTW-3 | 0.56% |  |  |  |  |  |
| Candidate modular increment | 36.96% |  |  |  |  |  |
| Candidate lag tables | 1.46% |  |  |  |  |  |
| New softmax regression | 0.74% |  |  |  |  |  |
| Current gap | 3.69% |  |  |  |  |  |
| New gapRamp (L=122) | 2.68% |  |  |  |  |  |
| Current streak | 33.47% |  |  |  |  |  |
| streak-persistence | 5 | exact | Current Dirichlet − True generator oracle: -0.00090 [-0.0301, +0.0283] | Current ensemble (final vector) − True generator oracle: -0.00021 [-0.0294, +0.0290] | Candidate HDM − True generator oracle: -0.00090 [-0.0301, +0.0283] | Current Dirichlet − Candidate HDM: -0.00001 [-0.0003, +0.0003] |

### streak-persistence — horizon 5 (exact)

A current digit run is likely to continue

| Group | Model | N | Log loss | Brier | Hit rate | Gain captured | LL(model−oracle), 95% block CI |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| BASELINE | Uniform baseline | 900 | 2.302585 | 0.900000 | 10.00% | 0.000 | -0.00006 [-0.0292, +0.0291] |
| CURRENT | Current ensemble (final vector) | 900 | 2.302431 | 0.899969 | 10.97% | -2.529 | -0.00021 [-0.0294, +0.0290] |
| CURRENT | Current Dirichlet | 900 | 2.301744 | 0.899821 | 10.72% | -13.850 | -0.00090 [-0.0301, +0.0283] |
| CURRENT | Current freqShort | 900 | 2.371886 | 0.913475 | 10.41% | 1140.721 | +0.06924 [+0.0401, +0.0984] |
| CURRENT | Current freqLong | 900 | 2.304724 | 0.900439 | 10.28% | 35.211 | +0.00208 [-0.0271, +0.0312] |
| CURRENT | Current decayed | 900 | 2.304690 | 0.900454 | 9.00% | 34.642 | +0.00204 [-0.0271, +0.0312] |
| CURRENT | Current trans1 | 900 | 2.309842 | 0.901506 | 8.94% | 119.459 | +0.00720 [-0.0220, +0.0364] |
| CURRENT | Current trans2 | 900 | 2.356798 | 0.909289 | 11.54% | 892.373 | +0.05415 [+0.0250, +0.0833] |
| CURRENT | Current gap | 900 | 2.314158 | 0.902241 | 10.33% | 190.490 | +0.01151 [-0.0177, +0.0407] |
| CURRENT | Current streak | 900 | 2.311970 | 0.901790 | 10.16% | 154.476 | +0.00932 [-0.0198, +0.0385] |
| NEW | Candidate HDM | 900 | 2.301750 | 0.899824 | 10.78% | -13.738 | -0.00090 [-0.0301, +0.0283] |
| NEW | Candidate discounted Dirichlet | 900 | 2.302714 | 0.900025 | 10.67% | 2.126 | +0.00007 [-0.0291, +0.0292] |
| NEW | Candidate CTW-3 | 900 | 2.301766 | 0.899825 | 10.72% | -13.479 | -0.00088 [-0.0301, +0.0283] |
| NEW | Candidate modular increment | 900 | 2.302800 | 0.900046 | 10.22% | 3.538 | +0.00015 [-0.0290, +0.0293] |
| NEW | Candidate lag tables | 900 | 2.302015 | 0.899866 | 11.33% | -9.388 | -0.00063 [-0.0298, +0.0285] |
| NEW | New softmax regression | 900 | 2.339347 | 0.907769 | 10.33% | 605.108 | +0.03670 [+0.0075, +0.0659] |
| NEW | New gapRamp (L=122) | 900 | 2.308760 | 0.901309 | 9.44% | 101.635 | +0.00611 [-0.0231, +0.0353] |
| NEW | New weighted mixture | 900 | 2.302582 | 0.899994 | 10.44% | -0.056 | -0.00006 [-0.0292, +0.0291] |
| ORACLE | True generator oracle | 900 | 2.302646 | 0.900014 | 10.22% | 1.000 | +0.00000 [+0.0000, +0.0000] |

Mean earned mixture weights in the scored window:

| Expert | Mean weight |  |  |  |  |  |
| --- | ---: | --- | --- | --- | --- | --- |
| Current Dirichlet | 10.33% |  |  |  |  |  |
| Current freqShort | 0.01% |  |  |  |  |  |
| Current freqLong | 1.46% |  |  |  |  |  |
| Current decayed | 4.67% |  |  |  |  |  |
| Candidate HDM | 16.42% |  |  |  |  |  |
| Candidate discounted Dirichlet | 7.10% |  |  |  |  |  |
| Current trans1 | 0.68% |  |  |  |  |  |
| Current trans2 | 0.00% |  |  |  |  |  |
| Candidate CTW-3 | 6.92% |  |  |  |  |  |
| Candidate modular increment | 18.76% |  |  |  |  |  |
| Candidate lag tables | 13.17% |  |  |  |  |  |
| New softmax regression | 0.44% |  |  |  |  |  |
| Current gap | 1.46% |  |  |  |  |  |
| New gapRamp (L=122) | 18.36% |  |  |  |  |  |
| Current streak | 0.21% |  |  |  |  |  |
| streak-persistence | 10 | exact | Current Dirichlet − True generator oracle: -0.00229 [-0.0306, +0.0260] | Current ensemble (final vector) − True generator oracle: -0.00016 [-0.0284, +0.0281] | Candidate HDM − True generator oracle: -0.00235 [-0.0306, +0.0259] | Current Dirichlet − Candidate HDM: +0.00006 [-0.0003, +0.0004] |

### streak-persistence — horizon 10 (exact)

A current digit run is likely to continue

| Group | Model | N | Log loss | Brier | Hit rate | Gain captured | LL(model−oracle), 95% block CI |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| BASELINE | Uniform baseline | 900 | 2.302585 | 0.900000 | 10.00% | 0.000 | +0.00001 [-0.0283, +0.0283] |
| CURRENT | Current ensemble (final vector) | 900 | 2.302416 | 0.899967 | 10.21% | 13.679 | -0.00016 [-0.0284, +0.0281] |
| CURRENT | Current Dirichlet | 900 | 2.300283 | 0.899552 | 9.22% | 186.471 | -0.00229 [-0.0306, +0.0260] |
| CURRENT | Current freqShort | 900 | 2.388653 | 0.915510 | 9.75% | -6970.683 | +0.08608 [+0.0578, +0.1144] |
| CURRENT | Current freqLong | 900 | 2.308935 | 0.901297 | 9.26% | -514.266 | +0.00636 [-0.0219, +0.0346] |
| CURRENT | Current decayed | 900 | 2.309816 | 0.901564 | 8.00% | -585.649 | +0.00724 [-0.0210, +0.0355] |
| CURRENT | Current trans1 | 900 | 2.307878 | 0.901030 | 10.26% | -428.709 | +0.00531 [-0.0230, +0.0336] |
| CURRENT | Current trans2 | 900 | 2.354762 | 0.909882 | 10.67% | -4225.878 | +0.05219 [+0.0239, +0.0805] |
| CURRENT | Current gap | 900 | 2.311411 | 0.901686 | 10.56% | -714.780 | +0.00884 [-0.0194, +0.0371] |
| CURRENT | Current streak | 900 | 2.316647 | 0.903048 | 9.33% | -1138.882 | +0.01407 [-0.0142, +0.0424] |
| NEW | Candidate HDM | 900 | 2.300223 | 0.899543 | 8.89% | 191.328 | -0.00235 [-0.0306, +0.0259] |
| NEW | Candidate discounted Dirichlet | 900 | 2.305134 | 0.900553 | 8.33% | -206.466 | +0.00256 [-0.0257, +0.0308] |
| NEW | Candidate CTW-3 | 900 | 2.300334 | 0.899563 | 9.39% | 182.334 | -0.00224 [-0.0305, +0.0260] |
| NEW | Candidate modular increment | 900 | 2.302572 | 0.899997 | 10.89% | 1.088 | -0.00000 [-0.0283, +0.0283] |
| NEW | Candidate lag tables | 900 | 2.302606 | 0.899988 | 10.33% | -1.657 | +0.00003 [-0.0282, +0.0283] |
| NEW | New softmax regression | 900 | 2.346377 | 0.908631 | 10.11% | -3546.778 | +0.04380 [+0.0155, +0.0721] |
| NEW | New gapRamp (L=122) | 900 | 2.304702 | 0.900456 | 10.22% | -171.415 | +0.00213 [-0.0262, +0.0304] |
| NEW | New weighted mixture | 900 | 2.301724 | 0.899829 | 11.22% | 69.719 | -0.00085 [-0.0291, +0.0274] |
| ORACLE | True generator oracle | 900 | 2.302573 | 0.899998 | 10.89% | 1.000 | +0.00000 [+0.0000, +0.0000] |

Mean earned mixture weights in the scored window:

| Expert | Mean weight |  |  |  |  |  |
| --- | ---: | --- | --- | --- | --- | --- |
| Current Dirichlet | 10.16% |  |  |  |  |  |
| Current freqShort | 0.01% |  |  |  |  |  |
| Current freqLong | 2.57% |  |  |  |  |  |
| Current decayed | 4.68% |  |  |  |  |  |
| Candidate HDM | 15.39% |  |  |  |  |  |
| Candidate discounted Dirichlet | 7.19% |  |  |  |  |  |
| Current trans1 | 0.72% |  |  |  |  |  |
| Current trans2 | 0.00% |  |  |  |  |  |
| Candidate CTW-3 | 7.28% |  |  |  |  |  |
| Candidate modular increment | 19.58% |  |  |  |  |  |
| Candidate lag tables | 11.99% |  |  |  |  |  |
| New softmax regression | 0.43% |  |  |  |  |  |
| Current gap | 1.33% |  |  |  |  |  |
| New gapRamp (L=122) | 18.46% |  |  |  |  |  |
| Current streak | 0.21% |  |  |  |  |  |
| increment-memory | 1 | exact | Current Dirichlet − True generator oracle: +0.09389 [+0.0853, +0.1025] | Current ensemble (final vector) − True generator oracle: +0.09158 [+0.0829, +0.1002] | Candidate modular increment − True generator oracle: +0.07489 [+0.0663, +0.0835] | Current Dirichlet − Candidate modular increment: +0.01900 [+0.0150, +0.0232] |

### increment-memory — horizon 1 (exact)

Modulo-10 increments tend to repeat

| Group | Model | N | Log loss | Brier | Hit rate | Gain captured | LL(model−oracle), 95% block CI |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| BASELINE | Uniform baseline | 35,997 | 2.302585 | 0.900000 | 10.00% | 0.000 | +0.09320 [+0.0846, +0.1018] |
| CURRENT | Current ensemble (final vector) | 35,997 | 2.300964 | 0.899598 | 11.19% | 0.017 | +0.09158 [+0.0829, +0.1002] |
| CURRENT | Current Dirichlet | 35,997 | 2.303280 | 0.900138 | 10.08% | -0.007 | +0.09389 [+0.0853, +0.1025] |
| CURRENT | Current freqShort | 35,997 | 2.369664 | 0.911962 | 10.44% | -0.720 | +0.16028 [+0.1516, +0.1689] |
| CURRENT | Current freqLong | 35,997 | 2.306707 | 0.900819 | 10.07% | -0.044 | +0.09732 [+0.0887, +0.1060] |
| CURRENT | Current decayed | 35,997 | 2.307133 | 0.900901 | 10.11% | -0.049 | +0.09775 [+0.0891, +0.1064] |
| CURRENT | Current trans1 | 35,997 | 2.308508 | 0.901169 | 9.92% | -0.064 | +0.09912 [+0.0905, +0.1078] |
| CURRENT | Current trans2 | 35,997 | 2.327627 | 0.903428 | 14.69% | -0.269 | +0.11824 [+0.1096, +0.1269] |
| CURRENT | Current gap | 35,997 | 2.310211 | 0.901487 | 10.22% | -0.082 | +0.10083 [+0.0922, +0.1095] |
| CURRENT | Current streak | 35,997 | 2.307294 | 0.900272 | 10.46% | -0.051 | +0.09791 [+0.0893, +0.1065] |
| NEW | Candidate HDM | 35,997 | 2.303393 | 0.900161 | 10.03% | -0.009 | +0.09401 [+0.0854, +0.1026] |
| NEW | Candidate discounted Dirichlet | 35,997 | 2.304530 | 0.900386 | 10.19% | -0.021 | +0.09514 [+0.0865, +0.1038] |
| NEW | Candidate CTW-3 | 35,997 | 2.303287 | 0.900139 | 10.07% | -0.008 | +0.09390 [+0.0853, +0.1025] |
| NEW | Candidate modular increment | 35,997 | 2.284278 | 0.895453 | 17.11% | 0.196 | +0.07489 [+0.0663, +0.0835] |
| NEW | Candidate lag tables | 35,997 | 2.303219 | 0.900120 | 10.40% | -0.007 | +0.09383 [+0.0852, +0.1025] |
| NEW | New softmax regression | 35,997 | 2.332396 | 0.905982 | 10.71% | -0.320 | +0.12301 [+0.1144, +0.1316] |
| NEW | New gapRamp (L=122) | 35,997 | 2.304434 | 0.900392 | 10.13% | -0.020 | +0.09505 [+0.0864, +0.1037] |
| NEW | New weighted mixture | 35,997 | 2.293202 | 0.897976 | 15.93% | 0.101 | +0.08382 [+0.0752, +0.0925] |
| ORACLE | True generator oracle | 35,997 | 2.209386 | 0.867238 | 17.11% | 1.000 | +0.00000 [+0.0000, +0.0000] |

Mean earned mixture weights in the scored window:

| Expert | Mean weight |  |  |  |  |  |
| --- | ---: | --- | --- | --- | --- | --- |
| Current Dirichlet | 9.83% |  |  |  |  |  |
| Current freqShort | 0.02% |  |  |  |  |  |
| Current freqLong | 2.50% |  |  |  |  |  |
| Current decayed | 5.91% |  |  |  |  |  |
| Candidate HDM | 13.77% |  |  |  |  |  |
| Candidate discounted Dirichlet | 7.97% |  |  |  |  |  |
| Current trans1 | 0.66% |  |  |  |  |  |
| Current trans2 | 0.02% |  |  |  |  |  |
| Candidate CTW-3 | 6.10% |  |  |  |  |  |
| Candidate modular increment | 21.31% |  |  |  |  |  |
| Candidate lag tables | 10.43% |  |  |  |  |  |
| New softmax regression | 0.94% |  |  |  |  |  |
| Current gap | 1.80% |  |  |  |  |  |
| New gapRamp (L=122) | 18.08% |  |  |  |  |  |
| Current streak | 0.67% |  |  |  |  |  |
| increment-memory | 5 | exact | Current trans1 − True generator oracle: +0.00220 [-0.0251, +0.0295] | Current ensemble (final vector) − True generator oracle: +0.00375 [-0.0236, +0.0311] | Candidate lag tables − True generator oracle: +0.00382 [-0.0235, +0.0311] | Current trans1 − Candidate lag tables: -0.00161 [-0.0068, +0.0044] |

### increment-memory — horizon 5 (exact)

Modulo-10 increments tend to repeat

| Group | Model | N | Log loss | Brier | Hit rate | Gain captured | LL(model−oracle), 95% block CI |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| BASELINE | Uniform baseline | 900 | 2.302585 | 0.900000 | 10.00% | 0.000 | +0.00390 [-0.0234, +0.0312] |
| CURRENT | Current ensemble (final vector) | 900 | 2.302433 | 0.899969 | 10.20% | 0.039 | +0.00375 [-0.0236, +0.0311] |
| CURRENT | Current Dirichlet | 900 | 2.302716 | 0.900026 | 10.33% | -0.033 | +0.00403 [-0.0233, +0.0314] |
| CURRENT | Current freqShort | 900 | 2.351288 | 0.909027 | 10.51% | -12.477 | +0.05261 [+0.0253, +0.0799] |
| CURRENT | Current freqLong | 900 | 2.305583 | 0.900566 | 11.26% | -0.768 | +0.00690 [-0.0204, +0.0342] |
| CURRENT | Current decayed | 900 | 2.303769 | 0.900229 | 9.33% | -0.303 | +0.00509 [-0.0222, +0.0324] |
| CURRENT | Current trans1 | 900 | 2.300886 | 0.899565 | 12.17% | 0.435 | +0.00220 [-0.0251, +0.0295] |
| CURRENT | Current trans2 | 900 | 2.334311 | 0.905845 | 10.24% | -8.128 | +0.03563 [+0.0083, +0.0630] |
| CURRENT | Current gap | 900 | 2.309928 | 0.901492 | 9.78% | -1.881 | +0.01125 [-0.0161, +0.0386] |
| CURRENT | Current streak | 900 | 2.308235 | 0.900952 | 12.01% | -1.447 | +0.00955 [-0.0178, +0.0369] |
| NEW | Candidate HDM | 900 | 2.302817 | 0.900045 | 10.56% | -0.059 | +0.00414 [-0.0232, +0.0315] |
| NEW | Candidate discounted Dirichlet | 900 | 2.303360 | 0.900136 | 11.56% | -0.198 | +0.00468 [-0.0226, +0.0320] |
| NEW | Candidate CTW-3 | 900 | 2.302764 | 0.900035 | 10.33% | -0.046 | +0.00408 [-0.0232, +0.0314] |
| NEW | Candidate modular increment | 900 | 2.302609 | 0.900005 | 12.33% | -0.006 | +0.00393 [-0.0234, +0.0312] |
| NEW | Candidate lag tables | 900 | 2.302500 | 0.899975 | 10.89% | 0.022 | +0.00382 [-0.0235, +0.0311] |
| NEW | New softmax regression | 900 | 2.326681 | 0.904793 | 11.44% | -6.173 | +0.02800 [+0.0007, +0.0553] |
| NEW | New gapRamp (L=122) | 900 | 2.310197 | 0.901604 | 8.56% | -1.950 | +0.01152 [-0.0158, +0.0388] |
| NEW | New weighted mixture | 900 | 2.302806 | 0.900040 | 9.44% | -0.057 | +0.00412 [-0.0232, +0.0314] |
| ORACLE | True generator oracle | 900 | 2.298682 | 0.899188 | 13.00% | 1.000 | +0.00000 [+0.0000, +0.0000] |

Mean earned mixture weights in the scored window:

| Expert | Mean weight |  |  |  |  |  |
| --- | ---: | --- | --- | --- | --- | --- |
| Current Dirichlet | 10.23% |  |  |  |  |  |
| Current freqShort | 0.01% |  |  |  |  |  |
| Current freqLong | 2.01% |  |  |  |  |  |
| Current decayed | 5.29% |  |  |  |  |  |
| Candidate HDM | 14.96% |  |  |  |  |  |
| Candidate discounted Dirichlet | 7.50% |  |  |  |  |  |
| Current trans1 | 0.82% |  |  |  |  |  |
| Current trans2 | 0.00% |  |  |  |  |  |
| Candidate CTW-3 | 7.60% |  |  |  |  |  |
| Candidate modular increment | 17.32% |  |  |  |  |  |
| Candidate lag tables | 13.61% |  |  |  |  |  |
| New softmax regression | 0.64% |  |  |  |  |  |
| Current gap | 1.99% |  |  |  |  |  |
| New gapRamp (L=122) | 17.53% |  |  |  |  |  |
| Current streak | 0.48% |  |  |  |  |  |
| increment-memory | 10 | exact | Current Dirichlet − True generator oracle: -0.00174 [-0.0239, +0.0204] | Current ensemble (final vector) − True generator oracle: +0.00001 [-0.0222, +0.0222] | Candidate HDM − True generator oracle: -0.00188 [-0.0241, +0.0203] | Current Dirichlet − Candidate HDM: +0.00014 [-0.0002, +0.0005] |

### increment-memory — horizon 10 (exact)

Modulo-10 increments tend to repeat

| Group | Model | N | Log loss | Brier | Hit rate | Gain captured | LL(model−oracle), 95% block CI |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| BASELINE | Uniform baseline | 900 | 2.302585 | 0.900000 | 10.00% | 0.000 | +0.00001 [-0.0222, +0.0222] |
| CURRENT | Current ensemble (final vector) | 900 | 2.302585 | 0.900000 | 9.50% | -0.022 | +0.00001 [-0.0222, +0.0222] |
| CURRENT | Current Dirichlet | 900 | 2.300838 | 0.899661 | 10.61% | 236.116 | -0.00174 [-0.0239, +0.0204] |
| CURRENT | Current freqShort | 900 | 2.383160 | 0.915254 | 9.54% | -10889.051 | +0.08058 [+0.0584, +0.1028] |
| CURRENT | Current freqLong | 900 | 2.307338 | 0.900943 | 8.70% | -642.315 | +0.00476 [-0.0174, +0.0269] |
| CURRENT | Current decayed | 900 | 2.309952 | 0.901499 | 8.89% | -995.642 | +0.00737 [-0.0148, +0.0295] |
| CURRENT | Current trans1 | 900 | 2.301156 | 0.899713 | 11.96% | 193.182 | -0.00142 [-0.0236, +0.0208] |
| CURRENT | Current trans2 | 900 | 2.330562 | 0.905291 | 10.59% | -3780.882 | +0.02798 [+0.0058, +0.0502] |
| CURRENT | Current gap | 900 | 2.307075 | 0.900905 | 10.89% | -606.717 | +0.00450 [-0.0177, +0.0267] |
| CURRENT | Current streak | 900 | 2.311180 | 0.901515 | 11.21% | -1161.496 | +0.00860 [-0.0136, +0.0308] |
| NEW | Candidate HDM | 900 | 2.300694 | 0.899635 | 10.33% | 255.531 | -0.00188 [-0.0241, +0.0203] |
| NEW | Candidate discounted Dirichlet | 900 | 2.304524 | 0.900404 | 8.11% | -262.056 | +0.00195 [-0.0202, +0.0241] |
| NEW | Candidate CTW-3 | 900 | 2.300816 | 0.899657 | 10.61% | 239.103 | -0.00176 [-0.0239, +0.0204] |
| NEW | Candidate modular increment | 900 | 2.302585 | 0.900000 | 10.56% | -0.005 | +0.00001 [-0.0222, +0.0222] |
| NEW | Candidate lag tables | 900 | 2.302133 | 0.899906 | 10.33% | 61.139 | -0.00045 [-0.0226, +0.0217] |
| NEW | New softmax regression | 900 | 2.339324 | 0.907277 | 10.00% | -4964.909 | +0.03675 [+0.0146, +0.0589] |
| NEW | New gapRamp (L=122) | 900 | 2.303200 | 0.900148 | 10.11% | -83.077 | +0.00062 [-0.0216, +0.0228] |
| NEW | New weighted mixture | 900 | 2.301812 | 0.899848 | 9.89% | 104.490 | -0.00077 [-0.0229, +0.0214] |
| ORACLE | True generator oracle | 900 | 2.302578 | 0.899999 | 10.11% | 1.000 | +0.00000 [+0.0000, +0.0000] |

Mean earned mixture weights in the scored window:

| Expert | Mean weight |  |  |  |  |  |
| --- | ---: | --- | --- | --- | --- | --- |
| Current Dirichlet | 9.76% |  |  |  |  |  |
| Current freqShort | 0.01% |  |  |  |  |  |
| Current freqLong | 3.38% |  |  |  |  |  |
| Current decayed | 5.42% |  |  |  |  |  |
| Candidate HDM | 13.76% |  |  |  |  |  |
| Candidate discounted Dirichlet | 7.66% |  |  |  |  |  |
| Current trans1 | 0.84% |  |  |  |  |  |
| Current trans2 | 0.00% |  |  |  |  |  |
| Candidate CTW-3 | 8.17% |  |  |  |  |  |
| Candidate modular increment | 19.02% |  |  |  |  |  |
| Candidate lag tables | 11.39% |  |  |  |  |  |
| New softmax regression | 0.58% |  |  |  |  |  |
| Current gap | 1.33% |  |  |  |  |  |
| New gapRamp (L=122) | 18.32% |  |  |  |  |  |
| Current streak | 0.35% |  |  |  |  |  |
| regime-shift | 1 | exact | Current decayed − True generator oracle: +0.01684 [+0.0000, +0.0337] | Current ensemble (final vector) − True generator oracle: +0.01595 [-0.0009, +0.0328] | New weighted mixture − True generator oracle: +0.02582 [+0.0090, +0.0426] | Current decayed − New weighted mixture: -0.00898 [-0.0111, -0.0070] |

### regime-shift — horizon 1 (exact)

The favored digit changes halfway through the series

| Group | Model | N | Log loss | Brier | Hit rate | Gain captured | LL(model−oracle), 95% block CI |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| BASELINE | Uniform baseline | 35,997 | 2.302585 | 0.900000 | 10.00% | 0.000 | +0.40710 [+0.3903, +0.4239] |
| CURRENT | Current ensemble (final vector) | 35,997 | 1.911434 | 0.769262 | 44.82% | 0.961 | +0.01595 [-0.0009, +0.0328] |
| CURRENT | Current Dirichlet | 35,997 | 2.104079 | 0.858242 | 20.88% | 0.488 | +0.20860 [+0.1918, +0.2254] |
| CURRENT | Current freqShort | 35,997 | 1.961674 | 0.777817 | 44.97% | 0.837 | +0.06619 [+0.0494, +0.0830] |
| CURRENT | Current freqLong | 35,997 | 1.918214 | 0.772117 | 43.53% | 0.944 | +0.02273 [+0.0059, +0.0396] |
| CURRENT | Current decayed | 35,997 | 1.912322 | 0.769541 | 44.09% | 0.959 | +0.01684 [+0.0000, +0.0337] |
| CURRENT | Current trans1 | 35,997 | 2.050423 | 0.830496 | 30.88% | 0.619 | +0.15494 [+0.1381, +0.1718] |
| CURRENT | Current trans2 | 35,997 | 2.047309 | 0.818918 | 35.60% | 0.627 | +0.15183 [+0.1350, +0.1686] |
| CURRENT | Current gap | 35,997 | 1.986207 | 0.801789 | 38.42% | 0.777 | +0.09072 [+0.0739, +0.1075] |
| CURRENT | Current streak | 35,997 | 2.054572 | 0.830969 | 30.92% | 0.609 | +0.15909 [+0.1423, +0.1759] |
| NEW | Candidate HDM | 35,997 | 2.117852 | 0.864474 | 20.56% | 0.454 | +0.22237 [+0.2055, +0.2392] |
| NEW | Candidate discounted Dirichlet | 35,997 | 1.926082 | 0.776143 | 42.86% | 0.925 | +0.03060 [+0.0138, +0.0474] |
| NEW | Candidate CTW-3 | 35,997 | 2.068569 | 0.839562 | 29.56% | 0.575 | +0.17309 [+0.1563, +0.1899] |
| NEW | Candidate modular increment | 35,997 | 2.175735 | 0.864150 | 23.65% | 0.312 | +0.28025 [+0.2634, +0.2971] |
| NEW | Candidate lag tables | 35,997 | 2.030903 | 0.823631 | 32.74% | 0.667 | +0.13542 [+0.1186, +0.1522] |
| NEW | New softmax regression | 35,997 | 1.927860 | 0.772937 | 44.85% | 0.920 | +0.03238 [+0.0156, +0.0492] |
| NEW | New gapRamp (L=122) | 35,997 | 2.343661 | 0.908322 | 6.15% | -0.101 | +0.44818 [+0.4314, +0.4650] |
| NEW | New weighted mixture | 35,997 | 1.921304 | 0.773522 | 43.78% | 0.937 | +0.02582 [+0.0090, +0.0426] |
| ORACLE | True generator oracle | 35,997 | 1.895483 | 0.763449 | 45.06% | 1.000 | +0.00000 [+0.0000, +0.0000] |

Mean earned mixture weights in the scored window:

| Expert | Mean weight |  |  |  |  |  |
| --- | ---: | --- | --- | --- | --- | --- |
| Current Dirichlet | 3.70% |  |  |  |  |  |
| Current freqShort | 0.03% |  |  |  |  |  |
| Current freqLong | 2.57% |  |  |  |  |  |
| Current decayed | 24.09% |  |  |  |  |  |
| Candidate HDM | 5.21% |  |  |  |  |  |
| Candidate discounted Dirichlet | 4.40% |  |  |  |  |  |
| Current trans1 | 1.65% |  |  |  |  |  |
| Current trans2 | 0.00% |  |  |  |  |  |
| Candidate CTW-3 | 12.82% |  |  |  |  |  |
| Candidate modular increment | 0.00% |  |  |  |  |  |
| Candidate lag tables | 0.13% |  |  |  |  |  |
| New softmax regression | 25.41% |  |  |  |  |  |
| Current gap | 18.53% |  |  |  |  |  |
| New gapRamp (L=122) | 0.00% |  |  |  |  |  |
| Current streak | 1.47% |  |  |  |  |  |
| regime-shift | 5 | exact | Current decayed − True generator oracle: +0.01268 [-0.0859, +0.1113] | Current ensemble (final vector) − True generator oracle: +0.01537 [-0.0832, +0.1140] | New weighted mixture − True generator oracle: +0.01855 [-0.0801, +0.1171] | Current decayed − New weighted mixture: -0.00587 [-0.0142, +0.0018] |

### regime-shift — horizon 5 (exact)

The favored digit changes halfway through the series

| Group | Model | N | Log loss | Brier | Hit rate | Gain captured | LL(model−oracle), 95% block CI |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| BASELINE | Uniform baseline | 900 | 2.302585 | 0.900000 | 10.00% | 0.000 | +0.40153 [+0.3029, +0.5001] |
| CURRENT | Current ensemble (final vector) | 900 | 1.916431 | 0.771119 | 44.67% | 0.962 | +0.01537 [-0.0832, +0.1140] |
| CURRENT | Current Dirichlet | 900 | 2.118709 | 0.864037 | 20.00% | 0.458 | +0.21765 [+0.1191, +0.3163] |
| CURRENT | Current freqShort | 900 | 1.951021 | 0.776238 | 44.78% | 0.876 | +0.04996 [-0.0486, +0.1486] |
| CURRENT | Current freqLong | 900 | 1.919389 | 0.771072 | 43.44% | 0.954 | +0.01833 [-0.0803, +0.1169] |
| CURRENT | Current decayed | 900 | 1.913734 | 0.769055 | 44.44% | 0.968 | +0.01268 [-0.0859, +0.1113] |
| CURRENT | Current trans1 | 900 | 2.071726 | 0.838534 | 29.50% | 0.575 | +0.17067 [+0.0721, +0.2693] |
| CURRENT | Current trans2 | 900 | 2.059492 | 0.826209 | 33.89% | 0.605 | +0.15843 [+0.0598, +0.2570] |
| CURRENT | Current gap | 900 | 2.000648 | 0.808061 | 37.67% | 0.752 | +0.09959 [+0.0010, +0.1982] |
| CURRENT | Current streak | 900 | 2.077847 | 0.839536 | 28.83% | 0.560 | +0.17679 [+0.0782, +0.2754] |
| NEW | Candidate HDM | 900 | 2.132813 | 0.870141 | 19.89% | 0.423 | +0.23175 [+0.1332, +0.3304] |
| NEW | Candidate discounted Dirichlet | 900 | 1.931934 | 0.777061 | 43.11% | 0.923 | +0.03088 [-0.0677, +0.1295] |
| NEW | Candidate CTW-3 | 900 | 2.092626 | 0.848580 | 27.94% | 0.523 | +0.19157 [+0.0930, +0.2902] |
| NEW | Candidate modular increment | 900 | 2.287644 | 0.896885 | 23.33% | 0.037 | +0.38659 [+0.2880, +0.4852] |
| NEW | Candidate lag tables | 900 | 2.046139 | 0.830630 | 30.11% | 0.639 | +0.14508 [+0.0465, +0.2437] |
| NEW | New softmax regression | 900 | 1.924476 | 0.772647 | 44.67% | 0.942 | +0.02342 [-0.0752, +0.1220] |
| NEW | New gapRamp (L=122) | 900 | 2.347263 | 0.909036 | 5.44% | -0.111 | +0.44620 [+0.3476, +0.5448] |
| NEW | New weighted mixture | 900 | 1.919607 | 0.773547 | 44.00% | 0.954 | +0.01855 [-0.0801, +0.1171] |
| ORACLE | True generator oracle | 900 | 1.901058 | 0.765622 | 44.78% | 1.000 | +0.00000 [+0.0000, +0.0000] |

Mean earned mixture weights in the scored window:

| Expert | Mean weight |  |  |  |  |  |
| --- | ---: | --- | --- | --- | --- | --- |
| Current Dirichlet | 3.62% |  |  |  |  |  |
| Current freqShort | 0.02% |  |  |  |  |  |
| Current freqLong | 3.22% |  |  |  |  |  |
| Current decayed | 23.55% |  |  |  |  |  |
| Candidate HDM | 5.25% |  |  |  |  |  |
| Candidate discounted Dirichlet | 4.35% |  |  |  |  |  |
| Current trans1 | 1.49% |  |  |  |  |  |
| Current trans2 | 0.00% |  |  |  |  |  |
| Candidate CTW-3 | 12.98% |  |  |  |  |  |
| Candidate modular increment | 0.00% |  |  |  |  |  |
| Candidate lag tables | 0.27% |  |  |  |  |  |
| New softmax regression | 25.25% |  |  |  |  |  |
| Current gap | 18.53% |  |  |  |  |  |
| New gapRamp (L=122) | 0.00% |  |  |  |  |  |
| Current streak | 1.47% |  |  |  |  |  |
| regime-shift | 10 | exact | Current decayed − True generator oracle: +0.01879 [-0.0783, +0.1159] | Current ensemble (final vector) − True generator oracle: +0.02304 [-0.0740, +0.1201] | New weighted mixture − True generator oracle: +0.03055 [-0.0665, +0.1276] | Current decayed − New weighted mixture: -0.01176 [-0.0215, -0.0028] |

### regime-shift — horizon 10 (exact)

The favored digit changes halfway through the series

| Group | Model | N | Log loss | Brier | Hit rate | Gain captured | LL(model−oracle), 95% block CI |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| BASELINE | Uniform baseline | 900 | 2.302585 | 0.900000 | 10.00% | 0.000 | +0.38153 [+0.2844, +0.4786] |
| CURRENT | Current ensemble (final vector) | 900 | 1.944098 | 0.781927 | 43.11% | 0.940 | +0.02304 [-0.0740, +0.1201] |
| CURRENT | Current Dirichlet | 900 | 2.149412 | 0.874163 | 18.44% | 0.401 | +0.22835 [+0.1313, +0.3254] |
| CURRENT | Current freqShort | 900 | 1.999689 | 0.788425 | 43.44% | 0.794 | +0.07863 [-0.0184, +0.1757] |
| CURRENT | Current freqLong | 900 | 1.943687 | 0.782688 | 42.33% | 0.941 | +0.02263 [-0.0744, +0.1197] |
| CURRENT | Current decayed | 900 | 1.939852 | 0.780788 | 42.56% | 0.951 | +0.01879 [-0.0783, +0.1159] |
| CURRENT | Current trans1 | 900 | 2.085927 | 0.841342 | 29.06% | 0.568 | +0.16487 [+0.0678, +0.2619] |
| CURRENT | Current trans2 | 900 | 2.078222 | 0.827607 | 33.59% | 0.588 | +0.15716 [+0.0601, +0.2542] |
| CURRENT | Current gap | 900 | 2.021209 | 0.814577 | 36.89% | 0.737 | +0.10015 [+0.0031, +0.1972] |
| CURRENT | Current streak | 900 | 2.099196 | 0.843642 | 28.72% | 0.533 | +0.17814 [+0.0811, +0.2752] |
| NEW | Candidate HDM | 900 | 2.161010 | 0.879469 | 18.11% | 0.371 | +0.23995 [+0.1429, +0.3370] |
| NEW | Candidate discounted Dirichlet | 900 | 1.956230 | 0.787739 | 41.67% | 0.908 | +0.03517 [-0.0619, +0.1322] |
| NEW | Candidate CTW-3 | 900 | 2.103075 | 0.850455 | 27.94% | 0.523 | +0.18202 [+0.0849, +0.2791] |
| NEW | Candidate modular increment | 900 | 2.302302 | 0.899943 | 23.33% | 0.001 | +0.38124 [+0.2842, +0.4783] |
| NEW | Candidate lag tables | 900 | 2.073297 | 0.837976 | 30.56% | 0.601 | +0.15224 [+0.0552, +0.2493] |
| NEW | New softmax regression | 900 | 1.960545 | 0.784057 | 43.11% | 0.897 | +0.03949 [-0.0576, +0.1366] |
| NEW | New gapRamp (L=122) | 900 | 2.339546 | 0.907483 | 6.00% | -0.097 | +0.41849 [+0.3214, +0.5156] |
| NEW | New weighted mixture | 900 | 1.951611 | 0.784808 | 42.56% | 0.920 | +0.03055 [-0.0665, +0.1276] |
| ORACLE | True generator oracle | 900 | 1.921058 | 0.773419 | 43.78% | 1.000 | +0.00000 [+0.0000, +0.0000] |

Mean earned mixture weights in the scored window:

| Expert | Mean weight |  |  |  |  |  |
| --- | ---: | --- | --- | --- | --- | --- |
| Current Dirichlet | 3.82% |  |  |  |  |  |
| Current freqShort | 0.02% |  |  |  |  |  |
| Current freqLong | 1.99% |  |  |  |  |  |
| Current decayed | 24.50% |  |  |  |  |  |
| Candidate HDM | 5.34% |  |  |  |  |  |
| Candidate discounted Dirichlet | 4.33% |  |  |  |  |  |
| Current trans1 | 1.67% |  |  |  |  |  |
| Current trans2 | 0.00% |  |  |  |  |  |
| Candidate CTW-3 | 12.97% |  |  |  |  |  |
| Candidate modular increment | 0.00% |  |  |  |  |  |
| Candidate lag tables | 0.18% |  |  |  |  |  |
| New softmax regression | 25.17% |  |  |  |  |  |
| Current gap | 18.41% |  |  |  |  |  |
| New gapRamp (L=122) | 0.00% |  |  |  |  |  |
| Current streak | 1.59% |  |  |  |  |  |
| combined-all | 1 | exact | Current streak − True generator oracle: +0.12304 [+0.0853, +0.1608] | Current ensemble (final vector) − True generator oracle: +0.13510 [+0.0973, +0.1729] | New softmax regression − True generator oracle: +0.06474 [+0.0269, +0.1025] | Current streak − New softmax regression: +0.05830 [+0.0525, +0.0641] |

### combined-all — horizon 1 (exact)

All of the above mechanisms act together, plus recent-frequency feedback

| Group | Model | N | Log loss | Brier | Hit rate | Gain captured | LL(model−oracle), 95% block CI |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| BASELINE | Uniform baseline | 35,997 | 2.302585 | 0.900000 | 10.00% | 0.000 | +0.77695 [+0.7392, +0.8147] |
| CURRENT | Current ensemble (final vector) | 35,997 | 1.660741 | 0.660168 | 48.24% | 0.826 | +0.13510 [+0.0973, +0.1729] |
| CURRENT | Current Dirichlet | 35,997 | 2.111439 | 0.862282 | 19.63% | 0.246 | +0.58580 [+0.5480, +0.6236] |
| CURRENT | Current freqShort | 35,997 | 1.903677 | 0.771590 | 39.18% | 0.513 | +0.37804 [+0.3403, +0.4158] |
| CURRENT | Current freqLong | 35,997 | 1.967472 | 0.812741 | 32.42% | 0.431 | +0.44183 [+0.4040, +0.4796] |
| CURRENT | Current decayed | 35,997 | 1.939552 | 0.800565 | 34.85% | 0.467 | +0.41391 [+0.3761, +0.4517] |
| CURRENT | Current trans1 | 35,997 | 1.753092 | 0.703635 | 46.76% | 0.707 | +0.22745 [+0.1897, +0.2652] |
| CURRENT | Current trans2 | 35,997 | 1.689565 | 0.660689 | 46.98% | 0.789 | +0.16393 [+0.1261, +0.2017] |
| CURRENT | Current gap | 35,997 | 1.716170 | 0.687280 | 48.23% | 0.755 | +0.19053 [+0.1527, +0.2283] |
| CURRENT | Current streak | 35,997 | 1.648677 | 0.648962 | 47.31% | 0.842 | +0.12304 [+0.0853, +0.1608] |
| NEW | Candidate HDM | 35,997 | 2.112847 | 0.862829 | 19.47% | 0.244 | +0.58721 [+0.5494, +0.6250] |
| NEW | Candidate discounted Dirichlet | 35,997 | 1.885159 | 0.773161 | 39.01% | 0.537 | +0.35952 [+0.3217, +0.3973] |
| NEW | Candidate CTW-3 | 35,997 | 1.708777 | 0.675280 | 46.62% | 0.764 | +0.18314 [+0.1454, +0.2209] |
| NEW | Candidate modular increment | 35,997 | 1.714257 | 0.671804 | 47.05% | 0.757 | +0.18862 [+0.1508, +0.2264] |
| NEW | Candidate lag tables | 35,997 | 1.759164 | 0.707634 | 46.14% | 0.699 | +0.23353 [+0.1957, +0.2713] |
| NEW | New softmax regression | 35,997 | 1.590373 | 0.630440 | 50.29% | 0.917 | +0.06474 [+0.0269, +0.1025] |
| NEW | New gapRamp (L=122) | 35,997 | 2.386596 | 0.915839 | 9.21% | -0.108 | +0.86096 [+0.8232, +0.8987] |
| NEW | New weighted mixture | 35,997 | 1.605927 | 0.637736 | 49.73% | 0.897 | +0.08029 [+0.0425, +0.1181] |
| ORACLE | True generator oracle | 35,997 | 1.525638 | 0.614747 | 51.47% | 1.000 | +0.00000 [+0.0000, +0.0000] |

Mean earned mixture weights in the scored window:

| Expert | Mean weight |  |  |  |  |  |
| --- | ---: | --- | --- | --- | --- | --- |
| Current Dirichlet | 0.00% |  |  |  |  |  |
| Current freqShort | 0.00% |  |  |  |  |  |
| Current freqLong | 0.00% |  |  |  |  |  |
| Current decayed | 0.00% |  |  |  |  |  |
| Candidate HDM | 0.00% |  |  |  |  |  |
| Candidate discounted Dirichlet | 0.00% |  |  |  |  |  |
| Current trans1 | 0.00% |  |  |  |  |  |
| Current trans2 | 0.02% |  |  |  |  |  |
| Candidate CTW-3 | 0.00% |  |  |  |  |  |
| Candidate modular increment | 0.00% |  |  |  |  |  |
| Candidate lag tables | 0.00% |  |  |  |  |  |
| New softmax regression | 39.98% |  |  |  |  |  |
| Current gap | 20.00% |  |  |  |  |  |
| New gapRamp (L=122) | 0.00% |  |  |  |  |  |
| Current streak | 40.00% |  |  |  |  |  |
| combined-all | 5 | estimated; 5000 Monte Carlo paths | Current streak − True generator oracle: +0.11460 [+0.0110, +0.2182] | Current ensemble (final vector) − True generator oracle: +0.09235 [-0.0113, +0.1960] | New weighted mixture − True generator oracle: +0.06133 [-0.0423, +0.1649] | Current streak − New weighted mixture: +0.05326 [+0.0289, +0.0767] |

### combined-all — horizon 5 (estimated; 5000 Monte Carlo paths)

All of the above mechanisms act together, plus recent-frequency feedback

| Group | Model | N | Log loss | Brier | Hit rate | Gain captured | LL(model−oracle), 95% block CI |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| BASELINE | Uniform baseline | 900 | 2.302585 | 0.900000 | 10.00% | 0.000 | +0.52389 [+0.4203, +0.6275] |
| CURRENT | Current ensemble (final vector) | 900 | 1.871047 | 0.759287 | 39.67% | 0.824 | +0.09235 [-0.0113, +0.1960] |
| CURRENT | Current Dirichlet | 900 | 2.089128 | 0.855666 | 23.22% | 0.407 | +0.31043 [+0.2068, +0.4140] |
| CURRENT | Current freqShort | 900 | 1.970570 | 0.798273 | 37.56% | 0.634 | +0.19187 [+0.0883, +0.2955] |
| CURRENT | Current freqLong | 900 | 1.943877 | 0.804658 | 33.11% | 0.685 | +0.16518 [+0.0616, +0.2688] |
| CURRENT | Current decayed | 900 | 1.920752 | 0.794784 | 35.44% | 0.729 | +0.14206 [+0.0385, +0.2457] |
| CURRENT | Current trans1 | 900 | 1.938144 | 0.784176 | 39.22% | 0.696 | +0.15945 [+0.0558, +0.2631] |
| CURRENT | Current trans2 | 900 | 1.916965 | 0.760772 | 39.49% | 0.736 | +0.13827 [+0.0347, +0.2419] |
| CURRENT | Current gap | 900 | 1.904407 | 0.773283 | 40.11% | 0.760 | +0.12571 [+0.0221, +0.2293] |
| CURRENT | Current streak | 900 | 1.893295 | 0.757193 | 39.19% | 0.781 | +0.11460 [+0.0110, +0.2182] |
| NEW | Candidate HDM | 900 | 2.090188 | 0.856027 | 23.00% | 0.405 | +0.31149 [+0.2079, +0.4151] |
| NEW | Candidate discounted Dirichlet | 900 | 1.926091 | 0.795707 | 35.78% | 0.719 | +0.14739 [+0.0438, +0.2510] |
| NEW | Candidate CTW-3 | 900 | 1.939133 | 0.784069 | 39.22% | 0.694 | +0.16044 [+0.0568, +0.2640] |
| NEW | Candidate modular increment | 900 | 2.043684 | 0.819239 | 36.33% | 0.494 | +0.26499 [+0.1614, +0.3686] |
| NEW | Candidate lag tables | 900 | 1.912370 | 0.776514 | 39.00% | 0.745 | +0.13367 [+0.0301, +0.2373] |
| NEW | New softmax regression | 900 | 1.854495 | 0.751246 | 41.67% | 0.855 | +0.07580 [-0.0278, +0.1794] |
| NEW | New gapRamp (L=122) | 900 | 2.374179 | 0.913810 | 5.67% | -0.137 | +0.59548 [+0.4919, +0.6991] |
| NEW | New weighted mixture | 900 | 1.840031 | 0.745639 | 41.11% | 0.883 | +0.06133 [-0.0423, +0.1649] |
| ORACLE | True generator oracle | 900 | 1.778696 | 0.725568 | 44.67% | 1.000 | +0.00000 [+0.0000, +0.0000] |

Mean earned mixture weights in the scored window:

| Expert | Mean weight |  |  |  |  |  |
| --- | ---: | --- | --- | --- | --- | --- |
| Current Dirichlet | 0.02% |  |  |  |  |  |
| Current freqShort | 0.01% |  |  |  |  |  |
| Current freqLong | 0.01% |  |  |  |  |  |
| Current decayed | 0.06% |  |  |  |  |  |
| Candidate HDM | 0.03% |  |  |  |  |  |
| Candidate discounted Dirichlet | 0.11% |  |  |  |  |  |
| Current trans1 | 1.46% |  |  |  |  |  |
| Current trans2 | 0.16% |  |  |  |  |  |
| Candidate CTW-3 | 0.11% |  |  |  |  |  |
| Candidate modular increment | 0.00% |  |  |  |  |  |
| Candidate lag tables | 0.05% |  |  |  |  |  |
| New softmax regression | 38.23% |  |  |  |  |  |
| Current gap | 21.86% |  |  |  |  |  |
| New gapRamp (L=122) | 0.00% |  |  |  |  |  |
| Current streak | 37.90% |  |  |  |  |  |
| combined-all | 10 | estimated; 5000 Monte Carlo paths | Current decayed − True generator oracle: +0.11155 [+0.0189, +0.2042] | Current ensemble (final vector) − True generator oracle: +0.06362 [-0.0290, +0.1563] | New weighted mixture − True generator oracle: +0.05478 [-0.0379, +0.1474] | Current decayed − New weighted mixture: +0.05677 [+0.0390, +0.0737] |

### combined-all — horizon 10 (estimated; 5000 Monte Carlo paths)

All of the above mechanisms act together, plus recent-frequency feedback

| Group | Model | N | Log loss | Brier | Hit rate | Gain captured | LL(model−oracle), 95% block CI |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| BASELINE | Uniform baseline | 900 | 2.302585 | 0.900000 | 10.00% | 0.000 | +0.45689 [+0.3642, +0.5496] |
| CURRENT | Current ensemble (final vector) | 900 | 1.909306 | 0.783945 | 36.44% | 0.861 | +0.06362 [-0.0290, +0.1563] |
| CURRENT | Current Dirichlet | 900 | 2.099352 | 0.860825 | 21.00% | 0.445 | +0.25366 [+0.1610, +0.3463] |
| CURRENT | Current freqShort | 900 | 1.991880 | 0.799972 | 36.63% | 0.680 | +0.14619 [+0.0535, +0.2388] |
| CURRENT | Current freqLong | 900 | 1.987882 | 0.824137 | 30.28% | 0.689 | +0.14219 [+0.0495, +0.2349] |
| CURRENT | Current decayed | 900 | 1.957239 | 0.809863 | 33.22% | 0.756 | +0.11155 [+0.0189, +0.2042] |
| CURRENT | Current trans1 | 900 | 1.981664 | 0.807367 | 34.83% | 0.702 | +0.13597 [+0.0433, +0.2286] |
| CURRENT | Current trans2 | 900 | 1.972171 | 0.795280 | 34.97% | 0.723 | +0.12648 [+0.0338, +0.2191] |
| CURRENT | Current gap | 900 | 1.973219 | 0.805006 | 34.00% | 0.721 | +0.12753 [+0.0349, +0.2202] |
| CURRENT | Current streak | 900 | 1.960900 | 0.792737 | 33.84% | 0.748 | +0.11521 [+0.0225, +0.2079] |
| NEW | Candidate HDM | 900 | 2.100673 | 0.861286 | 21.00% | 0.442 | +0.25498 [+0.1623, +0.3476] |
| NEW | Candidate discounted Dirichlet | 900 | 1.942109 | 0.798875 | 35.44% | 0.789 | +0.09642 [+0.0038, +0.1891] |
| NEW | Candidate CTW-3 | 900 | 1.984670 | 0.808727 | 33.50% | 0.696 | +0.13898 [+0.0463, +0.2316] |
| NEW | Candidate modular increment | 900 | 2.215462 | 0.878979 | 31.33% | 0.191 | +0.36977 [+0.2771, +0.4624] |
| NEW | Candidate lag tables | 900 | 1.978651 | 0.809179 | 33.36% | 0.709 | +0.13296 [+0.0403, +0.2256] |
| NEW | New softmax regression | 900 | 1.925837 | 0.787163 | 35.78% | 0.825 | +0.08015 [-0.0125, +0.1728] |
| NEW | New gapRamp (L=122) | 900 | 2.370123 | 0.912988 | 5.61% | -0.148 | +0.52443 [+0.4318, +0.6171] |
| NEW | New weighted mixture | 900 | 1.900470 | 0.779428 | 36.44% | 0.880 | +0.05478 [-0.0379, +0.1474] |
| ORACLE | True generator oracle | 900 | 1.845691 | 0.757877 | 38.56% | 1.000 | +0.00000 [+0.0000, +0.0000] |

Mean earned mixture weights in the scored window:

| Expert | Mean weight |
| --- | ---: |
| Current Dirichlet | 0.58% |
| Current freqShort | 0.05% |
| Current freqLong | 0.07% |
| Current decayed | 7.24% |
| Candidate HDM | 1.00% |
| Candidate discounted Dirichlet | 21.05% |
| Current trans1 | 9.58% |
| Current trans2 | 0.15% |
| Candidate CTW-3 | 0.84% |
| Candidate modular increment | 0.00% |
| Candidate lag tables | 0.44% |
| New softmax regression | 28.13% |
| Current gap | 23.65% |
| New gapRamp (L=122) | 0.00% |
| Current streak | 7.21% |

## Interpretation and oracle check

- Oracle validation: passed; no model beat the oracle beyond the simultaneous 95% block-bootstrap interval.

- The null-uniform row is strength 0: uniform and oracle coincide, and any apparent model advantage is sampling noise unless supported by the block-bootstrap interval.

- Positive gain captured means lower log loss than uniform; values above 1 can occur from sample variation or an estimated multi-step oracle and must be interpreted with its interval.

- Results are synthetic positive controls only, not evidence about real Deriv ticks or tradable performance. Production forecast and execution paths are unchanged.
