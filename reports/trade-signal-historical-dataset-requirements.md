# Historical research dataset requirements

Status: **INCONCLUSIVE** planning specification; availability and
independent market validation are **NOT TESTED**.

Cover `R_10`, `R_25`, `R_50`, `R_75`, `R_100`, `1HZ10V`, `1HZ25V`,
`1HZ50V`, `1HZ75V`, and `1HZ100V` where genuinely available. Record market
availability and separate market-specific feed gaps; never substitute symbols.
Capture genuine timestamped ticks and genuine/causally aggregated closed OHLC
at 60, 180, 300, 900, 1800, 3600 and 14400 seconds for current fixed-profile
and outcome evaluation. Seconds-based future analysis requires genuine ticks,
not invented lower-resolution bars.

Preserve original provider responses, query/pagination metadata, UTC epoch and
units, symbol, price precision, collection time, source license and hashes.
Use sequence IDs when present; multiple ticks sharing a timestamp are not
automatically duplicates. Check ordering, timestamp coverage, precision,
prices, OHLC bounds, candle alignment, duplicate observations, missing
intervals and gaps per market. Report uncertain continuity explicitly and
exclude affected decisions with reasons rather than forward-filling.

Aggregate ticks in UTC epoch buckets; use first/last tick as open/close and
observed extrema as high/low. Exclude forming and potentially partial edge
buckets and never use later ticks in an earlier decision. Check tick-derived
bars against provider candles when both are available. Record whether expiry
uses exact tick, permitted fallback or remains unresolved.

Planning target, subject to availability: 180 calendar days per market plus
enough preceding warm-up for 300 four-hour bars. This is not a claim of
statistical sufficiency. Predefine chronological development, validation and
untouched final-test periods (the prior protocol proposes 60/20/20), embargo
windows crossing boundaries, and use prior data solely as feature warm-up.
Plan sample sizes by desired uncertainty and independent clusters; sparse
models and correlated overlapping predictions require larger samples.

The 1,000-tick, approximately 33-minute R_100 sample is only a technical
fixture. No large dataset was downloaded, no final holdout was examined, and
no backtesting was performed.

## Public history request probe, 2026-11-11

**INCONCLUSIVE:** A public WebSocket probe requested ten R_100 ticks using
`end` about 180 days in the past and no `start`; the response echoed the
requested end but returned ten current ticks, all later than that end. A
one-day-old `end` without `start` behaved similarly. With an explicit
one-hour `start` and `end` around the 180-day-old point, the endpoint
returned 100 R_100 ticks within the requested interval. These are isolated
availability observations, not proof of provider behavior for every request.
Validate returned epochs against every requested range and fail closed on a
mismatch. Do not rely on an echoed request alone.

Two new 1,000-tick *latest* technical fixtures were captured using
`scripts/trade-signal-tick-sample.mjs`: `six-phase-r10-technical-fixture.json`
and `six-phase-1hz100v-technical-fixture.json`. They are not historical
research datasets and have not been independently verified for completeness.
No research partitions or labels were created.
