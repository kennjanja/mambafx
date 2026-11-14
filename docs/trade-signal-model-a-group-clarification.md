# Trade Signal: Model A group-level setup clarification

This clarification supplements the frozen Trade Signal definitions. No Batch 1 outcomes were calculated or viewed before this clarification was written.

A confirmed sweep group containing a spring or upthrust and one or more co-swept pools produces one Model A group-level setup carrying their identities, not separate Model A setups for its members. Use the existing group identity `(side, candidate candle, confirmation candle, sweep extreme)` as the stable key. The Model A study counts the spring or upthrust once per event group.

Carrying a co-swept pool as group provenance does not attribute that pool to the spring or upthrust. Exact boundary equality and all other frozen attribution requirements still apply. In particular, a spring with boundary 100 sharing a group with a pool at 99 has `matchCount: 0`, `poolAttributed: false`, and belongs to the study's unattributed group; the 99 pool supplies no pool-sweep evidence for that spring. The v1.1 ambiguity flag retains its frozen meaning, including the zero-match case.

The spring or upthrust must qualify using its own boundary and directional location independently of any different-level co-swept pool. A zone spanning 99 through 101 contains a spring boundary at 100; a location containing 99 but not 100 does not qualify that spring. A separate pool-level setup elsewhere can refer to the same group ID but is outside the Model A spring study and is not an additional Model A setup for the group.

Required fixtures include that 100/99 case and its mirrored upthrust, each yielding one unattributed spring/upthrust setup and recording the different-level co-swept pool. A same-level matching-pool case yields one attributed spring/upthrust setup. All count once per group.
