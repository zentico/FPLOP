---
name: Accuracy snapshot retention
description: Retention rules that keep full-season prediction accuracy intact during projection cleanup.
---

Projection cleanup must preserve every snapshot selected as an Accuracy benchmark, every past-gameweek snapshot whose official result has not been archived yet, and every snapshot that still covers the current or a future gameweek.

**Why:** Accuracy is computed on demand from projection metadata and CSVs. Physically deleting those files erases the forecast evidence needed for full-season comparisons.

**How to apply:** Treat old-starting projections as hidden, not automatically disposable. Only delete snapshots that are fully expired, have archived results for all covered past gameweeks, and are not selected Accuracy benchmarks.