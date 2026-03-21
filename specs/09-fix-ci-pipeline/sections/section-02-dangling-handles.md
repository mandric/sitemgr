# Section 02: Dangling Handle Cleanup

## Overview

Add Supabase client cleanup to `afterAll` in all 4 integration test files. The Supabase JS client maintains internal connections (GoTrue auth layer, Realtime WebSocket) that prevent Node.js from exiting cleanly after tests. Fix requires:

1. `removeAllChannels()` on ALL Supabase clients (cleans up Realtime WebSocket)
2. `auth.signOut()` on authenticated user clients only (tears down GoTrue session)
3. Store previously-unstored clients (Bob's client, userB's client) so they can be cleaned up
4. Hoist admin in media-storage to module level (currently creates separate instances in beforeAll/afterAll)

## Files to Modify

### File 1: `web/__tests__/integration/tenant-isolation.test.ts`

**Current state:** Module-level variables for `admin`, `aliceClient`, `anonClient`, `aliceId`, `bobId`, `aliceSeed`, `bobSeed`. Bob's client is created via `createTestUser("bob-iso@test.local")` at line 32 but the `.client` property is never stored.

**Changes:**

1. Add module-level variable after line 22:
```typescript
let bobClient: SupabaseClient;
```

2. In `beforeAll`, after line 32 (`const bob = await createTestUser(...)`), store the client:
```typescript
bobClient = bob.client;
```

3. In `afterAll` (lines 43-46), add cleanup after the existing `cleanupUserData` calls:
```typescript
afterAll(async () => {
  await cleanupUserData(admin, aliceId);
  await cleanupUserData(admin, bobId);

  // Tear down authenticated sessions
  await aliceClient.auth.signOut();
  await bobClient.auth.signOut();

  // Clean up all client connections to prevent dangling handles
  await Promise.all([
    admin.removeAllChannels(),
    aliceClient.removeAllChannels(),
    bobClient.removeAllChannels(),
    anonClient.removeAllChannels(),
  ]);
});
```

### File 2: `web/__tests__/integration/media-lifecycle.test.ts`

**Current state:** Module-level variables for `admin`, `userId`, `userClient`, `userBId`, `userBSeed`. The secondary test user (`userB`) is created in `beforeAll` around line 43, but `userB.client` is never stored.

**Changes:**

1. Add module-level variable (after `let userBSeed: SeedResult;` around line 30):
```typescript
let userBClient: SupabaseClient;
```

2. In `beforeAll`, after the line that creates userB (around line 43: `const userB = await createTestUser()`), store the client:
```typescript
userBClient = userB.client;
```

3. In `afterAll` (starts at line 74), add cleanup at the end of the existing block (before the closing `});`):
```typescript
  // Tear down authenticated sessions
  await userClient.auth.signOut();
  await userBClient.auth.signOut();

  // Clean up all client connections to prevent dangling handles
  await Promise.all([
    admin.removeAllChannels(),
    userClient.removeAllChannels(),
    userBClient.removeAllChannels(),
  ]);
```

### File 3: `web/__tests__/integration/media-storage.test.ts`

**Current state:** Admin client is created locally inside both `beforeAll` (line 28: `const admin = getAdminClient()`) and `afterAll` (line 33: `const admin = getAdminClient()`). These are two separate instances. The `beforeAll` instance is never cleaned up.

**Changes:**

1. Add module-level admin variable. After line 17 (`const uploadedKeys: string[] = [];`), add:
```typescript
let admin: ReturnType<typeof getAdminClient>;
```

Note: Also need to import `type SupabaseClient` from `@supabase/supabase-js` if using that type, OR use `ReturnType<typeof getAdminClient>` to avoid a new import.

2. In `beforeAll` (line 28), change from:
```typescript
const admin = getAdminClient();
```
to:
```typescript
admin = getAdminClient();
```

3. In `afterAll` (line 33), remove the local `const admin = getAdminClient();` and use the module-level admin. Then add cleanup at the end:
```typescript
afterAll(async () => {
  if (uploadedKeys.length > 0) {
    await admin.storage.from(TEST_BUCKET).remove(uploadedKeys);
  }
  await admin.storage.deleteBucket(TEST_BUCKET).catch(() => {});

  // Clean up client connections to prevent dangling handles
  await admin.removeAllChannels();
});
```

### File 4: `web/__tests__/integration/schema-contract.test.ts`

**Current state:** Has `admin` at module level (line ~33: `let admin: SupabaseClient;`). Has `beforeAll` but NO `afterAll`. The vitest import on line 5 is:
```typescript
import { describe, it, expect, beforeAll } from "vitest";
```

**Changes:**

1. Update the import to include `afterAll`:
```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
```

2. Add `afterAll` block after the `beforeAll` block (which ends around line 42):
```typescript
afterAll(async () => {
  await admin.removeAllChannels();
});
```

## Why Both `removeAllChannels()` and `auth.signOut()`

- `removeAllChannels()` cleans up the Realtime module's WebSocket connection manager
- `auth.signOut()` tears down the GoTrue session and releases any internal timers
- Admin and anon clients don't have active auth sessions, so `signOut()` is skipped for them
- Together these cover both connection types that keep Node.js handles alive

## Known Limitation

`createTestUser()` in `setup.ts` internally calls `getAdminClient()`, creating ephemeral admin clients that are never cleaned up. This is out of scope — fixing it would require refactoring `createTestUser` to accept an admin parameter.

## Testing

### Pre-implementation
- Run `npm run test:integration` and observe "something prevents the main process from exiting" warning

### Post-implementation
- Run `npm run test:integration` — all tests pass AND process exits cleanly (no warning)
- No test regressions (all existing assertions still pass)
