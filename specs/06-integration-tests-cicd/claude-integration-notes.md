# Integration Notes: Opus Review Feedback

## Integrating

### 1. Correct failure mode narrative (Critical)
**Integrating.** The plan incorrectly claims both suites use `skipIf(!canRun)`. Only DB tests do. Media tests throw on missing keys (or worse, silently fail with empty auth). Will rewrite "Why This Matters" and Section 4 to describe both failure modes accurately.

### 2. Acknowledge `migration-integrity.test.ts` is all `.todo` stubs (Critical)
**Integrating.** Will add a note that this file currently has zero assertions. The test still _runs_ (it appears as pending/todo in vitest output), but it validates nothing. Worth including in CI so future implementations are automatically picked up, but the plan should be honest about what it covers today.

### 3. Consolidate `supabase status` calls (Medium)
**Integrating.** Good catch. Will rewrite the env extraction step to capture JSON once and extract all values from it. Reduces 6+ subprocess calls to 1 + grep for the S3 keys.

### 4. Pick one env var strategy (Medium)
**Integrating.** Will use `$GITHUB_ENV` only (Section 1 approach). Remove step-level `env:` blocks from Sections 2/3. The env var verification step (Section 4) already guards against missing vars. Having them in three places is worse than one authoritative source.

### 5. Note S3 credential divergence (Medium)
**Integrating as documentation only.** The media tests use the service role key as S3 credentials (this works with local Supabase Storage). Changing this would modify test code, which is out of scope. Will add a note in the plan about the divergence.

### 6. Add `passWithNoTests: false` consideration (Low-Medium)
**Partially integrating.** Will note that `migration-integrity.test.ts` has no assertions and recommend adding `passWithNoTests: false` to vitest configs as a follow-up. Won't make it a required part of this implementation since vitest `.todo` tests don't trigger the "no tests" path — they're counted as pending.

## Not Integrating

### 7. Cleanup on failure (Low)
**Not integrating.** The reviewer correctly notes this is acceptable in CI because `supabase stop` (with `if: always()`) destroys the entire instance. This is already how the existing E2E and FTS tests work. No change needed.

### 8. Hardcoded UUIDs (Low)
**Not integrating.** Only relevant for future persistent preview environments, which are explicitly out of scope. The current ephemeral model is fine.

### 9. Test parallelism within suites (Missing)
**Not integrating as a change.** Will verify: the DB integration tests use unique test users per test file (rls uses `rls-test-a@test.local`, rpc uses hardcoded UUIDs). They should be isolated by design. Adding `singleThread` would slow CI unnecessarily. Will add a note about this design assumption.

### 10. Asymmetric patterns (Low)
**Not integrating as a change.** The media tests' lack of `canRun` guard is a different design choice (throw vs skip). Both are valid — the plan should document the difference but not "fix" it. This is out of scope.
