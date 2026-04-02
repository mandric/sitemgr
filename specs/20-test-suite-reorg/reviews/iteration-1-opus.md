# Opus Review

**Model:** claude-opus-4
**Generated:** 2026-04-02

---

## Overall Assessment

The plan is well-structured and clearly motivated. The four-tier model aligns with the testing philosophy in CLAUDE.md. However, there are several concrete issues that will cause problems during implementation.

## Findings

### 1. Environment Variable Mismatch in `apiFetch` Helper
Plan uses `WEB_BASE_URL` but codebase uses `WEB_PORT`. Should use `http://localhost:${process.env.WEB_PORT ?? '3000'}` for consistency.

### 2. `createTestUserWithToken` Session Null Guard
`client.auth.getSession()` returns `{ data: { session }, error }` — session could be null if sign-in silently failed. Helper should assert non-null.

### 3. Seeding Events via Admin Insert Bypasses App Logic
New API route tests seed events via admin insert, which may miss required fields or constraints. Should reference schema or use API layer.

### 4. `sitemgr-cli-auth.test.ts` Location Is Wrong
File is at `__tests__/sitemgr-cli-auth.test.ts` (top-level), not `__tests__/integration/`. It's static analysis — should stay as unit, not be reclassified to E2E.

### 5. Missing Unit Test Exclusion Ordering
Excluding `__tests__/e2e-cli/**` from the unit project should happen in Section 3, not Section 4, to prevent the unit runner from picking up e2e-cli tests.

### 6. `device-approve-form.test.ts` Needs Specificity
Tests `parseCodeFromUrl` (pure logic, keep) and `approveDevice` (mocks fetch, evaluate). Plan should be specific about the split.

### 7. `supabase-client.test.ts` Contradiction
Spec says "keep", plan says "delete". Resolve explicitly.

### 8. No Test Data Cleanup Strategy for New Tests
Plan should mandate unique user per test file (via `Date.now()` emails) and cleanup in `afterAll`.

### 9. `POST /api/buckets/[id]/test` Untestable Without Config
Plan should specify S3 credentials/endpoint from `getS3Config()` for the bucket connectivity test.

### 10. CI Pipeline Impact
`test:e2e:cli` won't run in CI unless added to CI config or `test:all`. Confirm `test:all` via `vitest run` picks up the new project.

### 11. `test:e2e` vs `test:e2e:cli` Naming
Different runners (Playwright vs Vitest). Document or address.

### 12. `encryption-lifecycle.test.ts` Deletion Risk
Verify `encryption-rotation.test.ts` covers the same key rotation scenarios before deleting.

### 13. Execution Order Step 2 Too Broad
Run only new test files first, not full integration suite, to avoid blocking on unrelated failures.

### 14. `__tests__/unit/` Directory Consolidation
Files exist in both `__tests__/` and `__tests__/unit/`. Plan should state whether to consolidate or leave as-is.
