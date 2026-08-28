---
name: FantaLens feed
description: How to consume FantaLens' public structured projections (Inertia protocol, gw param, null quirks)
---

FantaLens (fantalens.com) is an Inertia.js app; adapters must use its structured payload, not scraped tables.

- **How:** GET the rendered /squad-planner page once and parse the `<script data-page="app" type="application/json">` blob for the Inertia `version`, horizon and season; then paginate with `X-Inertia: true` + `X-Inertia-Version` headers (JSON responses). A wrong/missing version returns 409.
- Gameweek selection uses a **dash-separated** `gw` query param (`gw=2-3-4…`, not arrays or commas; `gw[]=` 422s, out-of-range values are silently ignored). `per_page` caps at 100 (higher values silently fall back to 25).
- Players carry `external_id` = official FPL id; per-gw `xpts.<gw>.fixtures[]` has `xpts` + `expected_minutes` per fixture (sum for DGWs). `expected_minutes` (and `start_prob`) are **null** for zero-projection fixtures — coerce null→0, don't reject.
- The player universe can shift mid-pagination (total count varied 571→574 between calls); the adapter fails on duplicates/total mismatch and tells the user to retry.

**Also learned:** API response zod schemas treat optional meta fields as `.optional()` (not nullable) — projection metas must omit absent fields, never store `null` (store read path strips legacy nulls).
