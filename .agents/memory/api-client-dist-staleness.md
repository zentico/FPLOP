---
name: api-client-react dist staleness
description: Consumers that use TS project references resolve stale dist/*.d.ts of the shared API client
---
Artifacts referencing `lib/api-client-react` via tsconfig `references` typecheck against its `dist/*.d.ts`, which can lag behind `src/generated` after codegen. Symptom: "property does not exist" errors for fields present in the OpenAPI spec.

**Why:** the package exports `./src/index.ts` at runtime but composite builds read declaration output.

**How to apply:** after codegen, run `pnpm exec tsc -b lib/api-client-react` before typechecking consumers. Also note generated hooks require an explicit `queryKey` (e.g. `getGetSolveQueryKey(id)`) when passing query options.
