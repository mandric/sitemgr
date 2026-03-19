# Opus Review

**Model:** claude-opus-4
**Generated:** 2026-03-19T22:50:00Z

---

# Implementation Plan Review: Integration Test Refactor

## Summary

This is a well-structured, thorough plan that addresses a real and important problem (silent test skips masking schema drift). The architecture is sound: consolidating scattered tests into behavior-oriented suites, introducing a shared seed layer, and adding a schema contract test that would have caught the original failure. The plan is strong on rationale, execution ordering, and concrete file/API details.

Below are findings organized by severity.

---

## CRITICAL Issues

### 1. `rls-audit.test.ts` is not mentioned anywhere in the plan

**What:** The file `/home/user/sitemgr/web/__tests__/rls-audit.test.ts` exists in the codebase and contains 30+ `it.todo()` stubs covering anon blocking, cross-tenant isolation, NULL edge cases, SECURITY DEFINER restrictions, policy structure audits, and events append-only enforcement. The plan's "Deleted files" list, the spec's migration table, and the research document all omit this file entirely.

**Why it matters:** This file will remain after the refactor, creating confusion. It has `it.todo()` stubs -- the exact pattern the plan aims to eliminate. Worse, some of its todos cover behaviors NOT in the new suites (e.g., "authenticated user cannot UPDATE own events", "authenticated user cannot DELETE own events" from the append-only group; policy structure deduplication checks). If the unit test project picks it up, it will produce silent todos in CI.

**Fix:** Either (a) add `rls-audit.test.ts` to the deletion list and ensure its unique test cases (append-only enforcement, policy structure deduplication) are incorporated into `tenant-isolation.test.ts`, or (b) explicitly call out that it remains as a backlog tracker and add it to the unit project's exclude list. Option (a) is strongly preferred given the "zero todos" goal.

### 2. `conversations` seed data still uses `phone_number` column

**What:** In Plan Section 5 (tenant isolation), the existing `rls-policies.test.ts` that serves as the template inserts conversations with `phone_number` (line 99-102 of the existing test: `{ phone_number: USER_A_PHONE, user_id: userAId, ... }`). The plan says conversations has `user_id` as the PK after migration `20260315000002`, but does not mention whether `phone_number` still exists as a column on `conversations`.

**Why it matters:** Looking at the migrations, the `conversations` table originally had `phone_number TEXT PRIMARY KEY`. Migration `20260315000002` changed the PK to `user_id` but did NOT drop the `phone_number` column from conversations (it only dropped it from `bucket_configs`). So `phone_number` still exists on `conversations` as a regular column. The plan's `seedUserData()` function (Section 3) does not specify the conversations column list, and an implementer could omit `phone_number` (it may be nullable now) or include it incorrectly. The seed layer must be explicit about what conversations columns to populate.

**Fix:** In Section 3, explicitly document the conversations column list that `seedUserData()` will use: `{ user_id, history, phone_number? }`. Clarify whether `phone_number` on conversations is nullable and whether test data should populate it.

---

## MAJOR Issues

### 3. Vitest `projects` syntax may not match the documented API

**What:** Section 8 says to use "Vitest 3.2+ `projects` feature" and the research document shows the `projects` config syntax. However, the installed Vitest version is `^4.0.18`. The `projects` API syntax may differ between Vitest 3.2 and 4.x -- for example, the `extends` property behavior changed across versions.

**Why it matters:** An implementer following the plan's example config verbatim could get a runtime error if the Vitest 4 API differs from the 3.2 example in the research doc.

**Fix:** Update Section 8 to reference Vitest 4.x specifically and verify the `projects` configuration syntax against the Vitest 4.x docs. At minimum, note the installed version and add a verification step.

### 4. NULL user_id test in tenant-isolation Group 6 is self-contradictory

**What:** Section 5, Group 6 ("NULL user_id handling") says: "Admin inserts an event with `user_id: null` (if possible -- may need to temporarily bypass NOT NULL)" then immediately reverses: "Actually, since `user_id` is now NOT NULL, this test validates the constraint itself."

**Why it matters:** This reads as unfinished design thinking left in the plan. An implementer must guess the intent. Additionally, the plan does not note that the existing `rls-policies.test.ts` NULL safety tests (lines 250-277) already attempt to insert with `user_id: null` -- and those will now fail at insert time due to the NOT NULL constraint (a different failure than the RLS-level invisibility being tested). This is actually now a duplicate of Schema Contract Group 5 (NOT NULL constraint validation).

**Fix:** Remove Group 6 from tenant-isolation. The NOT NULL constraint is already validated in `schema-contract.test.ts` Group 5. If you want to test RLS behavior for hypothetical NULL user_id rows, note that this is no longer testable without bypassing the NOT NULL constraint, which is not worth the complexity.

### 5. `schema_info()` migration ships to production

**What:** Section 1 creates a real Supabase migration (`supabase/migrations/2026MMDD000000_test_schema_info.sql`) that adds a `schema_info()` function. This migration will run in production via the deploy pipeline.

**Why it matters:** A test-support function in production is unnecessary attack surface. Even with `service_role` access control, it exposes schema metadata through PostgREST in production. The plan acknowledges this is "test-support" but does not discuss the production implications.

**Fix:** Either (a) gate the function behind a check (e.g., only create if a specific config flag is set), (b) use Supabase seed files instead of migrations (seeds only run on `supabase db reset`, not `db push`), or (c) accept the production deployment but document the security decision explicitly. Option (b) is problematic because seeds don't run in CI. Option (c) is acceptable if the `service_role`-only grant is deemed sufficient -- but the plan should state this explicitly rather than leaving it implicit.

### 6. `rpc-user-isolation.test.ts` uses hardcoded UUIDs with fallback pattern

**What:** The existing `rpc-user-isolation.test.ts` uses a `globalThis` hack to pass user IDs between `beforeAll` and test functions, and has fallback hardcoded UUIDs that may not exist. The plan (Section 5) says this behavior is merged into `tenant-isolation.test.ts` but does not call out that this anti-pattern must be eliminated.

**Why it matters:** If an implementer copies the existing test structure into the new suite, the `globalThis` hack comes along. The plan should explicitly state that `seedUserData()` returns user IDs in `SeedResult` and tests use those directly.

**Fix:** Add a note in Section 5 that the `globalThis` pattern from `rpc-user-isolation.test.ts` is replaced by `SeedResult` return values.

### 7. Missing `rls-audit.test.ts` test cases not covered by new suites

**What:** Beyond the file omission (Critical #1), the `rls-audit.test.ts` file contains test scenarios that appear nowhere in the new suites:
- "authenticated user cannot UPDATE own events" (append-only enforcement)
- "authenticated user cannot DELETE own events" (append-only enforcement)
- "user A cannot UPDATE user B's events"
- "user A cannot DELETE user B's bucket_configs"
- Anon INSERT blocking (the new plan tests anon SELECT but Section 5 Group 3 only says "Anonymous client tries to insert -> rejected" generically)
- Policy structure deduplication checks

**Why it matters:** These are meaningful security properties. Append-only events in particular is a business invariant worth testing. Dropping them silently contradicts the "zero skipped tests" goal.

**Fix:** Add an "append-only enforcement" group to `tenant-isolation.test.ts` covering UPDATE and DELETE restrictions on events. Add explicit anon INSERT tests. For policy structure checks, either add to schema-contract or document as out-of-scope.

---

## MINOR Issues

### 8. `cleanupUserData` error swallowing hides seed failures in subsequent runs

**What:** Section 3 says `cleanupUserData` "deletes in reverse dependency order with error swallowing." If cleanup fails silently, the next test run's `beforeAll` seed may fail due to stale data from the previous run (e.g., unique constraint violations).

**Why it matters:** Debugging "seed failed: unique constraint" when the real cause is stale cleanup is frustrating.

**Fix:** Log (but don't throw) cleanup errors. Use `console.warn` so they appear in test output without failing the suite.

### 9. `globalSetup.ts` health check approach is underspecified

**What:** Section 2 says "Attempts a health check request to the Supabase REST API" with two different approaches suggested (GET root URL vs. `from("events").select("id").limit(0)`). It also says "Optionally provides the Supabase URL and keys to tests via Vitest's `provide()` mechanism" without committing to whether this is used.

**Why it matters:** The `provide()`/`inject()` decision affects how test files access configuration. If not used, every test file still reads `process.env` directly, which is fine but should be stated.

**Fix:** Commit to one approach. Recommendation: simple `fetch(url)` health check (no Supabase client dependency in globalSetup), and tests continue using `getSupabaseConfig()` from `setup.ts`. State this explicitly.

### 10. Plan does not specify `fileParallelism` interaction with test ordering

**What:** Section 8 sets `fileParallelism: false` for the integration project, meaning test files run sequentially. But the plan does not specify the execution order of the 4 test files. `schema-contract.test.ts` should ideally run first (fail fast on schema drift before spending time on data-heavy tests).

**Fix:** Either set `sequence.files` in the vitest config to control ordering, or note that Vitest runs files in alphabetical order by default (which would give: media-lifecycle, media-storage, schema-contract, tenant-isolation -- not ideal).

### 11. `seedUserData` deterministic content is underspecified

**What:** Section 3 says "Event content is deterministic and unique per user (using userId as seed)" but does not explain the mechanism. UUIDs are not sequential numbers -- how do you derive deterministic test data from a UUID?

**Fix:** Specify the approach: e.g., use a counter or a hash of userId to generate event IDs like `${userId.slice(0,8)}-evt-1`, `${userId.slice(0,8)}-evt-2`.

### 12. Plan references `conversations` having `user_id` migrated "from phone_number PK"

**What:** In Section 4, Group 2, the plan says: "`conversations` has `user_id` as NOT NULL (migrated from `phone_number` PK)." This is accurate for context but confusing as a test assertion description. A test should verify the current state, not the migration history.

**Fix:** Reword to: "`conversations` has `user_id` as NOT NULL and as primary key."

---

## SUGGESTIONS

### 13. Consider a `setupFile` instead of (or in addition to) `globalSetup`

The plan uses `globalSetup` for the Supabase health check. Vitest `globalSetup` runs in a separate context and cannot share state with tests. If you later want the global setup to provide initialized clients or do schema validation once, `setupFiles` (which run in the test worker) would be more flexible. Consider whether `setupFiles` with an early-bail pattern better serves the architecture.

### 14. Add a "canary" test that catches future column additions

The schema contract tests check that expected columns exist and that `phone_number` does NOT exist on `bucket_configs`. Consider adding a reverse check: assert the exact set of columns per table (not just that expected ones exist). This catches column additions that tests don't account for, not just removals.

### 15. Consider timeout differentiation between suites

Section 8 sets a uniform 60s timeout for all integration tests because "the longest suite needs 60s for S3." This means schema-contract and tenant-isolation tests (which don't touch S3) also get 60s, masking slow regressions. Consider per-file timeout overrides or at least a note that this is a known trade-off.

### 16. Document the `conversations.phone_number` column status

The schema section in the research document lists `conversations(user_id NOT NULL PK, history JSONB, updated_at)` but the actual table still has a `phone_number` column (not dropped by any migration). This inconsistency between the research doc and actual schema could mislead the implementer.

---

## What's Done Well

- **Root cause analysis is excellent.** The plan correctly identifies all three structural problems (silent skips, schema drift in fixtures, method-oriented naming) and addresses each with a specific mechanism.

- **The schema contract test is the highest-value addition.** This single suite would have caught the original production failure. Prioritizing it as Section 1/4 is correct.

- **Execution dependency graph is clear and parallelizable.** Sections 4-7 being independent once 1-3 are complete is a good insight that enables parallel implementation.

- **`assertInsert()` wrapper is a smart pattern.** Converting PostgREST error codes into human-readable seed failure messages significantly improves the debugging experience.

- **The migration plan is conservative.** "Delete old files only after new tests pass" (Section 10 being last) prevents the common mistake of deleting tests before replacements are verified.

- **BDD naming convention is well-specified.** The `should ... when ...` pattern with `describe('when [context]')` grouping is clear enough for any engineer to follow.

- **CI changes are minimal and correct.** Merging two test commands into one and removing the redundant FTS smoke test simplifies the pipeline without losing coverage.
