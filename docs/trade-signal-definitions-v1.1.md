# Trade Signal definitions v1.1: Model A attribution addendum

**Status: FROZEN v1.1, approved 2026-11-12.** This addendum modifies only the Model A attribution and pool-sweep identity rules in the frozen [v1.0.1 definitions](trade-signal-definitions-v1.md). All other v1.0.1 rules remain in force. The SHA-256 of the unchanged v1.0.1 file is `f4b226cfe8b970b77085d5fcc3288ebb693797f0c9c2c6a975c1cce6a8de5a86`. A v1.1 audit must record both that hash and the SHA-256 of this addendum.

The user approved this tie clarification before Batch 1 results, reference comparisons, or implementation of this rule. This is a new decision resolving an ambiguity, not a claim that v1.0.1 specified tie selection or that production already conforms. Chart-pattern geometry and evidence-family normalization remain deferred; this addendum does not define confidence or change their rules.

## Boundary constituents

For candidate candle `i`, use the 20 bars `[i-20, i-1]`: the spring boundary is their lowest low and the upthrust boundary their highest high. Enumerate every candle in that window whose corresponding price equals the boundary under the engine's exact numeric comparison. The event candle and later candles are excluded.

Test each tied candle independently as an order-3 pivot using v1.0.1's strict-left and non-strict-right inequalities, against the full available candle context, not merely the 20-bar window. Its confirmation index must be at most `i-1`. Retain every tied pivot that independently qualifies and is a constituent of the pool under consideration. Do not select by first, last or nearest index, or count non-pivots. There is no separate earliest-run or minimum-separation rule. The pool level must equal the boundary exactly; proximity to a pool or a tolerance band cannot substitute.

Carry forward the v1.0.1 ambiguity rule verbatim: "If no pool or more than one pool passes, attribution is ambiguous: assign no pool ID, list unattributed candidates, retain the independent spring/upthrust event and count its group once. Do not select by order, ID or proximity."

For a single passing pool, record `poolAttributed: true`, its pool ID, and all qualifying constituent pivot identities. Otherwise record `poolAttributed: false`, no assigned pool ID and the candidate attribution information required by v1.0.1. Preserve this information for replay. A confirmed spring/upthrust may qualify independently of pool attribution.

## Pool-sweep event identity

Pool-sweep evidence for this spring/upthrust requires an independently confirmed and eligible sweep event of the attributed pool. It must match the setup's event group on side, candidate candle, confirmation candle and sweep extreme. Record its sweep event ID; attribution alone is not evidence that such an event exists. An absent, unconfirmed, ineligible, different-pool or different-group sweep supplies no pool-sweep evidence. The setup remains independently eligible when no such evidence exists.

The v1.0.1 next-close confirmation, grouping, invalidation, assignment, retirement and ranking rules continue to apply. This section does not introduce or define a confidence uplift.

## Required attribution fixtures

Cover both spring and upthrust as applicable: multiple tied extrema with all independently qualifying identities retained; two equal extrema within one lookback; two qualifying equal extrema more than one lookback apart; an earliest run bar that fails its pivot test; a pivot requiring the event candle or later candles for confirmation; full-context pivot checks at both window edges; exact versus one-tick-off pool level; no qualifying constituent; more than one passing pool; and future-appended ties. Include same-group confirmed eligible pool sweep, absent or unconfirmed sweep, ineligible sweep, wrong pool, wrong side, wrong candidate or confirmation candle, and wrong sweep extreme. Tests must compare historical decisions without later-candle influence.
