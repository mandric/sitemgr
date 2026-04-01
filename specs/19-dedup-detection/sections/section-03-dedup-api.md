Good, I can see the pattern for getting access tokens. Now I have everything needed to write the section.

# Section 3: Dedup API Route

## Overview

This section adds a new `GET /api/dedup?bucket_config_id=X` API route that returns duplicate file groups for a given bucket. It authenticates via Bearer token (same pattern as all other API routes), calls the `findDuplicateGroups` db function (from section 02), and returns the grouped results.

## Dependencies

- **Section 02 (Dedup RPC)** must be implemented first. This section uses the `findDuplicateGroups()` function and `DuplicateGroup` interface from `web/lib/media/db.ts`, and the underlying `find_duplicate_groups` RPC function in Supabase.

## Tests (Write First)

### Integration Tests

**File: `web/__tests__/integration/dedup-api.test.ts`**

These tests run against the real Next.js dev server and local Supabase. The dev server is auto-started by globalSetup.

```typescript
/**
 * Integration tests for GET /api/dedup route.
 *
 * Runs against real local Supabase and the Next.js dev server.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getAdminClient,
  createTestUser,
  cleanupTestData,
} from "./setup";

const APP_URL = process.env.SMGR_WEB_URL ?? `http://localhost:${process.env.WEB_PORT ?? "3000"}`;
```

Four test cases:

1. **`GET /api/dedup?bucket_config_id=X` with valid auth returns `{ data: { groups, total_duplicate_groups } }`**
   - Create a test user and sign in to get an access token via `userClient.auth.getSession()`
   - Seed a `bucket_configs` row for the user via the admin client
   - Insert 3 events with the same `content_hash` (e.g., `etag:testdup123`) and `type: 'create'` for that user and bucket
   - Insert 1 event with a unique hash (no duplicate)
   - Call `GET /api/dedup?bucket_config_id={id}` with `Authorization: Bearer {access_token}`
   - Expect status 200
   - Expect response body `data.groups` to be an array with 1 entry (the group of 3)
   - Expect the group to have `content_hash: "etag:testdup123"`, `copies: 3`, `event_ids` (array of 3), `paths` (array of 3)
   - Expect `data.total_duplicate_groups` to be 1

2. **`GET /api/dedup` without `bucket_config_id` returns 400**
   - Authenticate as a valid user
   - Call `GET /api/dedup` (no query param)
   - Expect status 400
   - Expect response body to contain an `error` field

3. **`GET /api/dedup` without auth returns 401**
   - Call `GET /api/dedup?bucket_config_id=anything` with no `Authorization` header
   - Expect status 401

4. **`GET /api/dedup?bucket_config_id=X` where X belongs to another user returns empty results**
   - Create two test users (userA, userB)
   - Seed a bucket config and duplicate events for userA
   - Get userB's access token
   - Call `GET /api/dedup?bucket_config_id={userA_bucket_id}` with userB's Bearer token
   - Expect status 200
   - Expect `data.groups` to be an empty array (RLS prevents userB from seeing userA's events)
   - Expect `data.total_duplicate_groups` to be 0

**Setup and teardown pattern:**
- Use `createTestUser()` from `./setup` to create users
- Use `getAdminClient()` to seed bucket configs and events (bypassing RLS for setup)
- Use `cleanupTestData(userId)` in `afterAll` to clean up
- Get the access token via `userClient.auth.getSession()` then `session.access_token`
- Make HTTP requests with `fetch(url, { headers: { Authorization: \`Bearer \${token}\` } })`

## Implementation

### New File: `web/app/api/dedup/route.ts`

Create a new API route handler following the exact pattern used by `web/app/api/stats/route.ts`.

The route handler:

1. Exports an async `GET` function accepting a `NextRequest`
2. Authenticates via `authenticateRequest(request)` + `isAuthenticated(auth)` guard -- if not authenticated, returns the auth error response (401)
3. Reads `bucket_config_id` from `request.nextUrl.searchParams`
4. If `bucket_config_id` is missing/null, returns a 400 JSON response: `{ error: "bucket_config_id query parameter is required" }`
5. Calls `findDuplicateGroups(auth.supabase, auth.user.id, bucketConfigId)`
6. If error, returns `{ error }` with status 500
7. On success, returns `{ data: { groups: data, total_duplicate_groups: data.length } }`

**Imports needed:**
- `NextRequest`, `NextResponse` from `next/server`
- `authenticateRequest`, `isAuthenticated` from `@/lib/supabase/api-auth`
- `findDuplicateGroups` from `@/lib/media/db`

**Response shape on success (200):**

```json
{
  "data": {
    "groups": [
      {
        "content_hash": "etag:abc123",
        "copies": 3,
        "event_ids": ["evt-1", "evt-2", "evt-3"],
        "paths": ["s3://bucket/a.jpg", "s3://bucket/b.jpg", "s3://bucket/c.jpg"]
      }
    ],
    "total_duplicate_groups": 1
  }
}
```

**Response on missing param (400):**

```json
{
  "error": "bucket_config_id query parameter is required"
}
```

**Response on DB error (500):**

```json
{
  "error": { ... }
}
```

The error object is passed through from Supabase without transformation, per the project's coding principle of not reshaping data without reason.

### Design Notes

- No pagination is needed. Expected scale is under 100 duplicate groups.
- The `bucket_config_id` parameter is required (not optional) at the API level, even though the underlying RPC function allows it to be optional. The API always scopes to a single bucket because the CLI command operates on one bucket at a time.
- Tenant isolation is enforced by two mechanisms: (a) the RPC function filters by `p_user_id` which is set from `auth.user.id` (the JWT subject), and (b) RLS policies on the `events` table enforce `user_id = auth.uid()`. The Supabase client created by `authenticateRequest` uses the user's Bearer token, so RLS applies automatically.
- The `findDuplicateGroups` function may return `null` for `data` on some error paths. The route should handle this by treating `null` data as an empty array, or by letting the 500 branch handle it if `error` is also set. Follow the pattern: if `error` is truthy, return 500; otherwise return the data (which will be an array, possibly empty).