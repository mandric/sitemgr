# Deep-Plan Interview Transcript

## Q1: Job Structure — Same job vs separate jobs?

**Question:** The integration-tests CI job already starts Supabase and sets up env vars. Should we add the vitest integration tests as additional steps in that existing job, or create separate jobs for better isolation and parallel execution?

**Answer:** Same job, new steps. Add `npm run test:integration` and `test:media-integration` as steps in the existing `integration-tests` job. Simpler, reuses the Supabase setup.

## Q2: Failure Mode — Block deploy or non-blocking?

**Question:** If media integration tests fail (e.g., S3 storage flakiness), should they block the deploy, or should they be non-blocking initially?

**Answer:** Block deploy. Test failures must prevent deployment. Strictest mode — nothing ships without passing integration tests.

## Q3: Environment Variables

**Question:** Are there any environment variables or secrets beyond what the existing integration-tests job already sets up?

**Answer:** The integration tests should not need any env vars beyond what `supabase start` provides. The only keys needed are Publishable and Secret. The service role key and anon key names are deprecated and should be removed throughout the codebase (probably out of scope for this task).

## Q4: Key Naming — Rename in this task or defer?

**Question:** Supabase now uses Publishable and Secret keys. Should this task update the integration test setup to use the new key names?

**Answer:** Rename env vars throughout tests — update in this task.

## Q5: Test Execution Order

**Question:** Should DB integration tests run before or after media pipeline tests?

**Answer:** DB first, then media. DB tests are faster (30s timeout), media tests are slower (60s timeout). Fail fast on DB issues.

## Q6: FTS Smoke Test

**Question:** The existing inline FTS smoke test overlaps with vitest media-db tests. Keep both?

**Answer:** Keep it. The inline FTS smoke test stays alongside the new vitest steps.

## Q7: Key Rename Approach

**Question:** For the Publishable/Secret key rename: update env var names in test code or just alias in CI?

**Answer:** Rename env vars throughout tests. Update test configs, setup files, and CI workflow to use the new names.

## Q8: Storage Bucket

**Question:** The CI job creates a `media-uploads` bucket. Is that what media tests expect?

**Answer:** Existing bucket setup is fine.

## Research Finding: Key Names Already Updated

After research, it was discovered that the codebase has **already been updated** to use `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` and `SUPABASE_SECRET_KEY` throughout test files. The CI workflow already maps from Supabase CLI output (`ANON_KEY` → `SUPABASE_PUBLISHABLE_KEY`, `SERVICE_ROLE_KEY` → `SUPABASE_SECRET_KEY`). The rename is effectively done — the remaining work is ensuring the integration-tests job passes these vars correctly and adds the vitest test steps.
