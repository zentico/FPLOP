---
name: Orval param-type name collisions
description: Why query params on path-param routes break codegen in lib/api-spec
---
When an OpenAPI operation has both path params and query params, orval emits a zod schema `<Op>Params` (path) in api.ts and a TS type `<Op>Params` (query) in types/, and both are re-exported from lib/api-zod/src/index.ts → duplicate-export failure.

**Why:** hit when adding the accuracy detail endpoint; codegen fails only at library typecheck, leaving consumers with missing exports.

**How to apply:** avoid mixing query params with path params on one operation — promote required query params to path segments (e.g. `/thing/{id}/detail/{gameweek}`), or rename the operation if a mix is unavoidable.
