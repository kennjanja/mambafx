# Trade Signal analysis definitions audit - Gate 1

**Status: source review, not independent validation.** This document describes the current working tree, including pre-existing uncommitted changes. It is not an approval of the definitions, a defect-fix authorization, a market-pattern accuracy assessment, or a profitability claim. The user must review and approve or correct these definitions before independent reference implementations or new gold fixtures are built.

Repository: `kennjanja/mambafx`; branch: `feature/sossow-martingale`; HEAD: `7f678505b4c5efdb8db901ec726486340383819e`. Source references below are repository-relative. Unless otherwise stated, numbers are current default settings used by the Trade Signal evidence path; helper functions allow overrides.

## Reading the definitions

- Candle indices refer to the sanitized series, not necessarily the original input. `index` is where an event occurred; `confirmedIndex` is when its rule says it became knowable. Epochs are candle **open** times; a closed candle becomes usable at `epoch + granularity`.
- `buildTradeSignal` requires a finite decision time and positive candle duration and selects only candles ending by that time. Invalid OHLC, non-finite fields and non-increasing epochs are dropped; intervals are not required to be contiguous. ATR is Wilder ATR with period 14, first available at index 13. (`src/analysis/core.js:8-66`, `src/analysis/tradeSignal.js:57-67`.)
- The implementation is deterministic price-action heuristics, not proof of institutional order flow, actual liquidity, Wyckoff phases, predictive power or correct pattern placement. Equality, close-versus-wick treatment, range definition and confirmation delays are conventions to approve, not universal laws.
- Comparisons below describe common educational conventions, not a normative authority. For example, [SMC overview](https://tradingwyckoff.com/en/smart-money-concepts/) describes pools, sweeps, order blocks and imbalances; [Wyckoff Analytics](https://www.wyckoffanalytics.com/wyckoff-method/) places springs and signs of strength in a developed trading range and discusses spread and volume. These sources do not establish numerical thresholds or demonstrate that any market is manipulated.

## 1. Swings, structure and momentum

### Confirmed pivots

`src/analysis/pivots.js:5-68`, `src/analysis/core.js:8-18`, `src/analysis/structure.js:49-60`.

- A pivot high at `p` is strictly higher than each of `n` preceding highs and, with the default non-strict mode, at least as high as each of `n` subsequent highs; lows are the mirror. Strict mode also rejects equal right-side values. Confirmation is at `p+n`, never at `p`; trailing candidates are provisional.
- Internal structure uses `n=3`; swing structure uses `n=10`. Levels, trendlines and premium/discount separately use `n=5`; inducement minor pivots use `n=2`; chart patterns use `n=3`. The same candle can be a pivot at one scale and not another.
- Highs are classified HH/LH/EQH against the prior confirmed high and lows HL/LL/EQL against the prior confirmed low, using exact price comparisons. Those labels are not the ATR-tolerance equal-liquidity clusters below.
- **Convention / decision:** symmetric lookforward confirmation and asymmetric tie handling are precise computational choices, not inherent definitions of a swing. Decide whether right-side ties should qualify and which pivot scale is authoritative for each purpose.

### BOS, CHoCH and MSS

`src/analysis/structure.js:9-60`, `src/analysis/core.js:8-18`.

- Once a confirmed pivot is available, the latest confirmed high and low are each eligible for their first break. The default requires a **strict close** above a high or below a low; a wick alone does not break it. Optional `wick` mode uses high/low instead and resolves simultaneous two-sided breaks using candle direction.
- The first break, or one aligned with the prior recorded trend, is BOS. A break opposite that trend is CHoCH and changes the recorded direction. CHoCH has `mss=true` when same-direction displacement ended on the break candle or either of the preceding two candles. MSS here is a flag on CHoCH, not a separately detected event.
- **Convention / decision:** first break as BOS, no break buffer and this MSS definition are selectable conventions. Some approaches distinguish internal/swing hierarchy or require stronger confirmation. Confirmation here is the breaking candle close, not the broken pivot's original candle.

### Displacement

`src/analysis/displacement.js:3-42`, `src/analysis/core.js:8-18`.

- A non-doji candle qualifies when its body is at least `1.5 * ATR` measured on the preceding bar. Alternatively, three consecutive same-colour candles qualify when the absolute net change from the first open to the last close is at least `2.25 * ATR` measured before the run. A multi-bar event ending where a single-bar event is recorded is suppressed. Direction follows candle/run direction; confirmation is the ending candle.
- **Convention / decision:** ATR/body thresholds are internal proxies for force, not an independently established standard. No requirement for a particular closing location within the wick or actual volume is imposed.

## 2. Liquidity and inducement

### Pools, equal highs/lows and period levels

`src/analysis/liquidity.js:5-96`, `src/analysis/engine.js:12-19`, `src/analysis/core.js:64-66`.

- The engine supplies **internal, order-3 confirmed pivots**. Each high begins a buy-side pool and each low a sell-side pool, even with one touch. A later same-side pivot joins the first active, non-pending pivot pool within `0.25 * ATR` at the new pivot's confirmation; if ATR is unavailable tolerance is zero. The pool level becomes the maximum member high or minimum member low, `equal=true`, with touches incremented. This is first-match incremental clustering, not all-pairs clustering or guaranteed nearest-cluster selection. A pivot pool expires when its age exceeds 300 bars from formation.
- The previous observed UTC day and week high/low are also pools in the next observed bucket; UTC day begins at midnight, week on Monday. The first observed previous bucket is marked partial if its first candle is more than one median observed interval after the bucket start. **Important review question:** the code comments say the periods must directly precede one another, but `referenceLevels` does not test adjacency of bucket IDs; missing whole periods can therefore cause a last-observed period to be called previous. Other missing observations are not comprehensively detected. Partial pools are still created.
- This liquidity path does **not** create separate Asia/London/New York session-high/low pools. Day/week opens in `levels.js` are separate reference opens, not session-liquidity pools.
- **Convention / decision:** equal-level tolerance, single-pivot pools, cluster method, significant-liquidity definition and what to do with incomplete/missing periods need explicit approval. A price level is a hypothesized liquidity area, not observed resting orders.

### Sweeps and consumption

`src/analysis/liquidity.js:97-146`, `src/analysis/inducement.js:20-31`.

- Buy-side sweep candidate: high strictly above the level and close at or below it; sell-side: low strictly below and close at or above. Default confirmation requires the next close to remain inside; an outside close during the pending period yields `sweep-failed` and invalidates the pool. Once confirmed it is marked `swept`. A wick-through with close outside invalidates directly, without a confirmed sweep. Reference pools normally expire at their period change, unless pending.
- Reaction is a separate favorable maximum excursion over the five bars **after confirmation**, divided by ATR at confirmation; it is unavailable until those bars close. This retrospective field must not be used earlier.
- **Important distinction:** Model A receives a significant **sweep-candidate** at the candidate candle, not only a later `sweep-confirmed` event. Significance there means a period pool or equal/multi-touch pool; separate Wyckoff spring/upthrust events can also be significant. This difference from the liquidity evidence item's later confirmation requires user review (`src/analysis/evidence.js:76-85,168-176,215-221`).
- Equality at the reclaim close is allowed in liquidity and inducement; Wyckoff spring/upthrust below uses a strict reclaim. Decide whether those distinctions are intended.

### Inducement

`src/analysis/inducement.js:6-120`, `src/analysis/evidence.js:179-189`.

- A same-direction internal BOS must have a displacement ending on the BOS or within its previous two bars. The protected opposite-side major order-10 pivot must have been confirmed by the impulse start. A subsequent opposite-side order-2 minor pullback pivot must be confirmed after the BOS, not itself an already-confirmed major pivot, and not within `0.1 * ATR` of an already-confirmed same-type major pivot. An opposing internal CHoCH before minor confirmation rejects it.
- After minor confirmation, within 20 bars inclusive, the candle must wick strictly through the minor level and close back at or inside it. Close-through invalidates. Taking the protected level by wick, or an opposing CHoCH, invalidates. A same-direction displacement whose **start is after** the sweep must finish within the next three bars inclusive; it confirms the event. Otherwise the event invalidates after the limit. States are formed, swept, confirmed and invalid.
- Taking a protected level takes precedence in the shared classifier and is labeled significant, not minor. Evidence assigns confirmed inducement a provisional liquidity value of 0.25. **Convention:** this is one explicitly engineered inducement sequence; alternate trader definitions need not require this exact BOS, 20-bar or three-bar timing.

## 3. Zones and mitigation

### FVG and inverse FVG

`src/analysis/zones.js:26-34,78-160`, `src/analysis/fvgQualification.js:3-112`.

- At third candle `j`, bullish FVG is `low[j] > high[j-2]`, bearish is `high[j] < low[j-2]`; size must be at least `0.4 * ATR[j-1]`. Bounds are the two separated wick extremes. Its `createdIndex` is `j-1`, but it is first confirmed at `j`. This is a geometric gap, not proof of unfilled orders.
- After confirmation, wick intersection records a touch and deepest penetration determines fill. A close strictly past the far boundary inverts the parent into an opposite-direction IFVG with identical bounds. A fully wick-filled FVG is not in the terminal set and can subsequently invert. Default age limit is 200 bars; the FVG expiry condition excludes a filled parent.
- Model eligibility is stricter than drawing an FVG: gap/third-candle range at least 0.5; first relevant wick/range and third relevant wick/range each at most 0.35; absolute body-size difference divided by larger body at most 0.2. The first intersecting correction must occur one to three bars after confirmation; depth over 0.5 is deep. Eligible inverse gaps additionally require the parent's qualifying correction, a subsequent inversion, and **the first inverse retest exactly at the decision bar**, without invalidation or expiry.
- Ranking is largest gap/ATR, preferred swing placement, context tier, shallow correction, recency, then ID. Context depends on a confirmed opposite pivot and confirmed same-leg sweep/BOS in at most the preceding ten bars. Confirmed swing placement can become available later and is used only when its confirmation is at or before the requested as-of.
- **Convention / decision:** the 0.4 ATR filter, candle-shape ratios, three-bar correction and first-only inverse retest are implementation-specific restrictions, not a generic three-candle FVG definition. Whether filled FVGs can remain continuation candidates is a key review point.

### Order blocks, breakers, BPR and rejection blocks

`src/analysis/zones.js:10-32,78-138,164-199`.

- An OB candidate is the last opposite-colour candle within ten bars before the displacement's start. Default bounds are the **full high-low wick range**, not body-only. A same-direction internal BOS or CHoCH on the displacement end or within five bars promotes it; absent a break it expires, and a close beyond its far side invalidates it. Same-direction candidates with overlap at least 0.5 of the narrower zone are merged by retaining the existing zone and incrementing its merge count.
- A confirmed OB's close beyond its far side invalidates it and creates an opposite-direction breaker with the same bounds; it does not independently require a prior retest or other structural context. A later qualifying first touch is mitigation; re-entry increments the test count. Default OB/breaker expiry is after 300 bars.
- **Review concern, not yet a reproduced defect:** unlike FVG/IFVG, other zones use a one-sided touch check (`low <= top` for bullish, `high >= bottom` for bearish), rather than requiring candle-range intersection with both boundaries. On a gap past a zone this can record a touch without intersection; ordering against invalidation also matters. Confirm desired semantics with a later minimal fixture.
- Balanced price range is the positive overlap of opposite FVGs formed within ten bars, with 200-bar age. A rejection block is the appropriate wick of an internal confirmed pivot when wick is at least twice the body and at least half the entire candle range; its age limit is 200 bars. There is no separate mitigation-block detector.
- **Convention / decision:** OB wick-versus-body boundaries, displacement/structure qualification, merging, first-touch semantics and whether a breaker requires more than a failed OB are not universally standardized.

### Support/resistance, supply/demand and premium/discount

`src/analysis/levels.js:12-18,33-119`, `src/analysis/evidence.js:89-113`.

- S/R uses order-5 pivots and first matching zone within `0.25 * ATR` at pivot confirmation, setting level to midpoint of member extrema. Its initial role follows the first pivot. It flips after a close past the extrema plus a 0.25 prior-ATR buffer; age over 400 bars since last touch expires it. Score is touches plus half flips minus age/200. The display helper selects the six highest scores before sorting by proximity; evidence separately picks the highest-scored active zone within one ATR.
- **Review concern:** S/R first clusters all confirmed pivots for the supplied series and then walks historical candles for flips/expiry using the resulting zone fields. Existing broad truncation checks remove several mutable fields. Whether this construction reproduces the exact past zone state and level needs a full-state, as-of fixture, not an assumption.
- Supply/demand is the full high-low range of one to three consecutive base candles immediately preceding displacement, each range at most `0.6 * ATR` at that base bar. Confirmation is displacement end; a close beyond the far edge invalidates, intersection counts a test, and age over 300 bars expires.
- Premium/discount takes the most recent confirmed order-5 high and low, uses their midpoint and quartiles, and labels latest close above midpoint premium, below discount, exactly at it equilibrium. The two pivots need not be a manually chosen dealing range.

## 4. Trendlines

`src/analysis/levels.js:12-18,141-174`; `src/analysis/evidence.js:41-143`.

- Lines are made from **every consecutive pair** of confirmed order-5 highs or lows, with anchor indices at least five bars apart. Resistance joins highs; support joins lows. Either slope is allowed. Between anchor indices, any wick crossing the line by more than `1e-9` rejects that pair. Each accepted line starts with two touches.
- From the bar **after the second anchor's confirmation**, a close beyond the line by more than `0.25 * ATR` of the preceding bar marks it broken. Later confirmed same-type pivots within `0.25 * ATR` of the projected line count as touches, up to break confirmation. Missing ATR in touch counting uses infinite tolerance. There is no three-touch minimum or explicit slope-direction rule. New confirmed pivot pairs produce additional lines; there is no separate in-place redraw policy.
- **Review questions:** the validity loop between anchors and the later break loop do not inspect the interval from the second anchor through its confirmation as post-anchor breaks; after confirmation wick-only or smaller body crossings do not invalidate. The requested “not through bodies/wicks” and redraw/stability definitions must be specified. The evidence composer does not directly consume `lv.trendlines` as an evidence item or model event; it uses EMA20/50 for the `trend` item. This is not a claim about every chart rendering surface.

## 5. Wyckoff-style and reaction patterns

`src/analysis/patterns.js:15-24,29-70,350-382`, `src/analysis/tradeSignalArchitecture.js:178-228`.

- Pattern-engine spring: at a candle after a 20-bar lookback, low strictly below the minimum prior low and close strictly above it. Upthrust mirrors the prior high. The event is known on that candle close. Pattern SOS/SOW: close strictly beyond the corresponding 20-bar extreme and absolute body at least `1.5 * ATR` from the preceding candle. Effort-no-result: candle range at least 1.5 prior ATR and body at most 20% of that range; its “effort” is a **range proxy**, not traded volume.
- Model J uses a **separate** fixed-range detector. A range is the prior 20 candles' high/low when width is at most eight times prior ATR, established at current index. SOS/SOW requires a strict close outside and body at least 1.5 prior ATR. Within 30 subsequent bars, LPS requires low at most `range high + 0.25 * prior ATR` and close above that high; LPSY mirrors the low boundary. Close past the opposite range boundary invalidates before a retest. Events carry a common range ID.
- These are price-only approximations: no actual volume, preceding trend, accumulation/distribution phases, multiple boundary tests or contextual validation are required. Wyckoff Analytics discusses more developed ranges and relative volume/spread; neither an actual spring nor its causal narrative is established by the code's label. The pattern-engine SOS/SOW and Model J range events must not be conflated.
- Directional reaction events are any directional candle pattern produced by `candlePatterns`: pin bar (body/range <= 0.35, dominant wick >= twice body and strictly > twice opposite wick, range >= 0.5 prior ATR when available), bullish/bearish engulfing (opposite nonzero bodies, current body encloses and exceeds previous), or three-bar reversal (middle makes a new extreme and final opposite-colour close beyond first candle's opposite extreme). Inside/outside and NR4/NR7 have neutral direction and do not supply reactions. A reaction need not independently be tied to the same zone as the model sequence. (`patterns.js:29-70`, `evidence.js:226-227`.)
- Other chart-pattern geometry, volatility regimes, EMA, Fibonacci, AMD and price/time VWAP/profile proxies are produced by shared modules. In the evidence path, only a **confirmed directional chart-pattern break** in the recent window joins break evidence; range/volume proxies are not actual volume and do not enter the balance. Their full geometry is outside the named Trade Signal entry models and is not independently validated here (`patterns.js:72-347`, `levels.js:123-140,177-275`, `evidence.js:67-74,135-143,266-269`).

## 6. Bias, location and model composition

### Common gates

`src/analysis/evidence.js:24-39,41-143,235-257`, `src/analysis/tradeSignalArchitecture.js:4-26,59-176,231-242`, `src/analysis/tradeSignal.js:19-53,57-139`.

- At least 60 sanitized candles are required for each bias and entry evidence calculation. Included higher-timeframe series must have at least 60 selected closed candles. Evidence is not a probability: per family, the strongest bullish and strongest bearish item are subtracted, normalized using configured source weights, then combined with fixed family weights: structure 1.5, liquidity 1.25, momentum 1.25, location 0.75, zones 1, Wyckoff 0.75, HTF 0.75. A lean requires absolute balance at least 0.35 and at least two net-agreeing groups; HTF disagreement or a conflict with the current swing bias caps the result to inconclusive. An absent HTF is a limitation, not by itself a universal block.
- Profiles are scalp: 15-minute bias, 3-minute entry, 30-minute/1-hour higher context, 3-minute hold; intraday: 30-minute bias, 5-minute entry, 1-hour/4-hour context, 30-minute hold; swing: 1-hour bias, 15-minute entry, 4-hour context, 1-hour hold. These are fixed configurations, not evidence of optimal duration.
- A signal needs a directional **bias-timeframe evidence lean**, no opposing directional entry lean, a same-direction location item, and at least one model candidate. If the entry lean is inconclusive, entry direction falls back to the last entry swing break direction; if it is directional, that lean is used. Thus “entry structure agrees” in model descriptions is not always literally enforced as a separate swing-structure check.
- Location items come from direction-aligned premium/discount, nearby active zones or S/R evidence. For ordinary models the matched event's level must lie within a direction-aligned item's `bottom..top`; for C/I the eligible FVG midpoint must lie there. A descriptive item without finite bounds cannot satisfy that containment check. Premium/discount uses the whole selected range as its bounds, not only the appropriate half.
- Ordered matching selects the earliest event of each type with `confirmedIndex >=` the previous event: **same-bar ties are allowed** unless a model has extra checks. Apart from F, J, C and I's specific relationships, generic matching does not require the events to share a structure, zone ID or maximum sequence age. Reactions are limited to the last two bars relative to decision time for models that use them. These are material questions for independent review, not demonstrated market defects.
- Candidate rank is most matched events, then shared scenario invalidation distance, then model ID and context. Since the composer passes one distance to every candidate, it is not a distinct model-specific invalidation calculation. An opposing entry evidence item newer than the final confirmation removes an earlier candidate; the displayed invalidation comes from the latest confirmed entry swing low/high, not necessarily the model's described block, range, or swept level. Target selection searches entry-timeframe scenarios first, then bias-timeframe scenarios, taking the nearest directionally valid candidate within the first timeframe having one; it is not a global nearest target across both timeframes.

### Actual entry models

All rows assume the common gates above and events confirmed no later than the decision index. Reversal models require the bias direction to match; continuation models additionally require the computed entry direction to match. `trend` context is always supplied by the composer; `range` is added if the event stream contains range establishment, SOS/SOW and LPS/LPSY, with the actual J match additionally requiring a shared range ID.

| Model | Actual ordered conditions and location | Important qualification or ambiguity |
| --- | --- | --- |
| A - liquidity reversal | Significant sweep candidate, same-direction displacement, same-direction CHoCH/MSS; matched sweep level inside aligned location. Tested in swing, range and dealing-range contexts. | Candidate can precede one-bar liquidity sweep confirmation; dealing-range tag uses premium/discount as of sweep. Same-bar ordering and generic cross-event matching apply. |
| B - OB continuation | Displacement, BOS, OB first retest, recent directional candle reaction; retest level inside aligned location. | OB retest event uses `z.bottom` for either direction. A later opposite `ob-break` with exactly the same level blocks it; the generic matcher does not tie displacement/BOS/retest/reaction to one OB ID. |
| C - FVG continuation | Same-direction displacement indexed at the FVG middle candle, matching zone-ID creation and correction, then recent same-direction reaction at or after correction; FVG midpoint inside aligned location. | Requires eligible, shape-qualified FVG and correction within three bars. Displacement confirmation must be no later than gap confirmation. Reaction is not tied by zone ID. |
| D - breaker reversal | Confirmed original OB, its opposite-direction failure, opposite CHoCH, breaker first retest, recent directional reaction; retest level inside aligned location. | Events are not joined by parent OB/breaker ID by generic matching; retest level is zone bottom. |
| F - inducement continuation | One confirmed inducement event contains strictly increasing minor-pivot confirmation, minor sweep, and later displacement; minor level lies in aligned location. | The protected-level and opposing-CHoCH checks are those of the inducement detector before its confirmation; whether later invalidation should block a previously confirmed event needs review. |
| G - BOS pullback continuation | BOS, displacement, broken-level retest, recent directional reaction; retest level in aligned location. | Retests are generated after each BOS when a later candle reaches the level and closes back on the breakout side. Generic matching does not bind the selected retest to the selected BOS by ID or price. |
| I - inverse FVG reversal | Qualified original FVG with a timely correction, inverse close and first inverse retest at the current decision candle; matching inverse zone-ID events and aligned location containing midpoint. | Parent correction and retest rules are stricter than generic inverse-gap identification. No separate reaction event is required. |
| J - Wyckoff continuation | Fixed range, same-range SOS/SOW, same-range LPS/LPSY, all with shared range ID; LPS/LPSY level in aligned location. | Price-only range and breakout rules above; does not establish actual Wyckoff volume or phases. |

Model names and registry text are descriptive; the executable event and gate rules above govern actual qualification. The FVG gate and generic event matcher should be adjudicated against the user's intended rules before any fixes.

## 7. Existing no-lookahead checks and limits

Read-only checks executed on this working tree:

1. `node --test tests\analysis\tradeSignalDetectorTruncation.test.mjs tests\analysis\tradeSignalCandleModelTruncation.test.mjs` - **2 passed, 0 failed**. The component matrix uses seeded and structured synthetic series; it projects away mutable fields including level, status, history, touches and mitigation indices, and excludes unresolved chart-pattern geometries. The candle-rebuilt model matrix covers A, B, C, D, F, G and J, **not I**, with synthetic variants. It is not a proof of complete historical state equivalence or independent pattern correctness.
2. `node --test --test-name-pattern='closed-bar as-of outputs|each profile excludes and ignores mutable forming' tests\analysis\tradeSignal.test.mjs` - **2 passed, 0 failed**. These compare selected synthetic as-of signals and forming-candle mutations for all profiles; they do not prove every market, data gap, detector or model path.

Other inverse-FVG tests exist (`tests/analysis/fvgTrading.test.mjs`), but were not run in this audit and are not a substitute for an I-specific candle-rebuilt truncation matrix. The prior full-suite run recorded 163 files and 1,695 passes in `reports/trade-signal-identity-conflict-suite.txt`; it predates this documentation-only audit and is not a new full-suite run. No production code, existing tests, or trading behavior was changed here.

## 8. Gate 1 decisions requested

Approve or correct, at minimum:

1. Pivot scales, confirmation delays and equal-price tie handling for each detector; exact-close versus wick breaks and MSS semantics.
2. Pool clustering and equal tolerance; single-pivot significance; UTC reference-period completeness, missing periods, and whether named session levels are required.
3. Whether a Model A sweep must be confirmed beyond its candidate candle; equality at reclaim; protected liquidity and inducement timing.
4. Trendline anchor selection, directional slopes, minimum touches, wick/body crossing tolerance, confirmation-interval checks, break buffer and redraw policy.
5. OB candle selection and wick/body bounds, zone intersection and mitigation, merge behavior, breaker requirements, and stale-zone handling.
6. FVG/IFVG size, shape, correction window, fill/inversion and first-retest rules.
7. Whether Wyckoff labels require an established multi-test range, genuine volume, a range proxy, or an explicit “unavailable” classification when volume is absent.
8. Whether model events must refer to the same structural leg/zone/level, whether same-bar ties are allowed, how long events remain valid, and whether model-specific invalidation and cross-timeframe nearest targets are required.

Only after these definitions are approved can independent labels and minimal reproducing cases classify disagreements as objective bugs, reference errors or accepted conventions. No visual review, independent detector validation, historical backtest, optimization, or live/demo trading was performed in this step.
