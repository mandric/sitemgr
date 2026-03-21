# Section 03: Shared Seed Layer (setup.ts Extensions)

## Overview

Extend the existing `web/__tests__/integration/setup.ts` with three new functions: `seedUserData()`, `assertInsert()`, and `cleanupUserData()`. These become the single source of truth for table column definitions and test data creation.

## Context

The existing `setup.ts` (95 lines) exports: `getSupabaseConfig()`, `getAdminClient()`, `createTestUser()`, `cleanupTestData()`, `getS3Config()`, `TINY_JPEG`. Currently, each test file maintains its own inline seed data — when the schema changed (phone_number dropped from bucket_configs), test fixtures drifted from the actual schema.

The current `cleanupTestData()` function handles deletion in dependency order but each test file has its own seed insertion logic with different column assumptions. The new `seedUserData()` centralizes this.

## What to Build

### Function: `seedUserData(admin, userId, opts?)`

Creates a complete dataset for one test user. Inserts in dependency order.

**Signature:**
```typescript
interface SeedOptions {
  eventCount?: number;        // default: 2
  withEnrichments?: boolean;  // default: true
  withWatchedKeys?: boolean;  // default: true
  withBucketConfig?: boolean; // default: true
  withConversation?: boolean; // default: true
  withUserProfile?: boolean;  // default: true
}

interface SeedResult {
  userId: string;
  eventIds: string[];
  enrichmentIds: string[];
  watchedKeyIds: string[];
  bucketConfigId: string | null;
  conversationUserId: string | null;
}

async function seedUserData(
  admin: SupabaseClient,
  userId: string,
  opts?: SeedOptions
): Promise<SeedResult>
```

**Column definitions (THE single source of truth):**

| Table | Columns Used in Seed |
|-------|---------------------|
| `user_profiles` | `id, phone_number` |
| `events` | `id, timestamp, device_id, type, content_type, content_hash, user_id` |
| `enrichments` | `event_id, description, objects, context, tags, user_id` |
| `watched_keys` | `s3_key, first_seen, event_id, etag, size_bytes, user_id` |
| `bucket_configs` | `user_id, bucket_name, endpoint_url, access_key_id, secret_access_key` |
| `conversations` | `user_id, history` (phone_number is nullable, omit in seed) |

**Deterministic ID generation:**

Use counter-based IDs derived from the userId to enable predictable assertions:
- Event IDs: `${userId.slice(0,8)}-evt-1`, `${userId.slice(0,8)}-evt-2`, etc.
- Use `assertInsert()` for each insert operation

**Insertion order:**
1. `user_profiles` (needed by foreign key-like conventions)
2. `events` (needed by enrichments and watched_keys)
3. `enrichments` (references event_id)
4. `watched_keys` (references event_id)
5. `bucket_configs` (standalone, references user_id)
6. `conversations` (standalone, references user_id)

### Function: `assertInsert(description, result)`

Wraps a Supabase insert/upsert result and throws with full error context on failure.

**Signature:**
```typescript
function assertInsert(
  description: string,
  result: { error: { message: string; code?: string; details?: string } | null }
): void
```

**Behavior:**
- If `result.error` is null, return silently
- If `result.error` exists, throw:
  ```
  Seed failed: "${description}" — ${error.message} (${error.code || 'unknown'})
  Details: ${error.details || 'none'}
  ```
- Include PostgREST error code when available (e.g., `PGRST204` for missing column)

### Function: `cleanupUserData(admin, userId)`

Enhanced version of existing `cleanupTestData()`.

**Behavior:**
- Delete in reverse dependency order: enrichments → watched_keys → events → bucket_configs → conversations → user_profiles → auth.admin.deleteUser()
- On cleanup error: `console.warn('Cleanup warning: ${table} delete failed for user ${userId}: ${error.message}')` — do NOT throw
- Handle partial seeds: if a table has no matching rows, that's fine (not an error)
- Handle missing auth user: if `deleteUser()` fails, warn but continue

### Existing Exports (Keep Unchanged)

- `getSupabaseConfig()` — URL, anonKey, serviceKey from env
- `getAdminClient()` — service role client
- `createTestUser(email?)` — creates auth user, signs in, returns `{ userId, client }`
- `getS3Config()` — S3-compatible endpoint config
- `TINY_JPEG` — 23-byte minimal JPEG buffer

## Tests to Write First

Since these are test infrastructure functions, test them against a live local Supabase:

- Test: seedUserData creates expected number of records in each table
- Test: seedUserData with default options creates 2 events, enrichments, watched_keys, 1 bucket_config, 1 conversation
- Test: seedUserData with `eventCount: 0` creates no events or dependent records
- Test: seedUserData with `withBucketConfig: false` creates no bucket_config
- Test: seedUserData returns SeedResult with correct IDs
- Test: seedUserData for two different users creates non-overlapping data (no ID collisions)
- Test: assertInsert passes silently on success (null error)
- Test: assertInsert throws with descriptive message on failure (includes description and error code)
- Test: cleanupUserData removes all seeded records
- Test: cleanupUserData handles partial seeds without throwing
- Test: cleanupUserData logs warnings (not throws) on cleanup errors

## Files to Create/Modify

| File | Action |
|------|--------|
| `web/__tests__/integration/setup.ts` | MODIFY — add seedUserData, assertInsert, cleanupUserData |

## Acceptance Criteria

1. `seedUserData()` inserts records in correct dependency order
2. Column lists match current schema (no phone_number on bucket_configs, conversations omits phone_number)
3. Deterministic IDs enable predictable test assertions
4. `assertInsert()` produces clear error messages with PostgREST error codes
5. `cleanupUserData()` logs but doesn't throw on cleanup failures
6. Existing exports remain unchanged (backward-compatible)
7. All new functions are exported from setup.ts
