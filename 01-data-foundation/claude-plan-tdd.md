# 01-data-foundation — TDD Plan

Testing framework: **Vitest** (globals, node environment, `vi.stubEnv()` for fixtures)
Integration tests: Against local **Supabase** (`supabase start`)
Conventions: Follow existing patterns in `web/__tests__/` — `vi.mock()` for module mocking, `mockFrom` helpers for Supabase client

---

## 2. RLS Security Audit & Optimization

### 2.1 Audit Current Policies

```
# Test: anon user cannot SELECT from events table
# Test: anon user cannot SELECT from bucket_configs table
# Test: anon user cannot SELECT from enrichments table
# Test: anon user cannot SELECT from watched_keys table
# Test: anon user cannot SELECT from conversations table
# Test: anon user cannot SELECT from user_profiles table
# Test: user A cannot SELECT user B's events
# Test: user A cannot SELECT user B's bucket_configs
# Test: user A cannot INSERT event with user B's user_id
# Test: NULL user_id + NULL phone_number does not grant universal access
# Test: phone_number auth path grants access to matching records only
```

### 2.1 (Client Key Audit)

```
# Test: getAdminClient() uses service role key
# Test: getUserClient() uses publishable key with auth context
# Test: queryEvents called via getUserClient returns only user's events
# Test: queryEvents called via getAdminClient returns all events (for background jobs)
```

### 2.1 (SECURITY DEFINER Audit)

```
# Test: get_user_id_from_phone() is not callable by anon role
# Test: get_user_id_from_phone() restricted to authorized callers only
```

### 2.3 RPC Functions & User Isolation

```
# Test: search_events() with user_id param returns only that user's results
# Test: search_events() without user_id param is rejected or returns empty
# Test: stats_by_content_type() with user_id returns only that user's stats
# Test: stats_by_event_type() with user_id returns only that user's stats
# Test: FTS query uses GIN index (EXPLAIN ANALYZE shows Bitmap Index Scan)
```

---

## 3. Encryption System Fix & Validation

### 3.0 Fix Process.env Race Condition

```
# Test: encryptSecret accepts key parameter and encrypts correctly
# Test: decryptSecret accepts key parameter and decrypts correctly
# Test: two concurrent encryptSecret calls with different keys produce correct ciphertext
# Test: encryption-versioned.ts no longer mutates process.env.ENCRYPTION_KEY
```

### 3.1 Key Rotation End-to-End

```
# Test: encrypt with key A, rotate to key B, decrypt old data succeeds via "previous"
# Test: lazy migration re-encrypts data from key A to key B
# Test: after migration, data decrypts with key B only
# Test: removing "previous" key after full migration doesn't break access
# Test: full rotation lifecycle (A→B) preserves all data
```

### 3.2 Legacy Format Migration

```
# Test: ciphertext without label prefix decrypts using "previous" key assumption
# Test: needsMigration() returns true for legacy format ciphertext
# Test: re-encrypting legacy ciphertext produces "current:" prefixed format
# Test: legacy format tried with current key first, then previous, then next
```

### 3.3 Edge Cases

```
# Test: missing ENCRYPTION_KEY_CURRENT throws clear error message
# Test: corrupted ciphertext throws actionable error with diagnostic info
# Test: empty string encrypts and decrypts to empty string
# Test: 10KB plaintext encrypts and decrypts without truncation
# Test: concurrent encrypt/decrypt calls don't interfere (post-fix)
```

### 3.4 encryption_key_version Reconciliation

```
# Test: encryption_key_version column value matches label prefix for "current"
# Test: needsMigration() result aligns with encryption_key_version check
```

---

## 4. Test Coverage Expansion

### 4.1 RLS Policy Test Suite

(Tests defined in Section 2.1 above — this section creates the test file and infrastructure)

```
# Test: test setup creates two distinct authenticated users
# Test: test setup creates test data owned by each user
# Test: test teardown cleans up test users and data
# Test: Supabase client can authenticate as specific test user
```

### 4.2 Migration Test Framework

```
# Test: supabase db reset applies all 8 migrations without error
# Test: all expected tables exist after migration (events, enrichments, watched_keys, bucket_configs, conversations, user_profiles)
# Test: all expected indexes exist after migration
# Test: all expected RLS policies exist after migration
# Test: all expected RPC functions exist after migration
# Test: insert test data, apply next migration, verify data preserved
```

### 4.3 Event Store & Schema Edge Cases

```
# Test: two events with same content_hash can both be inserted
# Test: event with valid parent_id references existing event
# Test: event with invalid parent_id is rejected by foreign key
# Test: events are retrievable sorted by timestamp
# Test: concurrent event inserts don't conflict

# watched_keys collision:
# Test: two watched_keys with same s3_key but different bucket_config_id can coexist (after fix)
# Test: current schema rejects duplicate s3_key (demonstrating the bug)
```

---

## 5. Phone→user_id Migration

### Phase 1: Backfill

```
# Test: records with phone_number and NULL user_id get user_id backfilled
# Test: records with existing user_id are not modified
# Test: unmatched phone numbers (no user_profile) are left as-is
# Test: backfill migration applies without error on empty database
# Test: backfill migration applies without error on database with existing data
```

### Phase 2: Simplified RLS

```
# Test: simplified RLS policies use (SELECT auth.uid()) = user_id pattern
# Test: policies include TO authenticated restriction
# Test: phone_number-only records are no longer accessible (expected after backfill)
# Test: user_id-based access works correctly
```

### Phase 3: Schema Cleanup

```
# Test: user_id is NOT NULL on events, bucket_configs, watched_keys
# Test: insert without user_id is rejected
# Test: conversations primary key is user_id (after migration)
# Test: phone_number columns dropped from tables that don't need them
```

### 5.3 Application Code Changes

```
# Test: insertEvent() includes user_id parameter
# Test: insertEnrichment() includes user_id parameter
# Test: upsertWatchedKey() includes user_id parameter
# Test: agent executeAction() resolves phone to user_id before DB operations
# Test: all query functions include .eq('user_id', userId) filter
```

---

## 6. Event ID Format

```
# Test: newEventId() generates valid ULID format (26 chars, Crockford Base32)
# Test: newEventId() IDs are monotonically increasing within same millisecond
# Test: newEventId() IDs generated 1ms apart sort correctly lexicographically
# Test: old truncated-UUID IDs still work as event primary keys
# Test: no code in codebase assumes specific ID format (search verification)
```

---

## 7. Documentation

(No tests — documentation deliverables verified by review)

```
# Verify: docs/KEY_ROTATION.md exists and covers rotation procedure
# Verify: docs/RLS_POLICIES.md exists and covers each table
# Verify: 01-data-foundation/spec.md updated with schema changes
```
