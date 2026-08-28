---
name: Weighted projection blends
description: Invariants for blending saved projection snapshots into one solver input
---

- Blends are materialized as immutable saved snapshots (source "blend") at solve start; component ids + normalized weights live on the snapshot meta and on the recorded solve request. Never blend on the fly at solver time.
- **Why:** reproducibility — component snapshots can be deleted/reimported later, and previews must equal the solver's exact CSV.
- **How to apply:** blend previews must round values exactly as the canonical CSV serializes them (points 2dp, minutes rounded) or preview and solve diverge. Missing players contribute zero from that source — weights are never redistributed per player. Ownership column is dropped unless every component has it, so the differential factor can't silently use zeros. Horizon = consecutive run from the earliest shared gameweek of the intersection.
