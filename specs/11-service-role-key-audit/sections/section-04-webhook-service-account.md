I now have all the context I need. Let me compose the section content.

# Section 04: Webhook Service Account + RLS Policy

## Overview

The WhatsApp webhook (`web/app/api/whatsapp/route.ts`) currently relies on the agent core creating admin clients internally (via `createAdminClient()` which uses `SUPABASE_SERVICE_ROLE_KEY`). After section 03 refactors the agent core to accept a `SupabaseClient` parameter, the webhook needs its own client to pass in.

Instead of using the service role key (which bypasses ALL security), this section creates a narrowly-scoped webhook service account -- a real Supabase auth user with specific RLS policies granting cross-user access. This is the minimum-privilege approach: only one specific user ID gets cross-user access, and that user is a service account with no interactive login.

**Dependency:** Section 03 (agent core refactor) must be completed first. The agent core functions must already accept a `SupabaseClient` parameter.

## What This Section Delivers

1. A Supabase migration that creates the webhook service account user (`webhook@sitemgr.internal`)
2. RLS policies granting the webhook service account cross-user access to the tables it needs
3. A `GRANT EXECUTE` on `get_user_id_from_phone` to the `authenticated` role
4. Updates to `web/app/api/whatsapp/route.ts` to authenticate as the webhook service account
5. Integration tests verifying the RLS boundaries
6. Unit test updates verifying the webhook handler uses the service account pattern

## Tests First

### Integration Test: `web/__tests__/integration/webhook-service-account.test.ts` (new)

This file validates the database-level behavior of the webhook service account. It requires a running local Supabase instance with the new migration applied.

```
Test: webhook service account user exists in auth.users (email = webhook@sitemgr.internal)
Test: webhook service account can sign in with signInWithPassword
Test: webhook service account can call get_user_id_from_phone RPC
Test: webhook service account can read events belonging to another user
Test: webhook service account can read enrichments belonging to another user
Test: webhook service account can read/write conversations belonging to another user
Test: webhook service account can read bucket_configs belonging to another user
Test: regular authenticated user CANNOT read events belonging to another user (RLS still enforced)
Test: regular authenticated user CANNOT call get_user_id_from_phone (or can but only sees own phone)
Test: anon client CANNOT read any user's events (RLS enforced)
```

The test file structure:

- **Setup:** Use `createTestUser()` from `web/__tests__/integration/setup.ts` to create a regular test user. Use `seedUserData()` to populate data for that user. Sign in as the webhook service account using `signInWithPassword`.
- **Assertions:** The webhook account client can read the regular user's events, enrichments, conversations, and bucket_configs. A separate regular user client cannot read those rows. An anon client cannot read any rows.
- **Teardown:** Use `cleanupUserData()` and `cleanupTestData()` for cleanup.

The webhook service account credentials for local testing come from the migration (the password is set in the migration SQL). The test needs to know the password. Use `vi.stubEnv("WEBHOOK_SERVICE_ACCOUNT_PASSWORD", "<the-password>")` or read it from the environment. For local dev, the password can be a well-known test value since the local Supabase instance is ephemeral.

### Unit Test: `web/__tests__/whatsapp-route.test.ts` (modify existing)

Add these test cases to the existing file:

```
Test: WhatsApp webhook handler creates a webhook service account client (not admin client)
Test: WhatsApp webhook handler does not reference SUPABASE_SERVICE_ROLE_KEY
Test: WhatsApp webhook handler passes client to resolveUserId
Test: WhatsApp webhook handler passes client to getConversationHistory and saveConversationHistory
```

The existing test file at `web/__tests__/whatsapp-route.test.ts` already mocks `@/lib/agent/core`. After section 03, the agent core functions will have a new signature that includes a `SupabaseClient` as the first parameter. The mock setup and assertions need to change:

- Mock `@/lib/media/db` to capture the `getUserClient` call and verify it is called (not `getAdminClient`)
- Add `vi.stubEnv("WEBHOOK_SERVICE_ACCOUNT_EMAIL", "webhook@sitemgr.internal")` and `vi.stubEnv("WEBHOOK_SERVICE_ACCOUNT_PASSWORD", "test-webhook-password")` in `beforeEach`
- Verify that `resolveUserId` is called with a client as first argument (i.e., `mockResolveUserId.mock.calls[0][0]` is a Supabase client object)
- Verify that `getConversationHistory` and `saveConversationHistory` are called with a client as first argument
- Verify that `executeAction` is called with a client as first argument
- Verify no reference to `SUPABASE_SERVICE_ROLE_KEY` in the route module (static analysis or checking `process.env` access)

## Implementation Details

### 1. Supabase Migration

Create a new migration file. The filename should follow the existing naming convention with a timestamp after the latest migration (`20260320100000`).

**File:** `supabase/migrations/20260321000000_webhook_service_account.sql`

The migration does three things:

#### a) Create the webhook service account user

```sql
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM auth.users WHERE email = 'webhook@sitemgr.internal'
  ) THEN
    INSERT INTO auth.users (
      id, email, encrypted_password, email_confirmed_at,
      role, aud, instance_id
    ) VALUES (
      '00000000-0000-0000-0000-000000000001',
      'webhook@sitemgr.internal',
      crypt('unused-password-webhook-uses-service-token', gen_salt('bf')),
      now(),
      'authenticated',
      'authenticated',
      '00000000-0000-0000-0000-000000000000'
    );
  END IF;
END $$;
```

Key details:
- Fixed UUID `00000000-0000-0000-0000-000000000001` so RLS policies can reference it deterministically
- The `instance_id` must be `00000000-0000-0000-0000-000000000000` (Supabase default)
- The password is set here but in production will be overridden via `WEBHOOK_SERVICE_ACCOUNT_PASSWORD` env var. For local dev, this value works as the known test password.
- `email_confirmed_at = now()` so the account can sign in immediately
- `role = 'authenticated'` and `aud = 'authenticated'` match Supabase Auth conventions

**Important:** Also insert into `auth.identities` for Supabase Auth to recognize the user for `signInWithPassword`:

```sql
-- Also insert identity record so signInWithPassword works
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM auth.identities WHERE user_id = '00000000-0000-0000-0000-000000000001'
  ) THEN
    INSERT INTO auth.identities (
      id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at
    ) VALUES (
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000001',
      jsonb_build_object('sub', '00000000-0000-0000-0000-000000000001', 'email', 'webhook@sitemgr.internal'),
      'email',
      '00000000-0000-0000-0000-000000000001',
      now(), now(), now()
    );
  END IF;
END $$;
```

#### b) Add RLS policies for webhook service account cross-user access

Add policies on every table the webhook needs. The webhook service account UUID is `00000000-0000-0000-0000-000000000001`. The policies use `FOR ALL` to cover SELECT, INSERT, UPDATE, DELETE in one policy.

Tables that need webhook access (based on agent core function usage in `web/lib/agent/core.ts`):
- `events` -- read/write (executeAction inserts events during indexBucket)
- `enrichments` -- read/write (executeAction inserts enrichments)
- `watched_keys` -- read/write (indexBucket upserts watched keys)
- `conversations` -- read/write (getConversationHistory, saveConversationHistory)
- `bucket_configs` -- read (getBucketConfig, listBuckets, addBucket, removeBucket)
- `user_profiles` -- read (used by get_user_id_from_phone, but that is SECURITY DEFINER so no RLS policy needed)
- `model_configs` -- read (getModelConfig reads it for enrichment)

The policy pattern for each table:

```sql
CREATE POLICY "Webhook service account can access all <table>"
ON <table> FOR ALL
TO authenticated
USING (
  (SELECT auth.uid()) = '00000000-0000-0000-0000-000000000001'::uuid
)
WITH CHECK (
  (SELECT auth.uid()) = '00000000-0000-0000-0000-000000000001'::uuid
);
```

Apply this pattern for: `events`, `enrichments`, `watched_keys`, `conversations`, `bucket_configs`, `model_configs`.

Note: The existing user-scoped policies remain unchanged. The webhook policy is additive -- Postgres RLS uses OR logic across policies. A row is accessible if ANY policy's USING clause returns true.

#### c) Grant `get_user_id_from_phone` to `authenticated`

The function is currently restricted to `service_role` only (set in migration `20260313000000_rpc_user_isolation.sql`). The webhook service account has role `authenticated`, so it needs the grant:

```sql
GRANT EXECUTE ON FUNCTION get_user_id_from_phone(TEXT) TO authenticated;
```

This is acceptable security-wise: the function requires a valid authenticated session (not anonymous), and phone-to-user mapping is not sensitive information for authenticated users.

### 2. Update `web/app/api/whatsapp/route.ts`

After section 03 completes, the agent core functions accept a `SupabaseClient` as their first parameter. The webhook handler needs to:

1. Create a Supabase client using the anon key
2. Sign in as the webhook service account
3. Pass the authenticated client to all agent core functions

Add a helper function `createWebhookClient()`:

```typescript
import { getUserClient } from "@/lib/media/db";
import type { SupabaseClient } from "@supabase/supabase-js";

async function createWebhookClient(): Promise<SupabaseClient> {
  const client = getUserClient({
    url: process.env.NEXT_PUBLIC_SUPABASE_URL!,
    anonKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  });

  const email = process.env.WEBHOOK_SERVICE_ACCOUNT_EMAIL;
  const password = process.env.WEBHOOK_SERVICE_ACCOUNT_PASSWORD;

  if (!email || !password) {
    throw new Error("Webhook service account credentials not configured");
  }

  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) {
    throw new Error(`Webhook service account auth failed: ${error.message}`);
  }

  return client;
}
```

Then update the `POST` handler to use this client. The key changes in the route handler body:

- Call `const client = await createWebhookClient()` at the top of the try block
- Pass `client` as the first argument to `resolveUserId(client, fromNumber)`
- Pass `client` as the first argument to `getConversationHistory(client, fromNumber, userId)`
- Pass `client` as the first argument to `executeAction(client, plan, fromNumber, userId)`
- Pass `client` as the first argument to `saveConversationHistory(client, fromNumber, history, userId)`

Remove any import of `getAdminClient` if present. The route should NOT reference `SUPABASE_SERVICE_ROLE_KEY` anywhere.

### 3. Environment Variables

Two new environment variables are needed:

| Variable | Value | Where |
|----------|-------|-------|
| `WEBHOOK_SERVICE_ACCOUNT_EMAIL` | `webhook@sitemgr.internal` | Vercel Production, local `.env.local` |
| `WEBHOOK_SERVICE_ACCOUNT_PASSWORD` | Generated secure password | Vercel Production, local `.env.local` |

For **local development**, the password matches what the migration sets (`unused-password-webhook-uses-service-token` from the SQL above). For production, generate a strong password and set it in Vercel. Then update the webhook service account's password in production Supabase via the admin API or dashboard.

Add these to `scripts/local-dev.sh` output (section 01 generates the `.env.local` file):

```bash
# --- Webhook service account (for WhatsApp webhook) ---
WEBHOOK_SERVICE_ACCOUNT_EMAIL=webhook@sitemgr.internal
WEBHOOK_SERVICE_ACCOUNT_PASSWORD=unused-password-webhook-uses-service-token
```

### 4. Security Considerations

- The webhook service account is a **real Supabase Auth user** with role `authenticated`. It is not the service role key.
- Cross-user access is granted ONLY to UUID `00000000-0000-0000-0000-000000000001`. No other user gets this privilege.
- The account has no interactive login (no UI, no OAuth). Access is only via `signInWithPassword` from server-side code.
- If the webhook service account credentials leak, the blast radius is limited to the data accessible through the agent core functions. Unlike the service role key, it cannot bypass RLS for other tables, cannot access `auth.admin.*` APIs, and cannot create/delete users.
- The `get_user_id_from_phone` grant to `authenticated` is acceptable because it requires a valid session. Anonymous callers cannot use it.

### 5. Files Changed

| File | Action |
|------|--------|
| `supabase/migrations/20260321000000_webhook_service_account.sql` | **Create** -- migration with service account, RLS policies, and grant |
| `web/app/api/whatsapp/route.ts` | **Modify** -- add `createWebhookClient()`, pass client to agent core functions |
| `web/__tests__/integration/webhook-service-account.test.ts` | **Create** -- integration tests for RLS boundaries |
| `web/__tests__/whatsapp-route.test.ts` | **Modify** -- update mocks for new function signatures, add service account assertions |

### 6. Alternative Considered

Creating `SECURITY DEFINER` RPCs for every operation the webhook needs was considered. This avoids a service account but requires maintaining many RPCs that duplicate `db.ts` logic. The service account approach is simpler -- existing `db.ts` functions work as-is with the webhook client, and RLS policies are easier to audit than scattered SECURITY DEFINER functions.