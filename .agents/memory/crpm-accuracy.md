---
name: CRPM accuracy metric
description: Defines the agreed Cubed Ranking Percentile Miss calculation and ranking populations.
---

CRPM is `sum(|(1 − predicted percentile)³ − (1 − actual percentile)³|)` across all matched players. It is not averaged or multiplied by 100. Lower is better. It is absolute, so both overperformance and underperformance count as misses.

**Why:** Cubing inverse percentiles deliberately gives much greater weight to ranking errors among elite projected players than to similarly sized errors lower in the rankings.

**How to apply:** Use the same average-rank tie handling and populations as ARPM: predicted ranks use the source snapshot, while actual ranks use the complete official FPL player population so incomplete sources remain penalized. In multi-gameweek summaries, add each gameweek's CRPM directly; do not sample-weight or average it again.