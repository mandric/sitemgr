Now I have all the context needed to write the section. Let me produce it.

# Section 1: API Route Integration Tests

## Goal

Write new `fetch()`-based integration tests for five groups of API routes: buckets CRUD, events, stats, enrichments, and health. These tests hit the real Next.js dev server with real Supabase, replacing mock-heavy unit tests that verify call ordering instead of catching real bugs.

This section has no dependencies on other sections and blocks Section 2 (deleting mock-heavy tests requires these integration tests to be green first).

## Prerequisites

- Local Supabase running (`supabase start`)
- Next.js dev server running (auto-spawned by `globalSetup.ts` or manually via `npx next dev`)
- `ENCRYPTION_KEY_CURRENT` set in `.env.local` (required because `POST /api/buckets` encrypts `secret_access_key`)

## Files to Create/Modify

| Action | File Path |
|--------|-----------|
| Modify | `/home/user/sitemgr/web/__tests__/integration/setup.ts` |
| Create | `/home/user/sitemgr/web/__tests__/integration/api-health-route.test.ts` |
| Create | `/home/user/sitemgr/web/__tests__/integration/api-bucket-routes.test.ts` |
| Create | `/home/user/sitemgr/web/__tests__/integration/api-events-routes.test.ts` |
| Create | `/home/user/sitemgr/web/__tests__/integration/api-stats-routes.test.ts` |
| Create | `/home/user/sitemgr/web/__tests__/integration/api-enrichment-routes.test.ts` |

## Tests (These ARE the Deliverable)

The tests themselves are the primary deliverable for this section. Write them first, run them, and confirm they pass against the real dev server.

### Helper: `createTestUserWithToken` (add to `setup.ts`)

Add a new exported function to `/home/user/sitemgr/web/__tests__/integration/setup.ts` that wraps the existing `createTestUser()` and extracts the access token:

```typescript
export async function createTestUserWithToken(email?: string): Promise<{
  userId: string;
  client: SupabaseClient;
  accessToken: string;
}>
```

Implementation notes:
- Call `createTestUser(email)` to get `{ userId, client }`
- Call `client.auth.getSession()` to extract the access token from `data.session.access_token`
- Assert `session` is non-null. Throw a clear error like `"createTestUserWithToken: session is null — sign-in may have failed"` if it is
- Return `{ userId, client, accessToken }`

### Helper: `apiFetch` (local to each test file, or a small shared helper)

A thin wrapper that builds the URL and adds the Bearer token header. Define in each test file or as a small utility in `setup.ts`:

```typescript
function apiFetch(path: string, token: string, init?: RequestInit): Promise<Response>
```

Implementation notes:
- Base URL: `http://localhost:${process.env.WEB_PORT ?? '3000'}`
- Merge `{ Authorization: 'Bearer ' + token }` into `init.headers`
- Return the raw `fetch()` Response (do not parse JSON — let each test decide)

### Test: `api-health-route.test.ts`

```
describe("GET /api/health")
  Test: returns 200 with status "ok" (no auth needed)
    - fetch GET /api/health (no Authorization header)
    - expect status 200
    - expect body to have { status: "ok", service: "smgr", timestamp: <string> }
```

This is the simplest test. No auth, no setup, no cleanup. It validates the dev server is reachable and Supabase connectivity works.

### Test: `api-bucket-routes.test.ts`

```
describe("API bucket routes")
  beforeAll:
    - createTestUserWithToken() → { userId, client, accessToken }
    - also createTestUserWithToken() for a second user (cross-tenant tests)
  afterAll:
    - cleanupUserData(admin, userId) for both users

  Test: POST /api/buckets creates bucket config and returns 201 with id
    - POST /api/buckets with body: { bucket_name, endpoint_url, access_key_id, secret_access_key }
    - Use real-ish values (e.g., bucket_name: "test-bucket-<timestamp>", endpoint_url: "http://localhost:9000")
    - expect status 201
    - expect body.data to have { id, bucket_name, endpoint_url, created_at }
    - Save returned id for subsequent tests

  Test: GET /api/buckets lists created bucket configs for user
    - GET /api/buckets with user's token
    - expect status 200
    - expect body.data to be array containing a bucket with the saved id

  Test: DELETE /api/buckets/[id] removes bucket, subsequent GET returns empty
    - Create a second bucket via POST (to avoid deleting the one used in other tests, or use a dedicated bucket)
    - DELETE /api/buckets/<second-id>
    - expect status 200
    - GET /api/buckets and verify the deleted bucket is gone

  Test: POST /api/buckets/[id]/test returns connectivity result for valid config
    - This test requires the bucket config to have real S3 credentials that point to local Supabase Storage
    - Create a bucket config with values from getS3Config(): endpoint as supabase storage S3 endpoint, access_key_id and secret_access_key from getS3Config()
    - POST /api/buckets/<id>/test
    - expect status 200
    - expect body.data to have connectivity info (success boolean or similar)
    - NOTE: The bucket_name must be a valid existing storage bucket. Use "test-bucket" or whatever local Supabase has. If this test is fragile, test for 200 status code only and document why.

  Test: GET /api/buckets without Authorization header returns 401
    - fetch GET /api/buckets with no Authorization header
    - expect status 401
    - expect body.error to be a string

  Test: DELETE /api/buckets/[id] for another user's bucket returns 200 with no effect
    - Create bucket as user1, attempt DELETE as user2
    - The route uses `.eq("user_id", auth.user.id)` so the delete silently matches nothing
    - Verify the bucket still exists when queried as user1
    - NOTE: The route returns `{ data: null }` with status 200 even when no row matched. The test should verify the bucket was NOT deleted, not check for a 403/404.
```

Important context about the bucket POST route: it calls `encryptSecretVersioned(secret_access_key)` which requires `ENCRYPTION_KEY_CURRENT` to be set in the Next.js server environment. The dev server reads this from `.env.local`.

### Test: `api-events-routes.test.ts`

```
describe("API events routes")
  beforeAll:
    - createTestUserWithToken() → { userId, client, accessToken }
    - createTestUserWithToken() for second user
    - Seed events via admin client: admin.from("events").insert(...)
      Seed 3 events for user1 with known ids, content_hashes, and at least one with a bucket_config_id
      Seed 1 enrichment for one of the events
    - Save event ids, content hashes, bucket_config_id for assertions
  afterAll:
    - cleanupUserData for both users

  Test: GET /api/events returns seeded events for authenticated user
    - expect status 200
    - expect body.data to be array with length >= 3
    - expect each event to have { id, timestamp, type, content_type, content_hash }

  Test: GET /api/events?bucket_config_id=X filters to matching events
    - Use a bucket_config_id that only some events have
    - expect body.data length to match expected count

  Test: GET /api/events?limit=1 returns single event
    - expect body.data to be array of length 1

  Test: GET /api/events/[id] returns event detail
    - Use a known event id
    - expect status 200
    - expect body.data to have the event fields

  Test: GET /api/events/by-hash/[hash] returns matching event
    - Use a known content_hash
    - expect status 200
    - expect body.data to have the matching event (or null if the route returns null for no match)

  Test: GET /api/events without auth returns 401
    - fetch with no Authorization header
    - expect status 401

  Test: GET /api/events/[id] for another user's event returns 404
    - User2's token requesting user1's event id
    - The showEvent function filters by user_id, so it returns null → route returns 404
```

Seeding notes: Use `getAdminClient()` to insert events directly (bypasses RLS). Events require fields: `id`, `timestamp`, `device_id`, `type`, `content_type`, `content_hash`, `user_id`. Use the `seedUserData` helper from `setup.ts` or insert manually for more control over specific field values. If using `seedUserData`, pass `{ eventCount: 3, withEnrichments: true }` but note it generates random-ish ids based on userId prefix. Manual insertion gives more predictable ids for assertions.

### Test: `api-stats-routes.test.ts`

```
describe("API stats routes")
  beforeAll:
    - createTestUserWithToken() → { userId, client, accessToken }
    - Seed events and enrichments via admin client (use seedUserData for convenience)
    - Optionally seed a bucket_config to test filtered stats
  afterAll:
    - cleanupUserData

  Test: GET /api/stats returns correct event and enrichment counts
    - expect status 200
    - expect body.data to have count fields (exact shape depends on getStats implementation)
    - Verify counts match seeded data

  Test: GET /api/stats?bucket_config_id=X returns filtered stats
    - expect status 200
    - expect counts to reflect only events in the specified bucket

  Test: GET /api/stats without auth returns 401
    - expect status 401
```

Note: The exact shape of the stats response depends on the `getStats()` function in `/home/user/sitemgr/web/lib/media/db.ts`. Read that function before writing assertions to know the exact field names (likely something like `{ eventCount, enrichmentCount, ... }`).

### Test: `api-enrichment-routes.test.ts`

```
describe("API enrichment routes")
  beforeAll:
    - createTestUserWithToken() → { userId, client, accessToken }
    - Seed events: some with enrichments, some without
      e.g., 3 events total, 2 with enrichments, 1 without (pending)
    - Use admin client for seeding
  afterAll:
    - cleanupUserData

  Test: GET /api/enrichments/status returns enriched vs pending counts
    - expect status 200
    - expect body.data to have count fields reflecting 2 enriched, 1 pending (or similar)

  Test: GET /api/enrichments/pending returns events without enrichments
    - expect status 200
    - expect body.data to be array containing the unenriched event(s)

  Test: GET /api/enrichments without auth returns 401
    - The enrichments root route is POST-only for creating enrichments
    - If GET is not implemented on /api/enrichments, skip this test or test POST without auth
    - Actually: looking at the route, /api/enrichments only has POST. Test POST without auth returns 401.
```

Important note: The `/api/enrichments` route only exposes `POST` (not `GET`). The TDD plan mentions `GET /api/enrichments` but the actual route file only defines `POST`. Adjust the test accordingly:
- Test `POST /api/enrichments` without auth returns 401 (or use a method that exists)
- The main value is in testing `/api/enrichments/status` and `/api/enrichments/pending` which are GET routes

## Authentication Pattern

All authenticated tests follow this pattern:

1. `createTestUserWithToken()` in `beforeAll` to get `userId` and `accessToken`
2. `apiFetch(path, accessToken)` for each request
3. `cleanupUserData(getAdminClient(), userId)` in `afterAll`

For 401 tests, call `fetch()` directly without the Authorization header (don't use `apiFetch`).

## Test Data Isolation

Each test file creates its own user(s) with unique emails via `createTestUser()` (uses `Date.now()` + random string). Tests must not depend on data from other test files. Clean up all data in `afterAll` via `cleanupUserData()`.

For cross-tenant isolation tests (e.g., user2 cannot see user1's buckets), create two separate users in the same test file.

## Seeding Data

Two approaches, choose per test file:

1. **Via API routes**: Use `POST /api/buckets` or `POST /api/events` with the user's token. This tests the creation routes and is self-documenting. Best for bucket tests.

2. **Via admin client**: Use `getAdminClient().from("events").insert(...)` to seed directly, bypassing RLS. Necessary when you need precise control over field values (specific content_hash, specific ids) or when the creation route doesn't exist. Best for events/enrichments tests where data is read-only.

The `seedUserData()` helper in `setup.ts` can seed a complete dataset (events, enrichments, watched_keys, bucket_configs) in one call. Use it when the default shape is sufficient; insert manually when you need specific values for assertions.

## Running Tests

Run individual test files during development:

```bash
cd /home/user/sitemgr/web
npx vitest run --project integration __tests__/integration/api-health-route.test.ts
```

Run all integration tests once individual files pass:

```bash
cd /home/user/sitemgr/web
npm run test:integration
```