# Super Mathes: standalone research module

## Status

Super Mathes is an independent research and trading module with source-qualified
live capture, browser persistence, two research models and five-observation
records. The trading dashboard and authenticated execution integration are
implemented in the development worktree but the dashboard has **not** been
deployed. One $1 USD Demo Digit Matches contract was purchased and settled as
a loss using development modules loaded into the authenticated browser. The
record was recovered after a page reload and account reconnection without
sending another request. The authorization backend update was deployed
separately. Neither model is independently validated or
promoted, and no predictive advantage is claimed. Neural/deep-learning models
and the complete 75-role system are **not implemented**.

Work in progress: a configurable linear pool of the frequency and Markov
models can produce a research prediction when at least 20 observations and
five transitions from the current digit are available. These minima are
operational data checks, not proof of statistical reliability. The individual
distributions, weight, model versions and transition count are frozen with
the prediction. Tied combined leaders are rejected. The independent evaluator
scores the combined model only when this data gate and the unique-leader rule
are satisfied; paired log-loss and Brier differences use the same eligible
outcomes. No calibration or profitability claim follows from combining models.
The Trading Dashboard connects the combined prediction to the authenticated
Deriv socket, confirmed account currency and account type, quoted-price
Digit Matches purchases, settlement monitoring and a separate account-keyed
IndexedDB ledger. Web Locks restrict execution to the active research collector
tab. An eight-decimal accounting scale is stored with execution snapshots; it
is not a claim about a currency's supported precision. Unrepresentable values
and incompatible stored histories are rejected.

The backend records the OAuth trade scope in new sessions; existing sessions
without scope information fail closed and require a fresh login after the
backend is updated. Daily limits use `Africa/Nairobi` as requested; server time is not an account
time zone and the current socket has not supplied one. The configured zone is
not independently verified against the account.

A confirmed loss keeps the original digit; a confirmed match closes the cycle.
An interrupted or changed feed segment stops further purchases using that
cycle. Once stopped and with no unresolved order, the user may explicitly close
the cycle, preserving its history. Open contracts are reconciled on the original
account after reconnect or refresh. An interrupted buy without a confirmed
contract ID remains unknown and blocks further purchases; statement entries
cannot safely be attributed solely by time, stake or digit, and the dashboard
does not yet provide a way to resolve such an ambiguous purchase.

The requested role numbering contains 1–65 and 86–95: those 75 roles are mapped
below. Positions 66–85 and 96–100 are not created. Existing leadership and
validation personnel remain responsible for supervision; no additional staff
are instantiated.

## Repository audit and architecture

MambaFX is a static, browser-delivered application. `index.html` supplies
navigation and the shared public Deriv tick socket; Super Mathes receives its
messages directly, independently of LDPE and without trading credentials.
The former dependencies on LDPE digit extraction, probability validation,
entropy, mutual information, log loss and Brier scoring have been replaced by
independent implementations in `math.js`. The mutual-information estimate is
descriptive and does not provide the LDPE significance test. No LDPE state,
configuration, persistence, predictions or executor is read or written.
The Cloudflare Worker is not involved in the research pipeline.

The intended pipeline is source-qualified observations → validated sequence →
statistical features → independently evaluated models → calibrated aggregation
→ immutable forecasts and outcome records → dashboard and validation reports.
The module contains its own validation, sequence ledger, math, models,
recurrence transitions, IndexedDB store, live orchestration, dashboard and
chronological benchmark. Source identifiers distinguish endpoint, symbol and
precision. Timestamps alone cannot prove continuity.

## Implemented and outstanding

| Area | Status |
| --- | --- |
| Source-qualified, ordered, precision-aware observations | Public live ticks and API historical imports; isolated IndexedDB history, duplicate/order checks and best-effort gap detection |
| Smoothed frequency distribution, entropy and first-order mutual information | Implemented as diagnostics; no predictive significance or multiple-testing claim |
| Immediate prediction selection and aggregation | User-selected smoothed-frequency or first-order Markov research model; explicit prediction creation, no selection when the top digits tie, no automatic promotion |
| Recurrence | Frozen digit, distribution and five conditional hazards; exact, cumulative and survival probabilities; tracks all five observations even after an early hit. Hazards are supplied or use an explicitly stated constant independent-draw assumption, not a fitted recurrence model |
| Historical and walk-forward evaluation | Pre-specified chronological holdout with rolling updates, disjoint recurrence windows, calibration, paired baseline comparisons and block-bootstrap uncertainty; no automatic promotion or independently audited evidence of advantage |
| Dashboard, live integration, history persistence and import | Dedicated navigation, live status, prediction and report history, IndexedDB settings; historical import is API-only |
| Machine learning, hidden-state, neural and generator-forensics research | A first-order Markov model only; neural, hidden-state and generator forensics are not implemented |
| Professional contribution registry | This implementation map only; no runtime professional dashboard or execution tracking |
| Independent validation and production readiness | No independently supported predictive advantage; one Demo loss was verified, while live loss retry, win progression and ambiguous-purchase resolution remain unverified or incomplete |

`recurrenceProbabilities` accepts conditional hazards, not marginal
probabilities. The five-draw independent uniform baseline is 40.951%; that
assumption is not evidence that a specific source is independent or uniform.
Research records identify the model and assumptions and preserve the original
prediction while outcomes are appended. IDs are unique in the dedicated
IndexedDB database. The selected model ranks all ten digits and refuses ties
for first place rather than inventing a winner.

## Operation and API

Open **Super Mathes** in the application navigation. Choose the research model,
window and warmup. Predictions and benchmarks are explicitly triggered and
use only the current uninterrupted source segment. Each prediction is based on
the latest persisted observation; if another tick arrives during preparation
or the durable origin changes, creation fails instead of looking ahead.
Benchmarks score each outcome before updating the model. The latest stored
report compares the selected model with uniform; this is exploratory, not an
independent holdout or proof of edge. The history selector can inspect stored
sources even when they are not currently live.

In the development dashboard, select **Trading Dashboard**, connect the desired
account in Trading Grid and review all
stake, exposure, loss and target limits before starting. Take profit applies to
the cycle, session and Nairobi day; stop loss applies to the cycle and
session. The default stake, maximum stake, exposure, stop loss and take profit
are each one unit of the account currency. A Real-account start requires an
additional confirmation. Stop prevents new purchases but continues monitoring
known open contracts. Only the active collector tab can start or stop trading.

`window.SuperMathes` exposes `status`, `listSources()`, `getSource(source)`,
`listObservations(source, limit)`, `listPredictions(source, limit)`,
`listReports(source, limit)`, `listIntervals(source, limit)`, `getPrediction(id)`,
`createModelPrediction(windowSize, model)` and `benchmark(windowSize, warmup,
model)`. `validateIndependent(source, warmup, windowSize)` saves a separate validation
report; warmup must be at least 500. Model is `"frequency"` or `"markov"`.
Advanced callers can use
`createPrediction(input, expectedSequence)` with an explicit unique ID, source,
last-observation timestamp, ten probabilities, selected digit, five conditional
hazards, model and assumptions. The method freezes inputs synchronously and
rejects stale origins and inactive feeds. `importHistorical(name, inputs)`
accepts strictly increasing `{epoch, rawQuote, decimals}` records in a separate
historical-only namespace; precision must be consistent. It does not create or
score live predictions, and a failed multi-record import can leave an accepted
prefix. Retrying identical records is idempotent.

Live observation rows retain the exact JSON numeric literal as `rawQuote`,
precision, normalized `quote`, digit, source, timestamp, sequence and segment.
JSON numeric literals may omit trailing fractional zeros; normalization pads
those zeros using the instrument's supplied `pip_size`, without floating-point
reconstruction. Unsupported literals, missing or inconsistent precision,
conflicts and out-of-order events are rejected. An ambiguous same-timestamp
repetition is stored only once and invalidates incomplete predictions because
the feed does not supply a distinct per-tick ID.

Observation and affected prediction updates share one IndexedDB transaction.
On collector change, disconnect, stale feed, market/source change, invalid input or detected gap,
incomplete five-observation records become **Unscorable**, retaining any
already observed outcomes. Completed records are preserved. Uncertain intervals
are persisted with the last sequence and epoch, detection time, reason, and
the first subsequent observation when collection resumes. The 15-second
staleness threshold is a safety cutoff, not proof of a missed tick. Gap detection is
heuristic (more than three times the median after 20 intervals): Deriv's public
tick feed supplies no per-tick sequence number, so silent losses cannot always
be detected or proven absent. An adapter that supplies a verified monotonic
`providerSequence` can detect skipped or regressing sequence numbers; the
shared Deriv tick adapter does not invent or assume such a number. No missing
digits are fabricated. Recovery does not assume historical overlap proves continuity.

Exactly one same-origin collector holds a browser Web Lock; other tabs ignore
their tick stream and read the shared IndexedDB records. BroadcastChannel
provides advisory collector status, not ownership. Predictions and exploratory
benchmarks are created in the collector tab; other tabs can read shared history
and run validation. When the lock holder closes or crashes, the next holder
marks incomplete records unscorable before accepting ticks. Web Locks and
BroadcastChannel are required: unsupported browsers fail closed. A suspended
tab retaining a lock can delay takeover; heartbeat loss is displayed, never
used to create a second collector. Tabs running older cached code should be
closed or reloaded; they do not participate in this coordination protocol.
IndexedDB schema version 2 adds intervals without replacing existing stores.
Browser storage can be evicted, cleared or blocked; it is not a server backup.
Database errors are reported and acquisition stops if interruption state cannot
be saved.

## Independent validation protocol

The independent-validation button evaluates the latest single source segment,
using at most 10,000 observations. The first 500 or more observations are
training only. The remaining data is divided into three equal chronological
test periods, each rounded down to complete 100-observation blocks; any tail is
excluded. Models use the selected trailing observation window and update only
after each outcome, matching the operational research models. The evaluator reports the
frequency and first-order Markov models against uniform and the historical
frequency baseline, with top-1/2/3, multiclass log loss and Brier, descriptive
calibration bins, period-level results, and paired score differences.
Calibration bin counts are digit-probability pairs (up to ten per outcome),
not independent observations; no confidence interval is inferred from those
pair counts.
Top-1 evaluation and operational prediction creation both exclude tied model
leaders. Top-2/3 and the uniform baseline report the expected score under
random tie-breaking rather than inventing a selected digit; their sample sizes
can therefore differ from top-1.

Recurrence uses forecasts at non-overlapping five-observation windows and
excludes tied leaders. It reports cumulative, first-appearance exact,
conditional-after-misses and no-appearance rates, alongside the model,
uniform and historical-frequency assumptions. Each model's future hazards
are held constant as an explicit independent-draw approximation, not a fitted
recurrence model. Uniform probabilities include 0.40951 within five and
0.59049 for no appearance.

Confidence intervals use 500 fixed-seed, period-stratified block-bootstrap
replicates with non-overlapping 100-observation blocks. At least 30 blocks
(3,000 test observations, in addition to the training prefix) are required
for intervals; smaller samples are marked **Insufficient Evidence**. This
method assumes dependence is weak across blocks, an assumption not guaranteed
for arbitrary market data. Periods share earlier rolling training history;
the intervals are not an independent experiment, multiple-testing correction,
or proof of statistical significance. Model total variation is descriptive,
not proof that model information is independent. No automatic model selection,
promotion or superiority claim is made.

### Neural research assessment

No neural model is justified by the current evidence and none is operational.
A future hypothesis could test whether a fixed-length prefix of prior digits
adds out-of-sample information beyond both existing models. Its input would be
only that prefix; its output a normalized ten-digit distribution, with
independently specified recurrence hazards if studied. A future study would
require fixed seeds and code, chronological training and separate holdout,
purged overlapping windows, calibration and paired comparisons against both
simple baselines. It must remain outside operational prediction until those
results are independently reviewed.

## Professional responsibility map

Each row names the intended owner and output/consumer. **Foundation** means
only the specific supporting primitive exists, not that the full role is
complete; **Planned** means there is no corresponding implemented component.
Unless otherwise specified, input is the source-specific verified sequence,
consumers are downstream validation and aggregation, and validation means
synthetic fixtures plus independent chronological testing, which remains
outstanding for planned roles. No rows imply staff, executions or model votes.

| ID | Role | Intended method and evidence → consumer | Status |
| --- | --- | --- | --- |
| 1 | Chief Probability Scientist | Probability normalization → aggregation | Foundation: vector validation |
| 2 | Mathematical Statistician | Distribution and sampling tests → validation | Planned |
| 3 | Bayesian Inference Specialist | Prior and posterior digit estimates → models | Foundation: Dirichlet smoothing |
| 4 | Stochastic Process Researcher | Conditional dependence tests → validation | Foundation: transition MI |
| 5 | Probability Distribution Analyst | Distribution shifts → diagnostics | Planned |
| 6 | Applied Mathematician | Immediate and recurrence formulas → prediction | Foundation: supplied-hazard recurrence |
| 7 | Extreme Value Statistician | Rare-event analysis → diagnostics | Planned |
| 8 | Statistical Significance Specialist | Multiplicity-corrected inference → validation | Planned |
| 9 | Information Theory Scientist | Entropy and mutual information → diagnostics | Foundation |
| 10 | Mathematical Optimization Specialist | Out-of-sample parameter optimization → validation | Planned |
| 11 | Chief AI Research Scientist | Model research protocol → governance | Planned |
| 12 | Deep Learning Engineer | Sequential neural model → validation | Planned |
| 13 | Reinforcement Learning Scientist | Out-of-sample reward research → validation | Planned |
| 14 | Transformer Architecture Specialist | Attention sequence model → validation | Planned |
| 15 | LSTM Neural Network Engineer | Recurrent sequence model → validation | Planned |
| 16 | Random Forest Specialist | Tree ensemble → validation | Planned |
| 17 | Gradient Boosting Engineer | Boosted sequence model → validation | Planned |
| 18 | Unsupervised Learning Scientist | Sequence grouping → diagnostics | Planned |
| 19 | Autoencoder Specialist | Reconstruction anomalies → diagnostics | Planned |
| 20 | Meta-Learning Researcher | Source-specific adaptation → validation | Planned |
| 21 | Ensemble Learning Architect | Dependence-aware model combination → aggregation | Planned |
| 22 | Feature Engineering Scientist | Prefix-only sequence features → models | Planned |
| 23 | Online Learning Engineer | Controlled updates after outcomes → models | Foundation: expanding frequency counts |
| 24 | Explainable AI Specialist | Model evidence → explanations | Planned |
| 25 | AI Model Selection Scientist | Out-of-sample selection → aggregation | Planned |
| 26 | Quantitative Research Scientist | Forecast research → validation | Planned |
| 27 | Time-Series Analyst | Temporal structure → diagnostics | Planned |
| 28 | Sequential Pattern Recognition Scientist | Repeated subsequences → diagnostics | Planned |
| 29 | Markov Chain Specialist | Conditional transition models → validation | Research: smoothed first-order model, not independently validated |
| 30 | Hidden Markov Model Researcher | Hidden-state model → validation | Planned |
| 31 | Entropy Analysis Specialist | Entropy monitoring → diagnostics | Foundation |
| 32 | Autocorrelation Researcher | Serial dependence → diagnostics | Planned |
| 33 | Frequency Analysis Scientist | Digit frequencies → diagnostics | Foundation: full-prefix counts |
| 34 | Regime Detection Specialist | Change detection → validation | Planned |
| 35 | Sequence Mining Engineer | Repeated sequences → validation | Planned |
| 36 | Chief Data Architect | Source-isolated schema → pipeline | Foundation: independent IndexedDB ledger |
| 37 | Real-Time Data Engineer | Timestamped live capture → pipeline | Foundation: shared public feed, independent ingestion |
| 38 | Data Pipeline Engineer | Historical and live processing → models | Foundation: live capture and API-only historical import |
| 39 | Database Optimization Engineer | Historical retrieval → pipeline | Foundation: source-indexed browser storage |
| 40 | Data Quality Assurance Engineer | Duplicate, order and precision checks → pipeline | Foundation: heuristic gaps; silent loss not always detectable |
| 41 | Distributed Computing Engineer | Scalable workloads → research | Planned |
| 42 | Cloud Infrastructure Architect | Existing static deployment → delivery | Planned integration |
| 43 | Stream Processing Specialist | Live stream processing → models | Foundation: serialized live processing |
| 44 | Data Compression Specialist | Lossless historical encoding → storage | Planned |
| 45 | Data Provenance Engineer | Source, quote and timestamp → audit | Foundation: persistent source, raw quote, sequence and segment |
| 46 | RNG Research Scientist | Authorized source research → diagnostics | Planned |
| 47 | Pseudorandom Generator Analyst | Authorized implementation analysis → diagnostics | Planned |
| 48 | Cryptographic Randomness Specialist | Security-property assessment → validation | Planned; no security claims |
| 49 | RNG Bias Detection Scientist | Controlled bias tests → validation | Planned |
| 50 | Entropy Source Investigator | Authorized source inspection → diagnostics | Planned |
| 51 | Randomness Test Engineer | Randomness tests → validation | Planned |
| 52 | Generator Fingerprinting Specialist | Source comparisons → diagnostics | Planned |
| 53 | RNG Behaviour Researcher | Stability monitoring → diagnostics | Planned |
| 54 | Digital Forensics Analyst | Sequence integrity verification → audit | Planned |
| 55 | Algorithm Reverse Engineering Specialist | Authorized implementation review → diagnostics | Planned |
| 56 | Next-Digit Prediction Architect | Ten-digit forecast → prediction | Planned |
| 57 | Multi-Model Prediction Engineer | Independent model integration → aggregation | Planned |
| 58 | Conditional Probability Specialist | Context-conditioned estimates → models | Planned |
| 59 | Dynamic Probability Modelling Scientist | Adaptive probabilities → validation | Planned |
| 60 | Short-Window Prediction Analyst | Short-window estimates → validation | Planned |
| 61 | Long-Window Prediction Analyst | Long-window estimates → validation | Foundation: full-prefix benchmark |
| 62 | Multi-Horizon Forecasting Specialist | Recurrence hazards → recurrence engine | Foundation: supplied hazards only |
| 63 | Prediction Confidence Calibration Scientist | Out-of-sample calibration → aggregation | Planned |
| 64 | Uncertainty Quantification Engineer | Probability uncertainty → decision layer | Planned |
| 65 | Predictive Model Fusion Specialist | Reliability/dependence-aware fusion → prediction | Planned |
| 86 | Chief Intelligence Systems Architect | Integrated research outputs → governance | Planned |
| 87 | Predictive Analytics Specialist | Interpretable findings → dashboard | Planned |
| 88 | Data Visualization Engineer | Probability matrix → dashboard | Planned |
| 89 | Real-Time Intelligence Dashboard Developer | Live status → dashboard | Planned |
| 90 | Anomaly Intelligence Analyst | Anomaly evidence → diagnostics | Planned |
| 91 | Prediction Ranking Specialist | Rank probability vectors → research | Foundation; ties are deterministic, not evidence |
| 92 | Model Explainability Analyst | Model evidence → explanations | Planned |
| 93 | Decision Science Specialist | Evidence thresholds → decision layer | Planned |
| 94 | Research Reporting Scientist | Validation report → human review | Planned |
| 95 | Human-Machine Intelligence Specialist | Research review interface → governance | Planned |

Foundation and lifecycle primitives are covered by `tests/super-mathes/`;
those tests are not independent validation of predictive performance.
