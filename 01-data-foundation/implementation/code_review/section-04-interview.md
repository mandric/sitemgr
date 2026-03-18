# Section 04 Code Review Interview

## Interview Decisions

### userId parameter optionality
- **Finding:** userId is optional, passing undefined causes silent empty results from Postgres (NULL = FALSE)
- **Decision:** Keep optional with TODO comments at call sites. Full wiring happens in section-08.
- **User chose:** "Keep optional, add TODO comments"
- **Applied:** TODO comments added to core.ts and smgr.ts

## Auto-fixes Applied

### Migration order: DROP before CREATE
- **Finding:** Old search_events overload should be dropped before creating the new one to avoid a window where the insecure function exists
- **Applied:** Moved DROP FUNCTION before CREATE OR REPLACE

### TODO comments at call sites
- **Applied:** Added TODO(section-08) comments at getStats() call sites in core.ts and smgr.ts

## Let go
- FTS index usage test is a smoke test rather than EXPLAIN ANALYZE verification (would need raw SQL execution)
- Missing authenticated-role test for get_user_id_from_phone (anon test covers the critical case)
- globalThis pattern for test data sharing (works, would refactor if test file grows)
- Stats function total/enriched/watched counts not filtered by user_id (not in section scope)
