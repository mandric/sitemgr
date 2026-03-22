Now I have all the context needed. Let me produce the section content.

# Section 3: Refactor Agent Core -- Remove `createAdminClient()`

## Overview

This section refactors `web/lib/agent/core.ts` to accept a `SupabaseClient` parameter instead of creating admin clients internally. The internal `createAdminClient()` function is deleted, and every function that currently calls it receives a client as its first argument instead. Callers are updated to pass the appropriate client.

This is the largest change in the audit. After this section, `agent/core.ts` no longer imports `getAdminClient` from `db.ts` and no longer references `process.env.SUPABASE_SERVICE_ROLE_KEY`.

**Depends on:** Nothing (batch 2, no prerequisites).
**Blocks:** Section 04 (webhook service account) -- that section changes the WhatsApp caller to use a webhook service account client instead of the admin client this section removes.

## Background

Currently `web/lib/agent/core.ts` contains a module-level helper:

```typescript
function createAdminClient() {
  return getAdminClient({
    url: process.env.NEXT_PUBLIC_SUPABASE_URL!,
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
  });
}
```

This is called approximately 15 times throughout the file -- in `resolveUserId`, `executeAction` (multiple action branches), `addBucket`, `listBuckets`, `removeBucket`, `getBucketConfig`, `indexBucket`, `getConversationHistory`, and `saveConversationHistory`. Every call manually filters by `userId`, which is exactly what RLS does automatically with a user-scoped client.

The two callers of agent core functions are:

1. **`web/components/agent/actions.ts`** (server action for web chat) -- already has a user-scoped Supabase client from `createClient()` in `@/lib/supabase/server`.
2. **`web/app/api/whatsapp/route.ts`** (webhook) -- currently has no client of its own; it relies on `core.ts` creating admin clients internally. After this refactor, the webhook will temporarily break until Section 04 provides a webhook service account client. **For this section, the webhook caller should pass an admin client as an interim measure**, which Section 04 will replace.

## Tests First

### Test file: `web/__tests__/agent-core.test.ts` (existing, modify)

Update the existing test file to verify dependency injection. The key changes:

```
# Test: sendMessageToAgent accepts a SupabaseClient parameter
# Test: executeAction accepts a SupabaseClient parameter and passes it to db functions
# Test: getConversationHistory accepts a SupabaseClient parameter
# Test: saveConversationHistory accepts a SupabaseClient parameter
# Test: resolveUserId accepts a SupabaseClient parameter and calls get_user_id_from_phone RPC
# Test: agent core module does NOT import getAdminClient from db.ts
# Test: agent core module does NOT reference process.env.SUPABASE_SERVICE_ROLE_KEY
```

**Changes to the mock setup:**

The current test mocks `getAdminClient` from `@/lib/media/db` and uses `mockAdminFrom` to simulate query chains. After the refactor, `getAdminClient` is no longer imported by `core.ts`. Instead, tests create a mock `SupabaseClient` object and pass it directly to each function.

The mock for `@/lib/media/db` should be updated to remove `getAdminClient` from the mock (or at minimum, the test should verify it is never called). The `mockAdminFrom` pattern remains useful -- it just gets wired up to a mock client object that tests pass as a parameter rather than being returned by a mocked `getAdminClient`.

Specifically:

1. Replace the `getAdminClient` mock with a local mock client factory:

```typescript
// Instead of mocking getAdminClient, create a mock client to pass as parameter
function createMockClient() {
  return { from: (...args: unknown[]) => mockAdminFrom(...args) };
}
```

2. Remove `getAdminClient` from the `vi.mock("@/lib/media/db", ...)` block entirely (or keep it as `vi.fn()` but assert it is never called).

3. Update all `executeAction` calls to pass the mock client as the first argument:

```typescript
// Before:
await executeAction({ action: "stats" }, "+1234567890", "user-123");

// After:
const client = createMockClient();
await executeAction(client, { action: "stats" }, "+1234567890", "user-123");
```

4. Update `sendMessageToAgent` calls similarly if that function gains a client parameter (see design notes below -- `sendMessageToAgent` only calls the Anthropic API, not Supabase, so it may not need a client parameter).

5. Add a static analysis test:

```typescript
it("agent core module does NOT import getAdminClient from db.ts", async () => {
  const fs = await import("fs");
  const source = fs.readFileSync("lib/agent/core.ts", "utf-8");
  expect(source).not.toContain("getAdminClient");
});

it("agent core module does NOT reference SUPABASE_SERVICE_ROLE_KEY", async () => {
  const fs = await import("fs");
  const source = fs.readFileSync("lib/agent/core.ts", "utf-8");
  expect(source).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
});
```

6. Remove `vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", ...)` from all `beforeEach` blocks -- the agent core no longer reads this env var.

### Test file: `web/__tests__/agent-actions.test.ts` (new, unit)

This new test verifies that the server action in `components/agent/actions.ts` wires the user's client through to core functions.

```
# Test: sendMessage server action passes the user's server client to getConversationHistory
# Test: sendMessage server action passes the user's server client to sendMessageToAgent
# Test: sendMessage server action passes the user's server client to saveConversationHistory
# Test: sendMessage does not create an admin client or reference service role key
```

This test mocks `@/lib/supabase/server` (returning a fake client with `auth.getUser()`) and `@/lib/agent/core` (spying on function calls), then calls `sendMessage()` and verifies the mock client was passed as the first argument to each core function.

## Implementation Details

### File: `web/lib/agent/core.ts`

**Delete the `createAdminClient()` function** (lines 47-52) and the `getAdminClient` import from `@/lib/media/db`.

**Add a `SupabaseClient` type import** for the parameter type. Use the generic type from `@supabase/supabase-js`:

```typescript
import type { SupabaseClient } from "@supabase/supabase-js";
```

**Update every function that currently calls `createAdminClient()`** to accept a `client: SupabaseClient` as its first parameter. The full list of signature changes:

| Function | Current first param | New first param |
|----------|-------------------|-----------------|
| `resolveUserId(phone)` | `phoneNumber: string` | `client: SupabaseClient, phoneNumber: string` |
| `executeAction(plan, phone, userId?)` | `plan: AgentPlan` | `client: SupabaseClient, plan: AgentPlan, ...` |
| `getConversationHistory(phone, userId?)` | `phone: string` | `client: SupabaseClient, phone: string, ...` |
| `saveConversationHistory(phone, history, userId?)` | `phone: string` | `client: SupabaseClient, phone: string, ...` |
| `addBucket(phone, params, userId)` | `phoneNumber: string` | `client: SupabaseClient, phoneNumber: string, ...` |
| `listBuckets(phone, userId)` | `phoneNumber: string` | `client: SupabaseClient, phoneNumber: string, ...` |
| `removeBucket(phone, bucketName, userId)` | `phoneNumber: string` | `client: SupabaseClient, phoneNumber: string, ...` |
| `getBucketConfig(phone, bucketName, userId?)` | `phoneNumber: string` | `client: SupabaseClient, phoneNumber: string, ...` |
| `requireS3Client(phone, bucketName, userId?)` | `phoneNumber: string` | `client: SupabaseClient, phoneNumber: string, ...` |
| `indexBucket(phone, bucketName, prefix?, batchSize?, userId?)` | `phoneNumber: string` | `client: SupabaseClient, phoneNumber: string, ...` |
| `verifyBucketConfig(phone, bucketName, userId?)` | `phoneNumber: string` | `client: SupabaseClient, phoneNumber: string, ...` |
| `listObjects(phone, bucketName, prefix?, limit?, userId?)` | `phoneNumber: string` | `client: SupabaseClient, phoneNumber: string, ...` |
| `countObjects(phone, bucketName, prefix?, limit?, userId?)` | `phoneNumber: string` | `client: SupabaseClient, phoneNumber: string, ...` |

**Note on `sendMessageToAgent`:** This function only calls the Anthropic API -- it does not touch Supabase. It does NOT need a client parameter. Leave its signature unchanged.

**Note on `planAction` and `summarizeResult`:** These also only call the Anthropic API. Leave their signatures unchanged.

**Inside `executeAction`:** The function currently creates local admin clients for specific action branches (e.g., `const statsClient = createAdminClient()` in the `stats` case). Replace all of these with the injected `client` parameter. The client is also passed down to sub-functions like `addBucket(client, ...)`, `listBuckets(client, ...)`, etc.

**Inside `indexBucket`:** Currently creates `const indexClient = createAdminClient()` and passes it to `getWatchedKeys`, `insertEvent`, `upsertWatchedKey`, and `insertEnrichment`. Replace with the injected `client`.

**Inside `getBucketConfig`:** Currently creates its own admin client. Replace with the injected `client`. Note this function also does lazy migration (background update of encryption) using the same client -- this continues to work with a user-scoped client as long as RLS allows the user to update their own `bucket_configs` row.

**Inside `getConversationHistory` and `saveConversationHistory`:** Currently create their own admin clients. Replace with the injected `client`.

**Inside `resolveUserId`:** Currently queries `user_profiles` table directly. Replace `createAdminClient()` with the injected `client`. Note: this function does a cross-user lookup (find user by phone number). With a user-scoped client, this will only work if:
- The client has RLS policies allowing the lookup, OR
- The function uses an RPC like `get_user_id_from_phone`

For this section, keep `resolveUserId` using the direct query approach. Section 04 will handle the RLS/RPC changes needed for the webhook path. The web chat path does not call `resolveUserId` (it already has `user.id` from the session).

### File: `web/components/agent/actions.ts`

Update the `sendMessage` server action to pass the Supabase client to core functions:

```typescript
const supabase = await createClient(); // cookie-based, user-scoped
const { data: { user } } = await supabase.auth.getUser();
// ...
const history = await getConversationHistory(supabase, "web", user.id);
// ...
const response = await sendMessageToAgent(enrichedMessage, history);
// sendMessageToAgent does NOT get a client -- it only calls Anthropic
// ...
await saveConversationHistory(supabase, "web", updatedHistory, user.id);
```

The `supabase` client here is the user's server-side client created from cookies. It has the user's JWT, so RLS applies automatically. The existing manual `userId` filters in `db.ts` functions serve as belt-and-suspenders.

Also note: the server action currently creates a separate `getUserClient` for the `getStats` call (lines 33-37 of the current file). This can be simplified to use the same `supabase` client from `createClient()` since that client already has the user's session.

### File: `web/app/api/whatsapp/route.ts`

**Interim approach for this section:** The webhook handler needs to pass a client to all the core functions it calls. Since the webhook service account does not exist yet (that is Section 04), temporarily create an admin client in the webhook handler itself:

```typescript
import { getAdminClient } from "@/lib/media/db";

// TEMPORARY: Section 04 replaces this with webhook service account
function createWebhookClient() {
  return getAdminClient({
    url: process.env.NEXT_PUBLIC_SUPABASE_URL!,
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
  });
}
```

Then pass this client to all core function calls:

```typescript
const client = createWebhookClient();
const userId = await resolveUserId(client, fromNumber);
const history = await getConversationHistory(client, fromNumber, userId);
// ...
const result = await executeAction(client, plan, fromNumber, userId);
// ...
await saveConversationHistory(client, fromNumber, history, userId);
```

This is intentionally a temporary state. The admin client usage moves from being hidden inside `core.ts` to being explicit in the one caller that actually needs elevated access. Section 04 replaces this with the webhook service account pattern, eliminating the service role key entirely from application code.

### Import cleanup in `core.ts`

After the refactor, the imports from `@/lib/media/db` in `core.ts` should be:

```typescript
import {
  queryEvents,
  showEvent,
  getStats,
  getEnrichStatus,
  insertEvent,
  insertEnrichment,
  upsertWatchedKey,
  getWatchedKeys,
} from "@/lib/media/db";
```

Note: `getAdminClient` is removed from this import list. The `getUserClient` import is also not needed here (it was never imported by `core.ts`).

## Files Modified

- `/home/user/sitemgr/web/lib/agent/core.ts` -- Delete `createAdminClient()`, add `client` parameter to all DB-touching functions, remove `getAdminClient` import
- `/home/user/sitemgr/web/components/agent/actions.ts` -- Pass `supabase` client to `getConversationHistory`, `saveConversationHistory`
- `/home/user/sitemgr/web/app/api/whatsapp/route.ts` -- Create temporary admin client, pass to all core function calls
- `/home/user/sitemgr/web/__tests__/agent-core.test.ts` -- Update mocks and function call signatures, add static analysis tests
- `/home/user/sitemgr/web/__tests__/agent-actions.test.ts` -- New test file for server action wiring

## Verification Checklist

After implementation, confirm:

1. `grep -r "getAdminClient" web/lib/agent/` returns zero matches
2. `grep -r "SUPABASE_SERVICE_ROLE_KEY" web/lib/agent/` returns zero matches
3. `grep -r "createAdminClient" web/lib/agent/` returns zero matches
4. `npm test` passes (unit tests)
5. The `getAdminClient` import in `web/app/api/whatsapp/route.ts` is present (temporary, removed in Section 04)