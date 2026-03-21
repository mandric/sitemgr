# Section 1: Refactor db.ts and Delete Barrel Export

## Context

`web/lib/media/db.ts` is the data-access layer (DAL) for the media event store. It currently imports `resolveApiConfig` and `refreshSession` from `web/lib/auth/cli-auth.ts`, which in turn imports Node-native modules (`node:fs`, `node:os`, `node:readline`) and calls `homedir()` at module scope. This breaks every web/Vercel consumer at import time because those Node APIs are unavailable in the Edge/serverless runtime.

The fix: remove the cli-auth dependency from db.ts entirely. Client factories (`getAdminClient`, `getUserClient`) become parameterized — callers pass config explicitly. The CLI-specific `getAuthenticatedClient` is deleted (the CLI will authenticate via HTTP endpoints in a later section). The `device_id` in `getStats` becomes a parameter instead of reading `process.env.SMGR_DEVICE_ID`. Every data function receives a Supabase client as its first argument so the DAL never creates its own clients.

The barrel export `web/lib/media/index.ts` is also deleted. No files in the `web/` tree currently import from `@/lib/media` (the barrel); all existing imports already use deep paths like `@/lib/media/db`. Deleting the barrel prevents future accidental re-introduction of a transitive cli-auth dependency.

## Files to Modify

### 1. `web/lib/media/db.ts` — Major refactor

**Remove import:** Delete line 12 (`import { refreshSession, resolveApiConfig } from "@/lib/auth/cli-auth"`).

**Parameterize client factories:**

```typescript
export interface SupabaseConfig {
  url: string;
  serviceKey: string;
}

export interface SupabaseUserConfig {
  url: string;
  anonKey: string;
}

export function getAdminClient(config: SupabaseConfig): SupabaseClient
export function getUserClient(config: SupabaseUserConfig): SupabaseClient
```

`getAdminClient` validates that `config.url` and `config.serviceKey` are truthy (throw if not), then calls `createClient(config.url, config.serviceKey)`. No more reading `process.env.SUPABASE_SECRET_KEY` or calling `resolveApiConfig()`.

`getUserClient` validates `config.url` and `config.anonKey`, then calls `createClient(config.url, config.anonKey)`. No more calling `resolveApiConfig()`.

**Delete `getAuthenticatedClient`:** Remove the entire function (lines 66-74). It depends on `refreshSession` from cli-auth and is only used by the CLI, which will switch to HTTP auth in Section 6.

**Add client parameter to every data function.** Each function receives a `SupabaseClient` as its first argument and stops creating its own client internally. The function bodies are otherwise unchanged — same queries, same `{ data, error }` return shape.

Updated signatures:

```typescript
export async function queryEvents(client: SupabaseClient, opts: QueryOptions): Promise<{ data: any[]; count: number; error: unknown }>
export async function showEvent(client: SupabaseClient, eventId: string, userId?: string): Promise<{ data: any; error: unknown }>
export async function getStats(client: SupabaseClient, opts?: { userId?: string; deviceId?: string }): Promise<{ data: any; error: unknown }>
export async function getEnrichStatus(client: SupabaseClient, userId?: string): Promise<{ data: any; error: unknown }>
export async function insertEvent(client: SupabaseClient, event: Omit<EventRow, "timestamp"> & { timestamp?: string }): Promise<{ data: any; error: unknown }>
export async function insertEnrichment(client: SupabaseClient, eventId: string, result: { description: string; objects: string[]; context: string; suggested_tags: string[] }, userId?: string): Promise<{ data: any; error: unknown }>
export async function upsertWatchedKey(client: SupabaseClient, s3Key: string, eventId: string | null, etag: string, sizeBytes: number, userId?: string, bucketConfigId?: string): Promise<{ data: any; error: unknown }>
export async function getWatchedKeys(client: SupabaseClient, userId?: string): Promise<{ data: any; error: unknown }>
export async function findEventByHash(client: SupabaseClient, hash: string, userId?: string): Promise<{ data: any; error: unknown }>
export async function getPendingEnrichments(client: SupabaseClient, userId?: string): Promise<{ data: any; error: unknown }>
export async function getModelConfig(client: SupabaseClient, userId: string, provider?: string): Promise<{ data: any; error: unknown }>
```

Inside each function, replace the line that creates a client (e.g., `const supabase = getUserClient()`) with direct use of the `client` parameter. For write functions that use `withRetryDb`, move the client creation out of the retry closure — the `client` parameter is used directly inside the retry callback instead of calling `getAdminClient()` each time.

**Parameterize `getStats` device_id:** Change `getStats` signature to accept `opts?: { userId?: string; deviceId?: string }`. Replace `process.env.SMGR_DEVICE_ID ?? "default"` with `opts?.deviceId ?? "default"` in the return value.

**Keep unchanged:** `EventRow`, `QueryOptions`, `ModelConfigRow` interfaces; `withRetryDb`, `shouldRetryDbError` helpers; enrichments normalization logic; logger usage; retry and error handling patterns.

### 2. `web/lib/media/index.ts` — Delete

Delete this file entirely. It currently re-exports from `./constants`, `./utils`, `./s3`, `./enrichment`, and `./db`. No files in `web/` import from `@/lib/media` (confirmed by grep), so this is safe.

### 3. `web/lib/agent/core.ts` — Update imports and calls

This file imports `getAdminClient` and 9 data functions from `@/lib/media/db`. Changes:

- At the top of each request handler (or at module level if appropriate), create an admin client with explicit config from env vars:
  ```typescript
  const client = getAdminClient({
    url: process.env.NEXT_PUBLIC_SUPABASE_URL!,
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
  });
  ```
- Pass `client` as the first argument to every data function call. For example, `queryEvents(opts)` becomes `queryEvents(client, opts)`.
- `getStats(userId)` becomes `getStats(client, { userId })`.

### 4. `web/components/agent/actions.ts` — Update imports and calls

This file imports `getStats` from `@/lib/media/db`. Changes:

- Import `getUserClient` alongside `getStats`.
- Create a user client with config from env vars:
  ```typescript
  const client = getUserClient({
    url: process.env.NEXT_PUBLIC_SUPABASE_URL!,
    anonKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  });
  ```
- Pass `client` as first argument: `getStats(client, { userId: user.id })`.

### 5. `web/__tests__/db-operations.test.ts` — Update test setup and calls

Current pattern: the test mocks `@supabase/supabase-js` so `createClient` returns `mockSupabaseClient`, then uses `vi.stubEnv` for `SMGR_API_URL`, `SUPABASE_SECRET_KEY`, and `SMGR_API_KEY`. Functions are called without a client arg (they create their own internally).

New pattern:

- **Remove `vi.stubEnv` calls** for `SMGR_API_URL`, `SMGR_API_KEY` (no longer read by db.ts).
- **Keep `vi.stubEnv` for `SUPABASE_SECRET_KEY`** only if testing `getAdminClient` config validation; otherwise remove.
- **Remove the `vi.mock("@/lib/auth/cli-auth", ...)` mock** — db.ts no longer imports cli-auth, so there is nothing to mock. (If this mock doesn't exist yet, no action needed.)
- **Pass `mockSupabaseClient` directly** to every data function call. For example:
  ```typescript
  await upsertWatchedKey(mockSupabaseClient, "photos/a.jpg", "evt-1", "abc123", 1024, "user-1", "bucket-42");
  ```
- **Add new tests for client factories** (see TDD section below).
- **Add test for `getStats` deviceId parameter**: call `getStats(client, { deviceId: "my-phone" })` and verify the returned `device_id` is `"my-phone"`. Call without `deviceId` and verify it defaults to `"default"`.

### 6. `web/__tests__/supabase-client.test.ts` — Update

This file tests `getAdminClient` and `getUserClient`. Update to pass config objects instead of relying on env vars.

### 7. `web/__tests__/agent-core.test.ts` — Update mock calls

The mock of `@/lib/media/db` needs to account for the new first-argument `client` parameter in every data function. Update mock implementations and call assertions accordingly.

### 8. `web/__tests__/s3-actions.test.ts` and `web/__tests__/phone-migration-app.test.ts` — Update if they call db functions

These test files import from `@/lib/media/db`. If they call data functions directly (not just mock them), update to pass a client as the first argument.

## TDD Test Stubs

Write these test stubs (failing) **before** implementing the changes. Place them in `web/__tests__/db-operations.test.ts` (extend the existing file) or a new `web/__tests__/db-refactor.test.ts` if the existing file is easier to keep stable during the transition.

### Client Factory Tests

```typescript
describe("getAdminClient", () => {
  it("creates client with provided url and serviceKey", async () => {
    // Call getAdminClient({ url: "http://localhost:54321", serviceKey: "svc-key" })
    // Assert createClient was called with ("http://localhost:54321", "svc-key")
  });

  it("throws when config is missing url", async () => {
    // Call getAdminClient({ url: "", serviceKey: "svc-key" })
    // Expect thrown error mentioning url
  });

  it("throws when config is missing serviceKey", async () => {
    // Call getAdminClient({ url: "http://localhost:54321", serviceKey: "" })
    // Expect thrown error mentioning serviceKey
  });
});

describe("getUserClient", () => {
  it("creates client with provided url and anonKey", async () => {
    // Call getUserClient({ url: "http://localhost:54321", anonKey: "anon-key" })
    // Assert createClient was called with ("http://localhost:54321", "anon-key")
  });

  it("throws when config is missing url", async () => {
    // Expect thrown error
  });
});
```

### Parameterized Data Function Tests

```typescript
describe("queryEvents (parameterized)", () => {
  it("accepts client as first param and uses it for the query", async () => {
    // Pass mockSupabaseClient as first arg
    // Verify mockFrom was called (via the passed client, not an internally-created one)
  });
});

describe("getStats (parameterized)", () => {
  it("accepts client and optional { userId, deviceId }", async () => {
    // Call getStats(mockSupabaseClient, { userId: "u1", deviceId: "my-phone" })
    // Verify returned data.device_id === "my-phone"
  });

  it("defaults deviceId to 'default' when not provided", async () => {
    // Call getStats(mockSupabaseClient, { userId: "u1" })
    // Verify returned data.device_id === "default"
  });

  it("does not read process.env.SMGR_DEVICE_ID", async () => {
    // Set process.env.SMGR_DEVICE_ID = "env-device"
    // Call getStats(mockSupabaseClient, {})
    // Verify returned data.device_id === "default" (env var ignored)
  });
});

describe("insertEvent (parameterized)", () => {
  it("accepts client as first param and uses it inside withRetryDb", async () => {
    // Pass mockSupabaseClient, verify mockFrom("events").insert was called
  });
});
```

Add similar one-liner stubs for `showEvent`, `getEnrichStatus`, `insertEnrichment`, `upsertWatchedKey`, `getWatchedKeys`, `findEventByHash`, `getPendingEnrichments`, `getModelConfig` — each asserting `client` is the first arg and the function uses it.

### Barrel Deletion Test

```typescript
describe("barrel export removal", () => {
  it("lib/media/index.ts does not exist", async () => {
    // Use a dynamic import or fs.existsSync to verify the file is gone
    // expect(() => require.resolve("@/lib/media")).toThrow()
    // or: expect(existsSync(path.join(__dirname, "../lib/media/index.ts"))).toBe(false)
  });
});
```

### getAuthenticatedClient Removal Test

```typescript
describe("getAuthenticatedClient removal", () => {
  it("is no longer exported from db.ts", async () => {
    const db = await import("@/lib/media/db");
    expect(db).not.toHaveProperty("getAuthenticatedClient");
  });
});
```

## Verification Steps

After implementing all changes, run these checks in order:

1. **TypeScript compilation:**
   ```bash
   cd web && npx tsc --noEmit
   ```
   Must pass with zero errors. This catches any call sites that still use the old signatures (missing `client` first arg) or import from the deleted barrel.

2. **Unit tests:**
   ```bash
   cd web && npx vitest run __tests__/db-operations.test.ts
   cd web && npx vitest run __tests__/supabase-client.test.ts
   cd web && npx vitest run __tests__/agent-core.test.ts
   ```
   All must pass.

3. **Full test suite:**
   ```bash
   cd web && npx vitest run
   ```
   No regressions. Any test that was importing from `@/lib/media` (barrel) or calling data functions without the `client` parameter will fail here — fix them.

4. **Grep for residual cli-auth imports in db.ts:**
   ```bash
   grep -r "cli-auth" web/lib/media/
   ```
   Must return zero results.

5. **Grep for barrel imports:**
   ```bash
   grep -rn 'from ["'"'"']@/lib/media["'"'"']' web/
   ```
   Must return zero results (no file imports the barrel path).

6. **Verify barrel file is deleted:**
   ```bash
   test ! -f web/lib/media/index.ts && echo "OK: barrel deleted"
   ```

7. **Verify `getAuthenticatedClient` is gone:**
   ```bash
   grep "getAuthenticatedClient" web/lib/media/db.ts
   ```
   Must return zero results.

8. **Verify `process.env.SMGR_DEVICE_ID` is gone from db.ts:**
   ```bash
   grep "SMGR_DEVICE_ID" web/lib/media/db.ts
   ```
   Must return zero results.
