# Interview Transcript

## Q1: Vitest Configuration Strategy

**Question:** The spec mentions consolidating into a single vitest config. Vitest 3.2+ supports `projects` (inline workspaces) which lets you define `unit` and `integration` projects in one config and run via `vitest --project integration`. Should we adopt this pattern, or stick with separate config files?

**Answer:** Use Vitest projects (Recommended) — Single vitest.config.ts with named projects. Run with --project flag. Modern approach.

## Q2: Schema Contract Test Approach

**Question:** For the `schema-contract.test.ts` suite, the spec suggests two approaches for verifying indexes and RLS-enabled flags: (a) a test-support RPC that queries pg_indexes/pg_policies, or (b) skip index checks entirely. Which approach do you prefer?

**Answer:** Add schema_info RPC — Create a test-support migration with RPC that queries pg_catalog. More thorough.

## Q3: Seed Failure Handling

**Question:** When `beforeAll` seed data fails, the spec says it should fail loudly. Should seed failures throw immediately (aborting the entire suite), or should each test individually check for seed data and fail with a descriptive message?

**Answer:** Throw in beforeAll (abort suite) — Fast-fail: if seeding fails, no tests run. Clear error at top.

## Q4: Test File Location

**Question:** The existing `rls-policies.test.ts` and `rpc-user-isolation.test.ts` live in `web/__tests__/` (not in `integration/` subdirectory). The spec proposes moving everything to `web/__tests__/integration/`. Should the new files all go in that subdirectory?

**Answer:** All in `web/__tests__/integration/` — Clean separation. Unit tests in `__tests__/`, integration in `__tests__/integration/`.

## Q5: Schema Info RPC Design

**Question:** For the schema_info RPC (test-support migration), should it be a single function returning all metadata (tables, columns, indexes, RLS status), or separate functions per concern?

**Answer:** Up to you — implementer's choice.

## Q6: CI Workflow Changes

**Question:** The spec mentions removing the inline FTS smoke test from CI YAML. Are there any other CI workflow changes beyond what's in the spec?

**Answer:** Just what the spec says — Merge test scripts, remove FTS smoke test, single `npm run test:integration`.

## Q7: Global Setup vs Setup File

**Question:** The existing tests use `describe.skipIf(!canRun)` to handle missing env vars. The spec proposes a global setup that fails fast. Should this be a Vitest `globalSetup` file or a `setupFile`?

**Answer:** globalSetup (runs once) — Check Supabase connectivity once before any test runs. If unavailable, entire suite fails immediately.

## Q8: Edge Cases and Gotchas

**Question:** Are there any edge cases, business rules, or gotchas about the current tests that aren't captured in the spec?

**Answer:** Nothing beyond the spec — The spec captures everything important.
