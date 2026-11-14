# Trade Signal: unavailable ATR pool assignment clarification

Pool assignment and creation are unavailable until the rule can be evaluated. A pivot remains recorded as a confirmed pivot, but joins no pool until ATR exists.

Pivots confirmed earlier may take part in clustering from that point forward only. Earlier snapshots are not recomputed. Record a diagnostic when a pivot confirms without ATR.

For the study, use warm-up so ATR is available before the first event window opens, exclude events whose 20-bar window or pool snapshots fall inside warm-up, and report how many events the exclusion removed.

No Batch 1 outcomes were calculated or viewed before this clarification.
