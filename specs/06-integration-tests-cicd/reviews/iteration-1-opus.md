# Opus Review

**Model:** claude-opus-4
**Generated:** 2026-03-19

---

## Plan Review: Add Integration Tests to CI/CD Pipeline

### 1. Critical: Media tests do NOT have the `skipIf` guard -- the plan's core narrative is partially wrong

**Section "Why This Matters" and Section 4** frame the entire plan around the `describe.skipIf(!canRun)` silent-skipping risk. But only the DB suite tests (`rls-policies.test.ts`, `rpc-user-isolation.test.ts`) use this pattern. The media tests (`media-db.test.ts`, `media-s3.test.ts`, `media-pipeline.test.ts`) have no `skipIf`/`canRun` guard at all. They import from `setup.ts`, which throws an error in `getAdminClient()` if `SUPABASE_SECRET_KEY` is missing. So the media tests will **hard fail** with missing env vars, not silently skip.

This matters because the plan treats both suites as having the same failure mode. The verification step in Section 4 is still good practice but the justification should be corrected. More importantly, the media tests will fail if `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` is empty (the `setup.ts` fallback is `""`, which will create a client that silently fails on API calls rather than throwing). That is the actual footgun for the media suite -- not silent skipping, but cryptic auth failures.

### 2. Critical: `migration-integrity.test.ts` is entirely `.todo` stubs

The plan in Section 2 lists `migration-integrity.test.ts` as something that "executes" in CI and describes it as verifying "database migrations are consistent." In reality, every test in that file is `it.todo(...)`. Adding this to CI will run zero assertions. The plan should either:
- Acknowledge this and remove it from the "what runs" description, or
- Note that a follow-up is needed to implement the actual tests

As-is, it creates false confidence that migration integrity is being validated.

### 3. Medium: Redundant `supabase status` calls in Section 1

The plan proposes adding two new lines that each call `supabase status -o json | jq -r ...` separately. The existing step already makes 4 such calls (lines 85-88). Adding 2 more means 6 subprocess invocations of `supabase status`. These should be consolidated -- capture the JSON output once into a variable and extract all values from it:

```bash
STATUS_JSON=$(supabase status -o json)
echo "SUPABASE_URL=$(echo "$STATUS_JSON" | jq -r .API_URL)" >> $GITHUB_ENV
echo "NEXT_PUBLIC_SUPABASE_URL=$(echo "$STATUS_JSON" | jq -r .API_URL)" >> $GITHUB_ENV
# ... etc
```

This is not just a style nit -- `supabase status` spins up a Docker API query each time, and flaky Docker socket connections in CI could cause intermittent failures on any of those calls.

### 4. Medium: Section 2 and 3 env vars are redundant with Section 1

Section 1 adds the `NEXT_PUBLIC_*` vars to `$GITHUB_ENV`. Sections 2 and 3 then set them again as explicit step-level `env:` blocks. The plan justifies this as "makes the dependency clear and prevents silent skipping if an earlier step changes." But this creates a maintenance hazard -- if the variable names change, they need to be updated in three places. More concerning: the step-level `env:` in Section 2/3 references `${{ env.SUPABASE_URL }}` etc., which are the non-prefixed versions. If Section 1's changes were ever reverted or failed, the step-level env would still work (it maps from the non-prefixed vars). But then Section 1 is doing nothing. Pick one approach: either use `$GITHUB_ENV` (Section 1) or explicit step-level `env:` (Sections 2/3), not both.

### 5. Medium: S3 credential mismatch for media tests

The plan says in Section 3: "The `setup.ts` shared helper constructs S3 credentials from the Supabase service key directly, so no additional S3 env vars are needed." Looking at `setup.ts` line 84, `getS3Config()` uses `SUPABASE_SERVICE_KEY` as both `accessKeyId` and `secretAccessKey`. But the existing CI workflow (lines 90-93) extracts **separate** S3 access/secret keys using `supabase status | grep "Access Key"`.

This means the media tests use a different authentication path for S3 than the rest of the CI pipeline. If Supabase Storage ever tightens S3 auth to require proper S3 credentials (not the service role key), the media tests will break. The plan should at minimum note this divergence, and ideally the tests should use the same S3 credentials the CI already extracts (`S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`).

### 6. Low-Medium: No assertion count verification

Section 4 adds a pre-flight check for env vars, which is good. But it does not verify that tests actually **ran assertions**. Vitest can be configured with `passWithNoTests: false` (which may or may not be set in the integration configs -- I checked and it is not). A stronger safeguard would be to add `--passWithNoTests=false` to the npm scripts or vitest configs, and/or parse the vitest output to confirm a non-zero test count. Given that `migration-integrity.test.ts` is all `.todo` stubs, this is already a live issue.

### 7. Low: Cleanup not guaranteed on test failure

`setup.ts` provides `cleanupTestData()` but the media tests call it in `afterAll`. If a test crashes or times out hard, `afterAll` may not run, leaving test users and data in the Supabase instance. In CI this is fine because the whole Docker environment is destroyed. But the plan should note that this is acceptable **only because** the "Stop Supabase" step has `if: always()`. If anyone lifts this pattern into a persistent environment (preview), stale test data will accumulate.

### 8. Low: RPC test uses hardcoded UUIDs inserted directly

`rpc-user-isolation.test.ts` (line 28-29) uses hardcoded UUIDs (`00000000-0000-0000-0000-000000000a01`, `...0b02`). If two CI runs ever share the same Supabase instance (e.g., in a future persistent preview environment), these will collide. Not a problem today with ephemeral `supabase start`, but worth noting as a landmine for when preview environments are added.

### 9. Missing: No consideration of test parallelism within suites

The plan does not mention whether vitest runs tests in parallel within each suite. The DB integration tests create and delete users, modify RLS-protected rows, etc. If `rls-policies.test.ts` and `rpc-user-isolation.test.ts` run in parallel (vitest's default), they could interfere with each other since they share the same Supabase database. Check whether `vitest.integration.config.ts` sets `pool` or `maxConcurrency`, or whether the tests are designed to be isolated. Currently the config does not set any concurrency options, meaning vitest will parallelize by default.

### 10. Architectural: Plan says "test code -- no changes" but this may be wrong

The plan's "What Does NOT Change" section states "No changes to test files (env var names already correct)." The env var names in the test files do match the `NEXT_PUBLIC_*` prefix pattern. However, given that `migration-integrity.test.ts` is all stubs, this should be called out. Also, the media tests' lack of a `canRun` guard (unlike the DB tests) creates an inconsistent pattern. If the plan is meant to be the complete picture, it should note these asymmetries even if it chooses not to fix them.

### Summary of Recommendations

| Priority | Issue | Action |
|----------|-------|--------|
| Critical | `migration-integrity.test.ts` is all `.todo` | Remove from "what runs" description or implement tests first |
| Critical | Media tests don't have `skipIf` -- plan mischaracterizes failure mode | Correct the narrative; note they throw, not skip |
| Medium | 6 separate `supabase status` subprocess calls | Consolidate into single JSON capture |
| Medium | Dual env var strategy (GITHUB_ENV + step-level) creates maintenance burden | Pick one approach |
| Medium | S3 auth divergence between `setup.ts` and CI | Document or align |
| Medium | No `passWithNoTests: false` to catch zero-assertion runs | Add to vitest configs |
| Low | Test parallelism not considered for DB suite | Verify isolation or set `singleThread: true` |
