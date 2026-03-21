# Section 5: Refactor Health Route

## Overview

The health route at `app/api/health/route.ts` currently calls `getAdminClient()` with no arguments, relying on the old pattern where `getAdminClient` reads env vars internally. After the Section 1 refactor, `getAdminClient` requires a `SupabaseConfig` parameter. This section updates the health route to pass that config explicitly.

The health endpoint remains unauthenticated -- it is a public liveness check used by monitoring. No behavioral changes beyond switching to the parameterized client factory.

## Dependencies

- **section-01-refactor-db** must be complete. That section changes `getAdminClient` to require a `SupabaseConfig` argument. Without it, this section's changes will not compile.

## What This Section Blocks

- Nothing directly. The health route is a leaf consumer with no downstream dependents.

## Files Involved

| File | Action |
|------|--------|
| `/home/user/sitemgr/web/app/api/health/route.ts` | Modify |
| `/home/user/sitemgr/web/__tests__/api/health.test.ts` | Create |

## Current State

`/home/user/sitemgr/web/app/api/health/route.ts` currently:

1. Imports `getAdminClient` from `@/lib/media/db`
2. Calls `getAdminClient()` with zero arguments
3. Runs a `select("id", { count: "exact", head: true })` on the `events` table
4. Returns `{ status: "ok", service: "smgr", timestamp }` on success (HTTP 200)
5. Returns `{ status: "degraded", service: "smgr", timestamp }` on failure (HTTP 503)

## Changes

### 1. Update `app/api/health/route.ts`

Replace the zero-argument `getAdminClient()` call with the parameterized form. The import stays the same (`getAdminClient` from `@/lib/media/db`), but the call site changes.

**Before:**
```typescript
const supabase = getAdminClient();
```

**After:**
```typescript
const supabase = getAdminClient({
  url: process.env.NEXT_PUBLIC_SUPABASE_URL!,
  serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
});
```

Everything else in the function stays identical -- the connectivity query, error handling, response shape, and status codes are all unchanged.

### 2. Create `__tests__/api/health.test.ts`

Test file for the health route. Mock `@/lib/media/db` to control `getAdminClient` behavior.

## TDD Test Stubs

Create `/home/user/sitemgr/web/__tests__/api/health.test.ts` with these test cases:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @/lib/media/db before importing the route
vi.mock("@/lib/media/db", () => ({
  getAdminClient: vi.fn(),
}));

import { GET } from "@/app/api/health/route";
import { getAdminClient } from "@/lib/media/db";

describe("GET /api/health", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-key");
  });

  it("returns 200 with status 'ok' when db is reachable", async () => {
    // Arrange: mock getAdminClient to return a client whose select succeeds
    // Act: call GET()
    // Assert: response status 200, body.status === "ok"
  });

  it("returns 503 with status 'degraded' when db query fails", async () => {
    // Arrange: mock getAdminClient to return a client whose select returns an error
    // Act: call GET()
    // Assert: response status 503, body.status === "degraded"
  });

  it("returns 503 with status 'degraded' when getAdminClient throws", async () => {
    // Arrange: mock getAdminClient to throw an exception
    // Act: call GET()
    // Assert: response status 503, body.status === "degraded"
  });

  it("does not require authentication", async () => {
    // Arrange: no Authorization header, mock db as reachable
    // Act: call GET() with no request object / no auth headers
    // Assert: response status 200 (not 401)
  });

  it("passes server env vars to getAdminClient", async () => {
    // Arrange: mock getAdminClient, stub env vars
    // Act: call GET()
    // Assert: getAdminClient called with { url: "http://localhost:54321", serviceKey: "test-service-key" }
  });
});
```

Each test should construct a mock Supabase client object with a chainable `.from().select().limit()` pattern. For example:

```typescript
const mockClient = {
  from: vi.fn().mockReturnValue({
    select: vi.fn().mockReturnValue({
      limit: vi.fn().mockResolvedValue({ error: null }),
    }),
  }),
};
(getAdminClient as ReturnType<typeof vi.fn>).mockReturnValue(mockClient);
```

## Verification Steps

Run these from `/home/user/sitemgr/web`:

```bash
# 1. Type-check compiles
npx tsc --noEmit

# 2. Health route tests pass
npx vitest run __tests__/api/health.test.ts

# 3. Full test suite still passes (no regressions)
npm test

# 4. Manual smoke test (requires local Supabase running)
curl -s http://localhost:3000/api/health | jq .
# Expected: { "status": "ok", "service": "smgr", "timestamp": "..." }
```

## Completion Criteria

1. `app/api/health/route.ts` calls `getAdminClient({ url, serviceKey })` with env-sourced config
2. No zero-argument `getAdminClient()` calls remain in the health route
3. All five test cases in `__tests__/api/health.test.ts` pass
4. The full test suite passes without regressions
