Now I have enough context. Let me produce the section content.

# Section 03: Client Refactor — Split `getSupabaseClient()` into Admin and User Clients

## Overview

The current `getSupabaseClient()` function in `web/lib/media/db.ts` prefers `SUPABASE_SECRET_KEY` (service role) over the publishable key. The service role key bypasses RLS completely. This means every query function in `db.ts` and every call site in `core.ts` bypasses RLS for all server-side operations, rendering the entire RLS policy layer ineffective.

This section splits the single client constructor into two distinct functions with clear security semantics, and updates all call sites to use the appropriate client.

## Dependencies

- **section-02-rls-audit**: The RLS audit must be completed first to understand which operations legitimately need admin access (RLS bypass) versus which should respect RLS. The audit findings determine the correct client assignment for each call site.

## Blocked Sections

- **section-04-rpc-user-isolation**: RPC functions need the correct client to enforce user isolation.
- **section-06-rls-tests**: RLS tests depend on the user client actually respecting RLS.
- **section-08-phone-migration**: Application code changes depend on the new client constructors.

---

## Tests

All tests go in `web/__tests__/supabase-client.test.ts`. These are unit tests using `vi.mock()` to verify the client constructors select the correct keys without connecting to a real Supabase instance.

### Test File: `web/__tests__/supabase-client.test.ts`

```
# Test: getAdminClient() uses SUPABASE_SECRET_KEY (service role key)
# Test: getAdminClient() throws if SUPABASE_SECRET_KEY is not set
# Test: getUserClient() uses NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (anon/publishable key)
# Test: getUserClient() does NOT use SUPABASE_SECRET_KEY even if it is available
# Test: getUserClient() throws if NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is not set
# Test: both clients use NEXT_PUBLIC_SUPABASE_URL for the URL
```

The test file should mock `@supabase/supabase-js` and capture the arguments passed to `createClient`. Use `vi.stubEnv()` for environment variables. The key assertions are:

- `getAdminClient()` passes the value of `SUPABASE_SECRET_KEY` as the second argument to `createClient`.
- `getUserClient()` passes the value of `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` as the second argument to `createClient`.
- `getUserClient()` never passes the service role key, even when `SUPABASE_SECRET_KEY` is defined in the environment.

### Call-Site Audit Tests

These belong in the existing test files (`web/__tests__/s3-actions.test.ts`, etc.) and verify that the mock setup reflects the correct client being used per operation. When updating existing test mocks, replace `getSupabaseClient` with the appropriate new function name.

```
# Test: queryEvents called via getUserClient returns only user's events (RLS enforced)
# Test: queryEvents called via getAdminClient returns all events (for background jobs)
```

These are conceptual tests that validate behavior once the real RLS test suite (section-06) is in place. For this section, the immediate verification is that each call site imports and uses the correct client constructor.

---

## Implementation

### File: `web/lib/media/db.ts`

**Remove** the existing `getSupabaseClient()` function and replace it with two new exported functions.

#### `getAdminClient()`

Purpose: Service role access that bypasses RLS. Used only for background jobs, enrichment pipelines, sync workers, and operations that legitimately need full database access.

Behavior:
- Reads `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SECRET_KEY` from environment.
- Throws a clear error if either is missing. The error message should explicitly state that the service role key is required and name the environment variable.
- Returns a Supabase client created with the service role key.

```typescript
export function getAdminClient() {
  /** Creates a Supabase client with the service role key (bypasses RLS). */
  // Use NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SECRET_KEY
  // Throw if SUPABASE_SECRET_KEY is missing
}
```

#### `getUserClient()`

Purpose: Publishable key access that respects RLS. Used for all user-facing operations where row-level security should be enforced.

Behavior:
- Reads `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` from environment.
- Throws a clear error if either is missing. The error message should name the missing variable.
- Explicitly does NOT fall back to `SUPABASE_SECRET_KEY`. This is the critical difference from the old `getSupabaseClient()` which preferred the service role key.
- Returns a Supabase client created with the publishable key.

```typescript
export function getUserClient() {
  /** Creates a Supabase client with the publishable key (respects RLS). */
  // Use NEXT_PUBLIC_SUPABASE_URL + NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  // Do NOT fall back to SUPABASE_SECRET_KEY
  // Throw if NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is missing
}
```

Note: In a future iteration (section-08, phone-to-user_id migration), `getUserClient()` may accept a user ID or auth token to set the auth context on the client. For now, it simply uses the publishable key, which means RLS policies evaluate against the JWT in the request (if any) or the anon role. The important thing is that it does NOT use the service role key.

#### Backward Compatibility

To avoid breaking all call sites at once, you may temporarily keep `getSupabaseClient()` as a deprecated alias that calls `getAdminClient()` with a console warning. Remove it after all call sites are updated. However, the preferred approach is to update all call sites in this section (there are a manageable number of them).

---

### Call Site Updates

Every location that currently calls `getSupabaseClient()` must be updated to call either `getAdminClient()` or `getUserClient()`. The correct choice depends on the operation's security context.

#### File: `web/lib/media/db.ts` (internal call sites)

The following functions currently call `getSupabaseClient()` internally. Update each one:

| Function | Current Client | New Client | Rationale |
|----------|---------------|------------|-----------|
| `queryEvents()` | `getSupabaseClient()` | `getUserClient()` | User-facing query, should respect RLS |
| `showEvent()` | `getSupabaseClient()` | `getUserClient()` | User-facing query |
| `getStats()` | `getSupabaseClient()` | `getUserClient()` | User-facing stats (RPC calls also need user scoping, handled in section-04) |
| `getEnrichStatus()` | `getSupabaseClient()` | `getUserClient()` | User-facing status |
| `insertEvent()` | `getSupabaseClient()` | `getAdminClient()` | Server-side insert from sync/indexing pipeline; RLS INSERT policies may not allow inserts via publishable key without auth context. Use admin for now; revisit in section-08 when user_id is passed explicitly |
| `insertEnrichment()` | `getSupabaseClient()` | `getAdminClient()` | Background enrichment pipeline |
| `upsertWatchedKey()` | `getSupabaseClient()` | `getAdminClient()` | Background sync pipeline |
| `getWatchedKeys()` | `getSupabaseClient()` | `getAdminClient()` | Background sync pipeline reads all watched keys |
| `findEventByHash()` | `getSupabaseClient()` | `getUserClient()` | Dedup check during user operations |
| `getPendingEnrichments()` | `getSupabaseClient()` | `getAdminClient()` | Background enrichment pipeline needs to see all pending items |

#### File: `web/lib/agent/core.ts`

This file imports `getSupabaseClient` and uses it directly in several functions.

| Function | Current Client | New Client | Rationale |
|----------|---------------|------------|-----------|
| `addBucket()` | `getSupabaseClient()` | `getAdminClient()` | Server-side insert triggered by WhatsApp bot; needs service role to insert bucket_configs. Will revisit when user_id auth context is available (section-08) |
| `listBuckets()` | `getSupabaseClient()` | `getAdminClient()` | Queries by phone_number (server-side filter); will switch to getUserClient after phone-to-user_id migration |
| `removeBucket()` | `getSupabaseClient()` | `getAdminClient()` | Server-side delete by phone_number; same as above |
| `getBucketConfig()` | `getSupabaseClient()` | `getAdminClient()` | Server-side lookup + lazy encryption migration (needs write access) |
| `getConversationHistory()` | `getSupabaseClient()` | `getAdminClient()` | Server-side query by phone_number |
| `saveConversationHistory()` | `getSupabaseClient()` | `getAdminClient()` | Server-side upsert |

Update the import statement at the top of `core.ts` to import `getAdminClient` (and/or `getUserClient`) instead of `getSupabaseClient`.

#### File: `web/app/api/health/route.ts`

| Function | Current Client | New Client | Rationale |
|----------|---------------|------------|-----------|
| `GET()` | `getSupabaseClient()` | `getAdminClient()` | Health check needs to verify DB connectivity; service role is appropriate for infrastructure checks |

Update the import to use `getAdminClient` instead of `getSupabaseClient`.

---

### Updating Existing Test Mocks

Existing test files that mock `getSupabaseClient` must be updated to mock the new function names. Key files to update:

- **`web/__tests__/s3-actions.test.ts`**: Currently mocks `getSupabaseClient: () => ({ from: mockFrom })`. Change this to mock `getAdminClient` (since the agent's bucket operations use admin). If both clients are used in the module under test, mock both.

- **`web/__tests__/encryption-lifecycle.test.ts`**: Check if it mocks `getSupabaseClient` and update accordingly.

The mock pattern remains the same -- only the function name changes:

```typescript
// Before:
vi.mock("@/lib/media/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/media/db")>();
  return {
    ...actual,
    getSupabaseClient: () => ({ from: mockFrom }),
  };
});

// After:
vi.mock("@/lib/media/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/media/db")>();
  return {
    ...actual,
    getAdminClient: () => ({ from: mockFrom }),
    getUserClient: () => ({ from: mockFrom }),
  };
});
```

---

## Important Design Notes

1. **Many call sites use `getAdminClient()` for now.** This is intentional. The WhatsApp bot flow operates server-side with phone_number as the identifier and no Supabase Auth JWT. Until section-08 (phone-to-user_id migration) adds user_id resolution before DB operations, these server-side operations cannot use the publishable key with an auth context. The split is still valuable because it makes the security decision explicit at each call site and sets up the correct structure for the migration.

2. **`getUserClient()` does not accept a user ID parameter in this section.** Adding auth context (e.g., `supabase.auth.setSession()`) is deferred to section-08. For now, `getUserClient()` simply uses the publishable key, which means the anon role's RLS policies apply unless the caller has separately authenticated.

3. **No new environment variables are introduced.** Both `SUPABASE_SECRET_KEY` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` already exist in the environment. The change is that the two keys are no longer used interchangeably via a single function with fallback logic.

4. **The old `getSupabaseClient()` export should be removed** (not kept as a re-export) to ensure grep/search finds any remaining call sites. If a call site still references `getSupabaseClient`, it should fail at compile time, making migration complete and verifiable.

---

## Verification Checklist

After implementation, verify:

- `getSupabaseClient` does not appear anywhere in the codebase (grep for it)
- `getAdminClient` is used only where service role access is justified
- `getUserClient` is used for all user-facing query paths
- All existing tests pass (mock updates may be needed)
- The new `web/__tests__/supabase-client.test.ts` tests pass
- The health endpoint still returns 200 when Supabase is running