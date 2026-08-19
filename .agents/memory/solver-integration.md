---
name: open-fpl-solver integration
description: Constraints for running the vendored FPL MILP solver from the API server
---

- The solver repo at `solver/open-fpl-solver` is a live git clone that must stay unmodified (tracked files) so `git pull` keeps working. Untracked files in its `data/` dir are fine.
- **Why:** the user asked for a permanent link to the upstream GitHub repo.
- **How to apply:** pass per-run options via `--config <json outside repo>`; write uploads only as `data/<id>.csv` (solver requires datasource files inside its own `data/` dir; `datasource` option = filename stem).
- Solver crash `KeyError: 'week'` = time limit expired before any incumbent solution (empty picks table); the wrapper maps this to a friendly "increase secs / shrink model" error — don't treat it as a data bug.
- Result files land in `data/results/<datasource>_<timestamp>_<runid>_<iter>.csv`; identify them by datasource prefix + mtime, not by run id (solver invents its own). Because of this, every run must use a unique per-run datasource (`<projId>-r<runId>`, plain copy when unadjusted) or concurrent runs can steal each other's results.
- Solver needs Python >=3.14 — run through `uv run` (uv auto-provisions the interpreter); system python is 3.13.
- Orval + zod v3 pitfall: `type: integer` in openapi.yaml makes orval emit zod-v4 `zod.int()` which breaks typecheck; use `type: number`. Also avoid mixing path + query params on one operation (duplicate export collision).

**Differential factor:** ownership-adjusted solves write a temp copy of the projection CSV as datasource `<projectionId>-k<runId>` in the solver data dir (deleted after the run); base points are recovered by dividing solver outputs by each player's factor, so both totals stay consistent with xp_cont weighting.

**Pool filter:** "points per match" that matches FFH's user-facing numbers is total projected pts ÷ gameweeks in the projection (NOT per-90 from xMins — per-90 nearly triples the eligible count). Pool filtering reuses the per-run CSV mechanism; quota validation must mirror the exact effective pool (eligible ∪ locked, minus banned) with unrounded ppm.

- Projection CSV master copies must live in the persistent store dir (FPLOP_STORE_DIR volume in Docker), never only in the vendored solver data dir — that dir is baked into the image and wiped on rebuild (symptom: downloads return a JSON 404 saved as csv.json). projectionCsvPath lazy-migrates legacy files.
