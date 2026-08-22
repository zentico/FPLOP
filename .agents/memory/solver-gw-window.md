---
name: Solver start gameweek
description: The solve window starts at FPL's next gameweek in BOTH modes, never assume GW1
---
The vendored solver starts at FPL's next gameweek even in preseason/first-GW mode (the squad is built at next_gw, not GW 1).

**Why:** Hard-coding GW 1 broke "Any" chip windows (`forced_chip_gws` KeyError) and booked-transfer special-casing once the season moved past GW 1.

**How to apply:** Any server-side constraint keyed to "the first solved gameweek" must use the server-computed `startGw` on the solve request (from FPL's gameweek info), not a literal 1. Also: when running a second solve against the same per-run datasource (e.g. the no-chip baseline for chip evaluation), exclude the first solve's result files explicitly — `findResultFiles` has 5s mtime slack and the runs are seconds apart.
