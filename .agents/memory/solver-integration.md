---
name: open-fpl-solver integration
description: Constraints for running the vendored FPL MILP solver from the API server
---

- The solver repo at `solver/open-fpl-solver` is a live git clone that must stay unmodified (tracked files) so `git pull` keeps working. Untracked files in its `data/` dir are fine.
- **Why:** the user asked for a permanent link to the upstream GitHub repo.
- **How to apply:** pass per-run options via `--config <json outside repo>`; write uploads only as `data/<id>.csv` (solver requires datasource files inside its own `data/` dir; `datasource` option = filename stem).
- Result files land in `data/results/<datasource>_<timestamp>_<runid>_<iter>.csv`; identify them by datasource prefix + mtime, not by run id (solver invents its own).
- Solver needs Python >=3.14 — run through `uv run` (uv auto-provisions the interpreter); system python is 3.13.
- Orval + zod v3 pitfall: `type: integer` in openapi.yaml makes orval emit zod-v4 `zod.int()` which breaks typecheck; use `type: number`. Also avoid mixing path + query params on one operation (duplicate export collision).

**Differential factor:** ownership-adjusted solves write a temp copy of the projection CSV as datasource `<projectionId>-k<runId>` in the solver data dir (deleted after the run); base points are recovered by dividing solver outputs by each player's factor, so both totals stay consistent with xp_cont weighting.
