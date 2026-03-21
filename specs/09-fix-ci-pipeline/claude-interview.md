# Interview Transcript — 06-fix-ci-pipeline

## Q1: Priority & Shipping Strategy

**Q:** The spec identifies 5 fixes. Are there any priority ordering preferences? Should the E2E timeout fix be deployed independently, or should all 5 fixes ship together?

**A:** All 5 fixes in one PR — single atomic commit/PR with all fixes together.

## Q2: Dangling Handle Cleanup Scope

**Q:** For the dangling handle fix: should we add client cleanup only to tenant-isolation.test.ts (the file mentioned in the spec), or apply it consistently across all 4 integration test files?

**A:** All integration test files — add Supabase client cleanup to media-lifecycle, media-storage, and schema-contract too.

## Q3: E2E beforeAll Timeout Strategy

**Q:** For the E2E beforeAll timeout: should we add the timeout specifically to the beforeAll in agent.spec.ts, or also add a global timeout configuration in playwright.config.ts?

**A:** Per-test timeout only — add timeout parameter to test.beforeAll() in the Playwright test file.

## Q4: RPC Function Grant Strategy

**Q:** For the RPC function grants: research shows Supabase auto-grants EXECUTE to authenticated/anon by default. Should we add them defensively, or just fix the test assertion since it works already?

**A:** Rely on Supabase defaults — no new migration needed, only fix the test assertion.

## Q5: CI .env.local Generation

**Q:** For the .env.local heredoc fix in ci.yml: did you already convert this to printf, or should the plan include this conversion?

**A:** printf is fine (already done) — no change needed for this item.

## Q6: search_events Assertion Fix Strategy

**Q:** For the search_events assertion fix in tenant-isolation.test.ts: since user_id isn't in the return type, what should the assertion use instead?

**A:** Match by event ID — assert using event ID like media-lifecycle.test.ts does.
