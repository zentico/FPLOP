---
name: FFH predictions import
description: How the Fantasy Football Hub import works and why it uses a session cookie, not credentials
---

**Rule:** Never try automated password login to Fantasy Football Hub — Auth0 password grant is disabled and the universal login page uses Cloudflare Turnstile that never renders for headless browsers. The working path: user pastes their `appSession` cookie (concatenating `appSession.0`+`appSession.1` chunks) into secret `FFH_SESSION_COOKIE`; server GETs `https://www.fantasyfootballhub.co.uk/auth/access-token` with `Cookie: appSession=<value>` to obtain a bearer token, then calls `https://public-api.fantasyfootballhub.co.uk/league/players` with `limit` (max 100), `minGameweek`/`maxGameweek` (1–38 ok), `minPrice`/`maxPrice`, `sortBy=predictedPoints`, paginating via the `after` query param set to `meta.nextCursor` (the params `cursor`/`offset`/etc. are silently ignored — always verify pages don't repeat).

**Why:** Multiple headless login attempts failed on Turnstile; the cookie approach was agreed with the user and verified end-to-end (568 players imported, solve ran on the data).

**How to apply:** When the import returns 401, the session expired — user must log in in a browser and refresh the secret. Response gives `externalIds.fplId`, price, ownership, `team.shortName`, and per-fixture `predictions.points/minutes` (sum fixtures per GW for doubles). FFH_EMAIL/FFH_PASSWORD secrets exist but are unusable for automation.
