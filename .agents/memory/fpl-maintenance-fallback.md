---
name: FPL maintenance fallback
description: How manager-team loading should behave during FPL's post-deadline update window.
---

When the official FPL API says “The game is being updated,” manager entry and history endpoints can return 503 even though bootstrap and the latest completed-gameweek picks endpoint still respond normally. Retry temporary failures first; if entry remains unavailable, use the latest completed picks plus bootstrap metadata to prepare the squad and bank.

**Why:** Solve preparation needs the squad and bank, and those remain recoverable during maintenance. Failing the whole solve on the unavailable manager-summary endpoint creates avoidable downtime.

**How to apply:** Keep retries bounded and preserve immediate failures for permanent statuses such as 404. The maintenance fallback may temporarily lack manager name and rank; do not invent them.