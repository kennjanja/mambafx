# Trade Signal: deferred pivot pool assignment clarification

This clarification supplements the frozen definitions and the unavailable ATR and sweep/pivot ordering clarifications. No Batch 1 outcomes were calculated or viewed before this clarification was written.

A pivot that confirms while ATR is unavailable remains recorded, but is not assigned to a pool and creates no pool at that time. Record a diagnostic for that pivot.

Let `t*` be the first closed candle with a defined ATR. At `t*`, evaluate sweeps against the preceding-close pool state before assigning pivots. Assign eligible deferred pivots exactly once at `t*`, using the single `ATR[t*]` for every deferred assignment. Process them in original confirmation-time order, breaking ties by pivot bar index and then high before low. Process pivots that confirm at `t*` afterward. Ordinary same-side active non-pending pool clustering and the frozen nearest-pool and earliest-stable-ID tie-break rules apply.

Drop a deferred high pivot from pool assignment if any candle after its confirmation through and including `t*` has `high > pivot.price`; drop a deferred low pivot if any such candle has `low < pivot.price`. Equality is not a trade-through. A dropped pivot remains in the confirmed pivot record but is not assigned or used to create a pool later. Do not invent a swept pool or sweep identity for it.

Pools created from deferred pivots exist only from `t*` onward. Earlier immutable snapshots are never recomputed. The high-before-low ordering is a deterministic implementation convention for equal confirmation time and pivot index; it does not replace the frozen same-side earliest-stable-ID clustering tie-break.
