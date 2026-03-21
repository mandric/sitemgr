# Section 10: Integration Tests

## Overview

Create integration tests that exercise the media pipeline against real local services — Supabase Postgres and Supabase Storage (S3-compatible). These tests verify that the hardened pipeline works end-to-end with real database operations, real S3 uploads/listings, and real FTS queries.

**Files to create:**
- `web/__tests__/integration/setup.ts` — Shared integration test setup
- `web/__tests__/integration/media-db.test.ts` — Database integration tests
- `web/__tests__/integration/media-s3.test.ts` — S3 integration tests
- `web/__tests__/integration/media-pipeline.test.ts` — End-to-end pipeline tests
- `web/vitest.media-integration.config.ts` — Vitest config for media integration tests

**Files to modify:**
- `web/package.json` — Add `test:media-integration` script

**Dependencies:** Requires section 09 (unit tests) complete, and all implementation sections (01-08).

**Prerequisites to run:** `supabase start` must be running locally.

---

## Test Infrastructure

### Vitest Config

Create `web/vitest.media-integration.config.ts`:

```typescript
// Environment: node
// Include: __tests__/integration/media-*.test.ts
// Timeout: 60000 (60 seconds — S3 operations can be slow)
// Exclude: e2e/, unit tests
```

### Package.json Script

Add to `web/package.json` scripts:
```json
"test:media-integration": "vitest run --config vitest.media-integration.config.ts"
```

### Shared Setup (`web/__tests__/integration/setup.ts`)

The setup module provides:

1. **Supabase clients** — admin client (service role) for test setup/teardown, user client for RLS testing
2. **Test user creation** — Create a test user via Supabase Auth admin API, get their UUID
3. **Cleanup** — Delete test data after each suite

**Reference the existing pattern in `rls-policies.test.ts`** for how this project creates test users and obtains auth tokens for RLS testing. The integration setup follows the same approach.

```typescript
// Exports:
// getAdminClient() — Service role client, bypasses RLS
// createTestUser() — Creates user via auth.admin, returns { userId, client }
// cleanupTestData(userId) — Deletes all test data for a user
// getSupabaseConfig() — Returns { url, anonKey, serviceKey } from local Supabase
```

**How to get local Supabase config:**
```bash
supabase status  # Shows API URL, anon key, service_role key
```

Or read from environment variables that `supabase start` outputs. The existing test infrastructure may already have helpers for this.

---

## Test Files

### 1. Database Integration Tests (`media-db.test.ts`)

These tests hit real Postgres via Supabase PostgREST.

```typescript
// === Full-Text Search ===
// Test: insert event + enrichment → search by description text → verify found
//   Setup: Create event (type: "create", content_type: "photo")
//          Insert enrichment with description "A golden retriever playing in the park"
//   Act: Call search_events RPC with query "golden retriever"
//   Assert: Returns the event with enrichment data

// Test: weighted search ranking — description matches rank higher than tag matches
//   Setup: Event A with description "sunset over ocean", tags: ["nature"]
//          Event B with description "nature walk", tags: ["sunset", "ocean"]
//   Act: Search for "sunset ocean"
//   Assert: Event A ranks higher (description=weight A, tags=weight C)

// Test: filter by content_type + date range + search text
//   Setup: 3 events — photo (today), video (today), photo (30 days ago)
//   Act: Search with content_type="photo" since=yesterday
//   Assert: Returns only today's photo

// === RLS Isolation ===
// Test: user A cannot see user B's events
//   Setup: Create 2 test users, insert event for each
//   Act: Query as user A
//   Assert: Only user A's events returned

// === Stats ===
// Test: stats RPC returns correct counts matching actual data
//   Setup: Insert known number of events by type and content_type
//   Act: Call stats RPCs
//   Assert: Counts match

// === Upsert Bug Fix Verification ===
// Test: upsert watched key → re-upsert with new ETag → verify ETag updated
//   Setup: Insert watched key with etag "abc"
//   Act: Upsert same key with etag "def"
//   Assert: Query returns etag "def" (not "abc" — proves ignoreDuplicates fix works)
```

### 2. S3 Integration Tests (`media-s3.test.ts`)

These tests use Supabase Storage's S3 API.

**Setup:** Create a test bucket in Supabase Storage. The S3 endpoint is typically `http://127.0.0.1:54321/storage/v1/s3` with the service role key as credentials.

```typescript
// Test: create bucket → upload object → list → verify in listing
//   Setup: Create bucket "test-media-integration"
//   Act: Upload a small JPEG, then list objects
//   Assert: Listing includes the uploaded object with correct key, size, etag

// Test: upload multiple objects → paginated listing returns all
//   Setup: Upload 5 objects with different keys
//   Act: List with pagination (if supported)
//   Assert: All 5 objects present

// Test: download uploaded object → content matches original
//   Setup: Upload a known byte buffer
//   Act: Download the same key
//   Assert: Downloaded bytes match original

// Test: list empty bucket → returns empty array
//   Setup: Ensure bucket exists but is empty (or use fresh bucket)
//   Act: List objects
//   Assert: Empty array, no error
```

**Cleanup:** Delete test objects and bucket after each test suite.

**S3 client configuration for local Supabase:**
```typescript
const s3Config = {
  endpoint: "http://127.0.0.1:54321/storage/v1/s3",
  region: "local",
  accessKeyId: serviceRoleKey,
  secretAccessKey: serviceRoleKey,
  forcePathStyle: true,
};
```

### 3. Pipeline Integration Tests (`media-pipeline.test.ts`)

End-to-end tests combining S3 + DB operations. Enrichment is mocked (requires Claude API key).

```typescript
// Test: upload image to Storage → S3 client lists it → create event → verify in DB
//   Setup: Upload test JPEG to Supabase Storage via S3 API
//   Act: Use createS3Client + listS3Objects to find the object
//        Create an event record in the database
//        Upsert watched key
//   Assert: Event exists in DB, watched key exists, search_events returns it

// Test: full pipeline with mocked enrichment → verify event + enrichment → search finds it
//   Setup: Upload test image to Storage
//   Act: List via S3, create event, upsert watched key
//        Mock enrichImage to return known enrichment result
//        Insert enrichment from mock result
//   Assert: search_events("description keywords") returns the event with enrichment
//           FTS ranking works correctly
```

**Why mock enrichment:** Integration tests should be runnable without a Claude API key. The enrichment unit tests (section 09) cover the API interaction. Here we test everything else end-to-end.

---

## Test Data Strategy

### Test Images

Create small test image buffers in code (no fixture files needed):

```typescript
// Minimal valid JPEG (smallest possible)
const TINY_JPEG = Buffer.from([
  0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46,
  0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xFF, 0xD9
]);
```

### Test User Lifecycle

Each test file should:
1. `beforeAll`: Create test user(s) via admin API
2. `beforeEach`: Clean up any test data from previous tests
3. `afterAll`: Delete test user(s) and all associated data

### Unique Keys

Use UUIDs or timestamps in S3 keys and event IDs to prevent test collisions:
```typescript
const testKey = `test-${Date.now()}-${crypto.randomUUID()}.jpg`;
```

---

## Running Integration Tests

```bash
# Ensure Supabase is running
supabase start

# Run integration tests
cd web && npm run test:media-integration

# Run with verbose output
cd web && npx vitest run --config vitest.media-integration.config.ts --reporter verbose
```

**Expected duration:** ~30-60 seconds (database and S3 operations are the bottleneck).

**If tests fail with connection errors:** Verify `supabase status` shows all services running. The S3 endpoint requires the Storage service to be healthy.
