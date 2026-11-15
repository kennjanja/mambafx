# Super Mathes: standalone research module

## Status

Super Mathes is an independent, analysis-only research module with a dedicated
dashboard, source-qualified live capture, browser persistence, two explicitly
selected research models and five-observation records. It never submits trades
or accesses credentials. Neither model is independently validated or promoted,
and no predictive advantage is claimed. Neural/deep-learning models and the
complete 75-role system are **not implemented**.

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
The Cloudflare Worker is not involved.

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
| Historical and walk-forward evaluation | Expanding-window frequency or Markov versus uniform with top-1/2/3, log loss and Brier; no independent holdout, statistical promotion, calibration or recurrence evaluation |
| Dashboard, live integration, history persistence and import | Dedicated navigation, live status, prediction and report history, IndexedDB settings; historical import is API-only |
| Machine learning, hidden-state, neural and generator-forensics research | A first-order Markov model only; neural, hidden-state and generator forensics are not implemented |
| Professional contribution registry | This implementation map only; no runtime professional dashboard or execution tracking |
| Independent validation and production readiness | Not completed; no real-world predictive claims or trade integration |

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

`window.SuperMathes` exposes `status`, `listSources()`, `getSource(source)`,
`listObservations(source, limit)`, `listPredictions(source, limit)`,
`listReports(source, limit)`, `getPrediction(id)`,
`createModelPrediction(windowSize, model)` and `benchmark(windowSize, warmup,
model)`. Model is `"frequency"` or `"markov"`. Advanced callers can use
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
On restart, disconnect, market/source change, invalid input or detected gap,
incomplete five-observation records become **Unscorable**, retaining any
already observed outcomes. Completed records are preserved. Gap detection is
heuristic (more than three times the median after 20 intervals): Deriv's public
tick feed supplies no per-tick sequence number, so silent losses cannot always
be detected or proven absent. Recovery does not assume LDPE backfill proves
continuity. Opening another tab conservatively invalidates unfinished records
on startup and duplicate cross-tab ticks can do the same; concurrent collectors
are not coordinated. Browser storage can be evicted, cleared or blocked; it is
not a server backup. Database errors are reported and acquisition stops if
interruption state cannot be saved.

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
