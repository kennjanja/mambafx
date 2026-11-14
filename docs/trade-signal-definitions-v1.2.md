# Trade Signal definitions v1.2: attribution pool lifecycle addendum

**Status: FROZEN v1.2, approved 2026-11-12.** This addendum supplements the unchanged v1.0.1 base and v1.1 Model A addendum. The v1.0.1 SHA-256 is `f4b226cfe8b970b77085d5fcc3288ebb693797f0c9c2c6a975c1cce6a8de5a86`; the v1.1 SHA-256 is `58a441faf5495714d2e22b4136a8eb9431a5be16e63c3bfd54f2dbdac2fb4ab7`. All three hashes identify the v1.2 audit criteria.

## Pool lifecycle at attribution

For a spring or upthrust candidate at index `i`, a pool may be considered for attribution only if it is **active and non-pending at the close of candle `i-1`**, as recorded in that candle's immutable pool snapshot. Its qualifying constituent pivots must have been confirmed by that close. Pools already swept, invalidated or expired, and pools pending a sweep confirmation, are excluded. Never re-read a later pool state to determine attribution. Record the pool's lifecycle state at snapshot time for study output and audit.

This eligibility restriction applies only to pool attribution. A qualifying confirmed spring/upthrust remains independently eligible when no pool qualifies. The other v1.1 exact-level, tied-pivot, multiple-pool, group-identity and sweep-evidence requirements remain in force. A pending sweep is not a statement that its constituent pivots are unconfirmed; constituent confirmation and the pool's pending lifecycle state are separate checks.

Required fixtures include an eligible active non-pending pool and otherwise identical pools that are swept, invalidated, expired or active but pending, with historical snapshot stability after later pool-state changes.

The user selected this interpretation before any Batch 1 outcome results were reviewed. It resolves a material omission in v1.1 rather than claiming the earlier text specified pool lifecycle eligibility. Rationale: attribution should refer to a still-eligible pool at the time of the candidate, rather than a stale or pending pool. No claim is made that the rule measures actual resting orders in a synthetic market.
