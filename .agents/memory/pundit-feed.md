---
name: Fantasy Football Pundit feed
description: How the redesigned Pundit predictor data is accessed and mapped to official FPL players
---

- The redesigned predictor is a Next.js page whose React Server Component payload embeds one record per player and gameweek. The old published Google Sheet is deprecated and must not be used as the import source.
- **Why:** the sheet no longer matches the redesigned frontend and requires fragile name matching. Every current page record carries FPL `player_code`, and all observed codes mapped uniquely to official bootstrap data.
- `predicted_points` is the assume-starting value. Despite its name, `predicted_points_start` is start-probability-adjusted (for example, 90% produces 0.9× the assume-starting value).
- **How to apply:** fetch the predictor page, decode its embedded records, map `player_code` to official FPL element IDs via bootstrap `code`, and require the page's explicit gameweeks to match FPL's next six-gameweek window.
- FFH session cookies (stored file and the FFH_SESSION_COOKIE secret) expire within ~a week; hybrid imports need the user to paste a fresh appSession cookie in the Import tab.
