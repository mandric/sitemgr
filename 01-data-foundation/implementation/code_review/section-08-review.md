# Section 08 Code Review

## Critical Security Issues

### 1. CRITICAL: executeAction proceeds with null userId — no guard
`resolveUserId` is called but if it returns null, execution continues. For `stats`, `show`, `enrich_status`, and `query`, the code coerces null to undefined, meaning these functions run without user scoping. An unrecognized phone number could read ALL users' data.

### 2. CRITICAL: showEvent never applies the userId filter
`showEvent` accepts `userId?: string` but never calls `.eq('user_id', userId)` on the query. The parameter is accepted and completely ignored.

### 3. HIGH: insertEnrichment and upsertWatchedKey use conditional spread for user_id
After Phase 3, user_id is NOT NULL. If userId is undefined, the insert will fail at the DB level.

### 4. HIGH: indexBucket writes empty string for user_id when null
`user_id: userId ?? ""` writes an empty string which is not a valid UUID.

## Completeness Issues

### 5. HIGH: getBucketConfig retains phone_number fallback that will break after Phase 3
Falls back to `.eq('phone_number', phoneNumber)` which will fail after phone_number column is dropped.

### 6. MEDIUM: smgr.ts cmdQuery and cmdShow pass process.env.SMGR_USER_ID without validation
Could be undefined, but after Phase 3 reads without userId return nothing.

### 7. MEDIUM: WhatsApp route does not handle null resolveUserId
If resolveUserId returns null for a new user, execution continues with null userId.

## Design Issues

### 8. MEDIUM: resolveUserId called twice in WhatsApp flow
The WhatsApp route calls it, then executeAction calls it again internally. Redundant DB query.

### 9. MEDIUM: Three missing test files from the plan
Phase 1/2/3 integration test files not present (integration tests require local Supabase).

### 10. LOW: Test assertions are shallow
Tests verify table name but not that `.eq('user_id', ...)` was called.

### 11. LOW: insertEvent userId is required in EventRow but smgr.ts enrichment paths may not have it
cmdEnrich passes `process.env.SMGR_USER_ID` which could be undefined.
