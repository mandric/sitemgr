# Section 03 Code Review: Client Refactor

## IMPORTANT: findEventByHash uses getUserClient but is called from indexing pipeline

`findEventByHash()` is assigned to `getUserClient()` with rationale "Dedup check during user operations". However, it's called during the S3 indexing/sync pipeline (server-side background job), not during a user-facing operation. When RLS SELECT policies are tightened in later sections, the anon role won't see rows, causing silent dedup failures and duplicate events.

**Recommendation:** Switch to `getAdminClient()` or revisit after section-04/08.

## IMPORTANT: No client caching — new client created on every function call

Both constructors call `createSupabaseClient()` on every invocation. Multiple TCP connections and JWT verifications per request. The old code had the same issue. Not introduced by this change, but a missed optimization opportunity.

**Recommendation:** Defer — not in scope for this section.

## SUGGESTION: Whitespace sanitization inconsistency

URL uses `.trim()`, key uses `.replace(/\s+/g, '')`. Inherited from old code. Consider normalizing.

## SUGGESTION: Test with undefined env var, not just empty string

Tests use `vi.stubEnv('KEY', '')` but production failure mode is `undefined`. Both paths work, but `undefined` is more realistic.

## VERIFICATION CHECKLIST
- [PASS] getSupabaseClient removed from all source files
- [PASS] All 10 db.ts functions updated per plan
- [PASS] All 6 core.ts call sites updated to getAdminClient
- [PASS] health/route.ts updated
- [PASS] All 6 unit tests present
- [PASS] Test mocks updated in s3-actions and encryption-lifecycle
- [WARN] findEventByHash client assignment may cause silent failures
