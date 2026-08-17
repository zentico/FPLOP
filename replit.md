# FPL Team Optimizer

## Overview
A web app that optimizes a Fantasy Premier League squad using the open-source
[open-fpl-solver](https://github.com/solioanalytics/open-fpl-solver) MILP solver.
Users upload a points-projection CSV (fplreview/solio style: `ID`, `Name`, `Pos`,
`Team`, `Value`, and per-gameweek `N_Pts` / `N_xMins` columns), optionally enter
their FPL team ID (or use first-gameweek mode to build a squad from scratch),
assign chips (Wildcard, Bench Boost, Free Hit, Triple Captain) to future
gameweeks, and run a solve. Results show the optimal plan per gameweek: lineup,
bench order, captain/vice, transfers, and expected points.

## Architecture
- `artifacts/fpl-optimizer` — React + Vite frontend (routes `/`, `/solves/:id`, `/history`).
- `artifacts/api-server` — Express 5 API implementing `lib/api-spec/openapi.yaml`
  (projections upload/list, FPL proxy endpoints, async solve runs).
- `solver/open-fpl-solver` — vendored git clone of the upstream solver, kept
  linked to GitHub; update with `git pull` inside that directory. Do not modify
  its tracked files. Runs on Python 3.14 via `uv` (`uv sync` in that dir).
- `solver/store` — JSON persistence for projection metadata and solve runs;
  `solver/store/runs/<id>/` holds per-run config + solver logs.
- Uploaded projection CSVs are written to `solver/open-fpl-solver/data/<id>.csv`
  (the solver requires data files in its own `data/` dir); results appear in
  `data/results/` and are parsed into JSON by the API server.
- Solves run as spawned `uv run python run/solve.py --config <run config>`
  child processes (15 min timeout); status polled via `GET /api/solves/:id`.
- API codegen: edit `lib/api-spec/openapi.yaml` then
  `pnpm --filter @workspace/api-spec run codegen`. Use `type: number` (not
  `integer`) in the spec — orval emits zod-v4 syntax for integers but the
  workspace pins zod v3.

## User preferences
(none recorded yet)
