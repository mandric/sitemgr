# Integration Notes — Opus Review Feedback

## Integrating

### CRITICAL #1: `rls-audit.test.ts` omitted
**Integrating.** Adding it to the deletion list in Section 10. Its unique test cases (append-only enforcement, cross-tenant UPDATE/DELETE blocking, anon INSERT blocking per-table) will be added to `tenant-isolation.test.ts`. The phone_number auth path tests (Finding 4) are obsolete — phone_number auth was removed in migration `20260315000001_simplify_rls.sql`. Policy structure deduplication checks (Finding 7) will be added to `schema-contract.test.ts`.

### CRITICAL #2: `conversations.phone_number` column status
**Integrating.** The `phone_number` column was NOT dropped from conversations — only from bucket_configs. Will document explicitly in Section 3 seed layer and Section 4 schema contract that `conversations` has columns: `user_id, history, updated_at, phone_number` (phone_number is nullable, no longer PK).

### MAJOR #3: Vitest 4.x version
**Integrating.** Will reference Vitest 4.x explicitly in Section 8 and add a note to verify `projects` syntax against 4.x docs.

### MAJOR #4: NULL user_id Group 6 contradictory
**Integrating.** Removing Group 6 from tenant-isolation. NOT NULL constraint is already covered by schema-contract Group 5.

### MAJOR #5: `schema_info()` in production
**Integrating.** Will add explicit security documentation. The function is `service_role` only, returns read-only metadata, and PostgREST does not expose service-role-only functions to authenticated/anon users. This is an acceptable security posture — documenting the decision.

### MAJOR #6: globalThis anti-pattern
**Integrating.** Adding explicit note in Section 5 that `globalThis` UUID pattern is replaced by `SeedResult` return values.

### MAJOR #7: Missing append-only and UPDATE/DELETE tests
**Integrating.** Adding two new groups to tenant-isolation:
- "Append-only enforcement" (no UPDATE/DELETE on events for authenticated users)
- Expanded cross-tenant group to include UPDATE and DELETE operations

### MINOR #8: Cleanup error logging
**Integrating.** Will specify `console.warn` for cleanup errors instead of silent swallowing.

### MINOR #9: globalSetup approach
**Integrating.** Committing to `fetch()` health check, no `provide()`/`inject()`. Tests use `getSupabaseConfig()`.

### MINOR #10: File execution ordering
**Integrating.** Will add `sequence` config to run schema-contract first.

### MINOR #11: Deterministic seed content
**Integrating.** Will specify the ID generation approach.

### MINOR #12: Conversations wording
**Integrating.** Will reword to describe current state, not migration history.

## NOT Integrating

### SUGGESTION #13: setupFile instead of globalSetup
**Not integrating.** The globalSetup is purely a connectivity check — it doesn't need to share state with tests. The simpler `fetch()` approach works well in a separate context. If we later need shared state, we can add a `setupFile` then.

### SUGGESTION #14: Canary test for column additions
**Not integrating.** Asserting the exact column set per table would make tests brittle — every new migration adding a column would require updating the test. The current approach (assert expected columns exist + assert removed columns don't exist) is the right balance.

### SUGGESTION #15: Timeout differentiation
**Not integrating.** A 60s timeout on schema-contract tests doesn't mask slow regressions — these tests are metadata queries that complete in milliseconds. The overhead of per-file timeout configuration isn't worth the complexity.

### SUGGESTION #16: Document conversations.phone_number in research
**Not integrating separately** — addressed by Critical #2 fix in the plan itself.
