# §4 browser verification (Candle Charts, all six timeframes)

Run in the in-app browser against `python -m http.server` on the repo. **Synthetic** = seeded random walks
injected into `tfData`; **real** = R_25 ticks (2026-10-13..23, one CSV) aggregated to candles. No live Deriv
connection was used (`tfData` was empty at load, so data was injected).

| Check | Synthetic | Real R_25 |
|---|---|---|
| Candles + overlays render on 60/300/600/1800/3600/14400 | pass | pass |
| Redraw x2 leaves SVG identical (no duplicate layers) | pass | pass |
| Pan/zoom/reset per timeframe; other timeframes unchanged | pass | pass (views differ per tf) |
| Wheel zoom and ctrl-wheel y-zoom touch only their chart | pass | not repeated |
| Zoom-out capped at min(200, candles) | n/a | pass |
| All 15 overlay checkboxes persist after reload | pass | n/a |
| No uncaught errors / NaN in SVG / freezes (6 charts all layers ≈30–70 ms) | pass | pass |
| Lifecycle states potential, forming, developing, confirmed, failed, invalidated, expired render | pass (seeded walks) | not searched |
| Confirmed chart-pattern breaks appear in evidence `break` group | pass | pass ("double-bottom break") |
| Evidence panel labels neutral lists "Bullish/Bearish evidence" when inconclusive | n/a | pass |

Defect found and fixed: the `pe-states` lifecycle selector only filtered zones; chart patterns were always
drawn live-only, so failed/invalidated/expired patterns were never visible. It now applies to chart patterns too
("include ended zones & patterns"). Expired patterns also fall under the render cap (max 4, most recent) and the
viewport window.

Not verified: `pe-states` persistence across reload; historical-overlay correctness against an independent oracle
(only determinism/idempotence of redraw and viewport independence were checked); touch/drag input (wheel and
button paths only); live feed updates.
