# Section 7: Update Agent Core and Server Actions

## Overview

Two server-side consumers call `db.ts` data functions directly: agent core (`lib/agent/core.ts`) and server actions (`components/agent/actions.ts`). These modules run on Vercel server-side -- they keep direct db.ts access (no HTTP detour). However, after Section 1, all db.ts data functions require a Supabase client as their first parameter, and `getAdminClient`/`getUserClient` require explicit config objects.

This section updates both consumers to create parameterized clients and pass them through to every db.ts call. No behavioral changes -- same queries, same results, just explicit dependency injection instead of implicit env var reads inside db.ts.

## Dependencies

- **section-01-refactor-db** must be complete. That section changes all db.ts function signatures to accept a client parameter.

## What This Section Blocks

- **section-08-cleanup** depends on this section completing.

## Files Involved

| File | Action |
|------|--------|
| `/home/user/sitemgr/web/lib/agent/core.ts` | Modify |
| `/home/user/sitemgr/web/components/agent/actions.ts` | Modify |
| `/home/user/sitemgr/web/__tests__/agent-core.test.ts` | Modify or create |
| `/home/user/sitemgr/web/__tests__/agent-actions.test.ts` | Modify or create |

## Current State

### `lib/agent/core.ts`

Lines 11-21 import from `@/lib/media/db`:
- `getAdminClient` (client factory, currently zero-argument)
- `queryEvents`, `showEvent`, `getStats`, `getEnrichStatus`, `insertEvent`, `insertEnrichment`, `upsertWatchedKey`, `getWatchedKeys` (data functions, currently no client param)

The module calls `getAdminClient()` (zero-argument) in various handler functions and passes the resulting client to some Supabase operations. Data functions like `queryEvents(opts)` are called without a client parameter.

Encryption imports (`encryptSecretVersioned`, `decryptSecretVersioned`, etc.) from `@/lib/crypto/encryption-versioned` are unrelated to this change and remain untouched.

S3 imports (`createS3Client`, `listS3Objects`, `downloadS3Object`) from `@/lib/media/s3` are also unrelated and remain untouched.

### `components/agent/actions.ts`

This is a Next.js server action file (marked `"use server"`).

Line 10 imports `getStats` from `@/lib/media/db`. The function `sendMessage()` calls `getStats(user.id)` without a client parameter to build user context for the agent.

It also imports `sendMessageToAgent`, `getConversationHistory`, `saveConversationHistory` from `@/lib/agent/core` -- these are unaffected by this section (they are core functions, not db.ts functions).

It creates a Supabase server client via `createClient` from `@/lib/supabase/server` for auth only (`supabase.auth.getUser()` and a direct `bucket_configs` query). This auth client is separate from the db.ts client and is not changing.

## Changes

### 1. Update `lib/agent/core.ts`

**Add a helper function** at module scope (or inline in each handler) that builds the admin config:

```typescript
function getServerAdminClient() {
  return getAdminClient({
    url: process.env.NEXT_PUBLIC_SUPABASE_URL!,
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
  });
}
```

This is a convenience wrapper -- it reads env vars and passes them to the now-parameterized `getAdminClient`. It is private to this module (not exported).

**Update every call site** that uses data functions. Each function that previously called `queryEvents(opts)` now calls `queryEvents(client, opts)`, where `client` comes from `getServerAdminClient()`. The pattern:

```typescript
// Before (in any handler function)
const results = await queryEvents({ search, userId });
const event = await showEvent(eventId, userId);
const { data: stats } = await getStats(userId);

// After
const client = getServerAdminClient();
const results = await queryEvents(client, { search, userId });
const event = await showEvent(client, eventId, userId);
const { data: stats } = await getStats(client, { userId });
```

Create the client once per handler function invocation, then pass it to all db.ts calls within that handler. Do not create it at module scope (that would capture stale env vars in edge cases).

**Affected functions in core.ts** (all functions that call db.ts data functions -- review the full file to find every call site):

- `resolveUserId` -- calls `getAdminClient()` for user profile lookup
- `executeAction` -- calls `queryEvents`, `showEvent`, `getStats`, `getEnrichStatus`, `insertEvent`, `insertEnrichment`, `upsertWatchedKey`, `getWatchedKeys`
- `getConversationHistory` -- may call admin client for conversation storage
- `saveConversationHistory` -- may call admin client for conversation storage
- Any other function that touches db.ts

For each function, add `const client = getServerAdminClient();` near the top and thread `client` through all db.ts calls.

### 2. Update `components/agent/actions.ts`

**Change the `getStats` call** in `sendMessage()`:

```typescript
// Before
import { getStats } from "@/lib/media/db";
// ...
const { data: stats } = await getStats(user.id);

// After
import { getStats, getAdminClient } from "@/lib/media/db";
// ...
const dbClient = getAdminClient({
  url: process.env.NEXT_PUBLIC_SUPABASE_URL!,
  serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
});
const { data: stats } = await getStats(dbClient, { userId: user.id });
```

Note on client choice: The plan originally suggested `getUserClient` here, but `getStats` is a read across the user's data and the server action already authenticated via `supabase.auth.getUser()`. Using the admin client is simpler and consistent with agent core. Either works since RLS is bypassed by the service role key and userId is passed explicitly.

The `createClient` from `@/lib/supabase/server` (used for auth and the `bucket_configs` query) is **unchanged**. It is a different client for a different purpose.

### 3. No changes to other imports

- `@/lib/crypto/encryption-versioned` -- unchanged
- `@/lib/media/s3` -- unchanged
- `@/lib/media/utils` -- unchanged
- `@/lib/media/enrichment` -- unchanged

## TDD Test Stubs

### `__tests__/agent-core.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock db.ts
vi.mock("@/lib/media/db", () => ({
  getAdminClient: vi.fn(),
  queryEvents: vi.fn(),
  showEvent: vi.fn(),
  getStats: vi.fn(),
  getEnrichStatus: vi.fn(),
  insertEvent: vi.fn(),
  insertEnrichment: vi.fn(),
  upsertWatchedKey: vi.fn(),
  getWatchedKeys: vi.fn(),
}));

import { getAdminClient, queryEvents, getStats } from "@/lib/media/db";

describe("agent core (parameterized db access)", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-key");
    (getAdminClient as ReturnType<typeof vi.fn>).mockReturnValue({});
  });

  it("creates admin client with env vars, not zero-argument call", async () => {
    // Trigger a function that calls getAdminClient (e.g., resolveUserId or executeAction)
    // Assert getAdminClient was called with { url: "http://localhost:54321", serviceKey: "test-service-key" }
    // Assert getAdminClient was NOT called with zero arguments
  });

  it("passes client as first argument to queryEvents", async () => {
    // Trigger executeAction with a "query" action
    // Assert queryEvents was called with (client, opts) -- client is first arg
  });

  it("passes client as first argument to showEvent", async () => {
    // Trigger executeAction with a "show" action
    // Assert showEvent was called with (client, eventId, userId)
  });

  it("passes client as first argument to getStats", async () => {
    // Trigger executeAction with a "stats" action
    // Assert getStats called with (client, { userId })
  });

  it("passes client as first argument to insertEvent", async () => {
    // Trigger executeAction with an "add" action
    // Assert insertEvent called with (client, eventData)
  });

  it("does not import from cli-auth", async () => {
    // Read the source of lib/agent/core.ts
    // Assert no "cli-auth" string appears in imports
  });

  it("encryption operations are unchanged", async () => {
    // Verify encryptSecretVersioned/decryptSecretVersioned imports still exist
    // These should not be affected by the db.ts refactor
  });
});
```

### `__tests__/agent-actions.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies
vi.mock("@/lib/media/db", () => ({
  getStats: vi.fn(),
  getAdminClient: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

vi.mock("@/lib/agent/core", () => ({
  sendMessageToAgent: vi.fn(),
  getConversationHistory: vi.fn(),
  saveConversationHistory: vi.fn(),
}));

import { getStats, getAdminClient } from "@/lib/media/db";
import { createClient } from "@/lib/supabase/server";

describe("server actions (parameterized db access)", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-key");

    // Mock auth to return a user
    (createClient as ReturnType<typeof vi.fn>).mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: { id: "test-user-id" } },
        }),
      },
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ data: [] }),
        }),
      }),
    });

    (getAdminClient as ReturnType<typeof vi.fn>).mockReturnValue({});
    (getStats as ReturnType<typeof vi.fn>).mockResolvedValue({ data: null });
  });

  it("creates db client from env vars and passes to getStats", async () => {
    // Import and call sendMessage
    // Assert getAdminClient called with { url, serviceKey }
    // Assert getStats called with (client, { userId: "test-user-id" })
  });

  it("getStats receives client as first argument", async () => {
    // Call sendMessage
    // Assert getStats first argument is the client returned by getAdminClient
  });

  it("does not import from cli-auth", async () => {
    // Read the source of components/agent/actions.ts
    // Assert no "cli-auth" string appears in imports
  });

  it("still uses @/lib/supabase/server for auth (unchanged)", async () => {
    // Call sendMessage
    // Assert createClient from @/lib/supabase/server was called
    // Assert supabase.auth.getUser was called
  });
});
```

## Verification Steps

Run these from `/home/user/sitemgr/web`:

```bash
# 1. Type-check compiles
npx tsc --noEmit

# 2. Agent core tests pass
npx vitest run __tests__/agent-core.test.ts

# 3. Server action tests pass
npx vitest run __tests__/agent-actions.test.ts

# 4. Full test suite still passes
npm test

# 5. Verify no zero-argument getAdminClient calls in agent core
grep -n "getAdminClient()" lib/agent/core.ts
# Expected: no output (all calls should have config arg)

# 6. Verify no zero-argument getStats calls in actions.ts
grep -n "getStats(" components/agent/actions.ts
# Expected: every getStats call has a client as first argument

# 7. Verify no cli-auth imports in either file
grep -n "cli-auth" lib/agent/core.ts components/agent/actions.ts
# Expected: no output
```

## Completion Criteria

1. `lib/agent/core.ts` calls `getAdminClient({ url, serviceKey })` -- no zero-argument calls remain
2. Every db.ts data function call in `core.ts` receives a client as its first argument
3. `components/agent/actions.ts` calls `getAdminClient({ url, serviceKey })` and passes the client to `getStats`
4. Neither file imports from `cli-auth`
5. Encryption and S3 imports/operations are untouched
6. The `createClient` from `@/lib/supabase/server` in `actions.ts` is unchanged (still used for auth)
7. All test cases pass
8. The full test suite passes without regressions
