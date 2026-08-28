---
name: Fantasy Football Pundit feed
description: How the Pundit projections feed is accessed and how its columns must be read
---

- The Pundit website (fantasyfootballpundit.com) blocks datacenter IPs with a SiteGround captcha; the predictor table's real data source is a published Google Sheet CSV (URL vendored in the pundit adapter). Fetch the sheet, not the page.
- **Why:** direct scraping fails from Replit; the sheet is the public feed the page itself loads via PapaParse.
- Column semantics: `StartingPredicted` = assume-starting points for the current GW; `GW2`..`GW6` are horizon-relative (2nd..6th gameweek of the window), NOT absolute gameweek numbers. `Predicted`/`GWns` columns are start-probability-adjusted — do not use them for assume-starting snapshots.
- **How to apply:** anchor the window at FPL's next gameweek and always run the cumulative (`NextKGWsStart`) consistency check — it is the only guard against misreading the layout, since the CSV carries no gameweek labels or timestamp.
- FFH session cookies (stored file and the FFH_SESSION_COOKIE secret) expire within ~a week; hybrid imports need the user to paste a fresh appSession cookie in the Import tab.
