<!-- PROJECT_CONFIG
runtime: typescript-npm
test_command: npm test
END_PROJECT_CONFIG -->

<!-- SECTION_MANIFEST
section-01-encryption-fix
section-02-rls-audit
section-03-client-refactor
section-04-rpc-user-isolation
section-05-encryption-tests
section-06-rls-tests
section-07-migration-tests
section-08-phone-migration
section-09-event-id
section-10-documentation
END_MANIFEST -->

# Implementation Sections Index

## Dependency Graph

| Section | Depends On | Blocks | Parallelizable |
|---------|------------|--------|----------------|
| section-01-encryption-fix | - | 05 | Yes |
| section-02-rls-audit | - | 03, 04, 06, 08 | Yes |
| section-03-client-refactor | 02 | 04, 06, 08 | No |
| section-04-rpc-user-isolation | 02, 03 | 08 | No |
| section-05-encryption-tests | 01 | - | Yes |
| section-06-rls-tests | 02, 03 | 08 | Yes |
| section-07-migration-tests | - | - | Yes |
| section-08-phone-migration | 02, 03, 04, 06 | 10 | No |
| section-09-event-id | - | - | Yes |
| section-10-documentation | 01-09 | - | No |

## Execution Order

1. section-01-encryption-fix, section-02-rls-audit, section-07-migration-tests, section-09-event-id (parallel — no dependencies)
2. section-03-client-refactor (after 02)
3. section-04-rpc-user-isolation, section-05-encryption-tests, section-06-rls-tests (parallel after their deps)
4. section-08-phone-migration (after 02, 03, 04, 06)
5. section-10-documentation (final — after all others)

## Section Summaries

### section-01-encryption-fix
Refactor `encryption.ts` to accept key as parameter, eliminating the process.env race condition. Update `encryption-versioned.ts` to pass keys directly. Update all callers.

### section-02-rls-audit
Security audit of all RLS policies across 6 tables. Identify authorization gaps, bypass vectors, NULL-condition risks, and SECURITY DEFINER vulnerabilities. Produce findings document.

### section-03-client-refactor
Split `getSupabaseClient()` into `getAdminClient()` (service role) and `getUserClient()` (publishable key with auth). Update all call sites based on audit findings from section-02.

### section-04-rpc-user-isolation
Add `p_user_id UUID` parameter to `search_events()`, `stats_by_content_type()`, `stats_by_event_type()`. Restrict `get_user_id_from_phone()`. Create migration file.

### section-05-encryption-tests
Key rotation end-to-end tests, legacy format migration tests, edge case tests, encryption_key_version reconciliation tests. Comprehensive encryption test suite.

### section-06-rls-tests
Integration test suite running against local Supabase. Test cross-tenant isolation, anon blocking, insert restrictions, phone-based access for each table.

### section-07-migration-tests
Forward migration test framework. Verify all 8 migrations apply cleanly, schema expectations met, data preserved across migrations. Event store edge cases and watched_keys collision test.

### section-08-phone-migration
Three-phase migration: backfill user_id, simplify RLS policies (with performance optimizations), schema cleanup. Update application insert functions. Migrate conversations primary key.

### section-09-event-id
Replace truncated UUID generation with ULID in `newEventId()`. Add `ulid` dependency. Verify no codebase assumptions about ID format.

### section-10-documentation
Key rotation runbook, RLS policy documentation, updated spec.md. Based on findings and changes from all prior sections.
