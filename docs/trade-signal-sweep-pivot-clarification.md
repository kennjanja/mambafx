# Trade Signal: sweep and pivot ordering clarification

For a sweep candidate, evaluate each pool against its state at the preceding candle's close before assigning pivots that confirm on the candidate's close. A pivot confirming on the sweeping close is assigned afterward and is not a constituent of that swept pool.

The user decided this rule before its implementation. This standalone clarification was written on 2026-11-12 after the implementation already existed. No Batch 1 outcomes had been calculated or viewed before this file was written. The recorded uncommitted-inclusive source fingerprint to be compared against this clarification is SHA-256 `41db979bff1f3c70706983364efbbc0e5f7a82ae42b5313ea60556fccecfee67` over `src` and `index.html`; it is not a commit hash.
