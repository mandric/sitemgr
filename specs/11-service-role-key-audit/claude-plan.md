# Implementation Plan — 11-service-role-key-audit

## Background

The codebase uses the Supabase service role key (`SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_SECRET_KEY`) in application runtime code — the CLI, the agent core, the health endpoint, and instrumentation. This key bypasses RLS entirely, which means the application is doing privilege escalation when it doesn't need to.

Every consumer that uses the service role key already manually filters by `user_id` — reimplementing what RLS does automatically. The key should be removed from all application runtime code. The only legitimate uses are admin operations (test setup, migrations, CI deployment scripts).

Additionally, `scripts/local-dev.sh` contains an ES256 JWT workaround that manually signs JWTs by reaching into Docker containers — unnecessary since Supabase CLI ≥ 2.76.4.

## Goals

1. **Remove the service role key from all application runtime code** — CLI, agent core, health endpoint, instrumentation
2. **Delete the ES256 JWT workaround** in `local-dev.sh`
3. **Consolidate `SUPABASE_SECRET_KEY` → `SUPABASE_SERVICE_ROLE_KEY`** in remaining places (tests, CI, deployment scripts)
4. **Refactor the agent core** to accept a client parameter instead of creating admin clients internally
5. **Create a `SECURITY DEFINER` RPC** for the WhatsApp webhook's cross-user phone→user lookup
6. **Switch CLI from admin client to user client** — use stored JWT from `smgr login`
7. **Refactor integration tests** to use `db.ts`/`s3.ts` instead of raw Supabase SDK calls

## Architecture

Supabase is an implementation detail of the server. Only server-side code touches it. The auth provider (Supabase Auth) is separate config — both browser and CLI talk to it directly for login, then use user-scoped credentials for everything else.

| Layer | Auth (login) | Data operations | Supabase key used |
|-------|-------------|-----------------|-------------------|
| Browser | Supabase Auth directly (anon key) | Server components/actions (cookie session + RLS) | Anon key |
| CLI (`smgr`) | Supabase Auth directly (anon key) | Supabase PostgREST (user JWT + RLS) | Anon key |
| Web API — server actions | Cookie session from browser | Supabase PostgREST (user session + RLS) | Anon key |
| Web API — WhatsApp webhook | Twilio signature validation | SECURITY DEFINER RPCs + user-scoped queries | Anon key |
| Tests (setup/teardown only) | N/A | `auth.admin.*`, raw SDK | Service role key |
| CI deployment scripts | N/A | Storage bucket creation, migrations | Service role key |

**The service role key does not appear in any production application code path.**

## Section 1: Remove ES256 Workaround from `local-dev.sh`

### What to remove

Lines 61–91 contain the workaround that reaches into Docker containers to hand-sign ES256 JWTs. Delete the entire block. The keys from `supabase status -o json` work as-is on CLI ≥ 2.76.4.

### Capability probe

After extracting keys from `supabase status`, add a probe: `GET /auth/v1/admin/users?per_page=1` with `Authorization: Bearer ${SERVICE_ROLE_KEY}`. If it fails, error with: "Service role key rejected by GoTrue. Upgrade Supabase CLI to ≥ 2.76.4."

### Update env var output

Stop outputting the service role key for application use. The output becomes:

```bash
# --- Web app (Supabase) ---
NEXT_PUBLIC_SUPABASE_URL=${api_url}
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${anon_key}
DATABASE_URL=${db_url}

# --- CLI (auth provider — same Supabase instance in local dev) ---
SMGR_API_URL=${api_url}
SMGR_API_KEY=${anon_key}

# --- S3 / Storage ---
# ... (unchanged)

# --- Service role key (tests and admin scripts only — NOT for app code) ---
# SUPABASE_SERVICE_ROLE_KEY=${service_role_key}
```

The service role key is commented out in the generated `.env.local`. Tests and CI extract it separately from `supabase status -o json`. Application code never reads it.

## Section 2: Remove Service Role Key from Health Endpoint

**`web/app/api/health/route.ts`** currently uses `getAdminClient()` with `SUPABASE_SERVICE_ROLE_KEY` to run:

```typescript
.from("events").select("id", { count: "exact", head: true }).limit(0)
```

This is a connectivity check — it doesn't need elevated privileges. Switch to the anon key:

```typescript
import { getUserClient } from "@/lib/media/db";

const supabase = getUserClient({
  url: process.env.NEXT_PUBLIC_SUPABASE_URL!,
  anonKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
});
```

The query still proves DB connectivity. With the anon key + RLS, it returns count=0 for anonymous (no `auth.uid()`), which is fine — a non-error response means the DB is reachable.

## Section 3: Refactor Agent Core — Remove `createAdminClient()`

This is the largest change. `web/lib/agent/core.ts` calls `createAdminClient()` ~15 times. Every call manually filters by `userId` — exactly what RLS does.

### Design: dependency-inject the Supabase client

Remove the internal `createAdminClient()` function. Instead, every function that needs a DB client receives one as a parameter.

**Functions that change signature:**

| Function | Current | New |
|----------|---------|-----|
| `resolveUserId(phone)` | Creates admin client internally | `resolveUserId(client, phone)` |
| `executeAction(plan, phone, userId?)` | Creates admin client per action | `executeAction(client, plan, phone, userId?)` |
| `getConversationHistory(phone, userId?)` | Creates admin client internally | `getConversationHistory(client, phone, userId?)` |
| `saveConversationHistory(phone, history, userId?)` | Creates admin client internally | `saveConversationHistory(client, phone, history, userId?)` |
| `addBucket(phone, params, userId)` | Creates admin client internally | `addBucket(client, phone, params, userId)` |
| `listBuckets(phone, userId)` | Creates admin client internally | `listBuckets(client, phone, userId)` |
| `removeBucket(phone, bucketName, userId)` | Creates admin client internally | `removeBucket(client, phone, bucketName, userId)` |
| `getBucketConfig(phone, bucketName, userId?)` | Creates admin client internally | `getBucketConfig(client, phone, bucketName, userId?)` |
| `indexBucket(phone, bucketName, prefix?, batchSize?, userId?)` | Creates admin client internally | `indexBucket(client, phone, bucketName, prefix?, batchSize?, userId?)` |

### Callers provide the client

**Web chat path** (`components/agent/actions.ts`):

The server action already has a user session via `createClient()` from `server.ts`. Pass it through:

```typescript
const supabase = await createClient(); // cookie-based, user-scoped
const { data: { user } } = await supabase.auth.getUser();
// ...
const history = await getConversationHistory(supabase, "web", user.id);
```

**WhatsApp webhook path** (`app/api/whatsapp/route.ts`):

The webhook has no user session. It authenticates via Twilio signature. Two sub-problems:

1. **Phone→user lookup (`resolveUserId`)**: This is a cross-user query — it needs to find a user by phone number regardless of who's calling. Solution: call the existing `get_user_id_from_phone` RPC which is already `SECURITY DEFINER`. Currently it's restricted to `service_role` — grant it to `authenticated` and use a webhook service account (see Section 4).

2. **User-scoped data operations**: Once we have the `userId`, all data queries filter by it. With a user-scoped client + RLS, this works if the client's `auth.uid()` matches the target user. Solution: the webhook service account gets a special RLS policy allowing cross-user access (see Section 4).

### Remove `getAdminClient` import

After this refactor, `agent/core.ts` no longer imports `getAdminClient` from `db.ts`. It receives a `SupabaseClient` and uses it.

### Remove `SUPABASE_SERVICE_ROLE_KEY` from agent core

Delete the `createAdminClient()` function and the `process.env.SUPABASE_SERVICE_ROLE_KEY` reference from `agent/core.ts`.

## Section 4: Webhook Service Account + RLS Policy

The WhatsApp webhook needs to operate on behalf of users without their session. Instead of using the service role key (which bypasses ALL security), create a narrowly-scoped webhook service account.

### Create the webhook service account

Add a migration that creates a Supabase auth user for the webhook:

```sql
-- Create webhook service account (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM auth.users WHERE email = 'webhook@sitemgr.internal'
  ) THEN
    -- Insert via auth.users directly (SECURITY DEFINER context)
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

### Add RLS policies for webhook access

Add policies that allow the webhook service account to read/write data for any user:

```sql
-- Webhook service account can read all users' events
CREATE POLICY "Webhook can access all events"
ON events FOR ALL
USING (auth.uid() = '00000000-0000-0000-0000-000000000001'::uuid);

-- Same for enrichments, watched_keys, conversations, bucket_configs
```

This is narrowly scoped: only one specific user ID gets cross-user access, and that user is a service account with no interactive login.

### Grant `get_user_id_from_phone` to authenticated

```sql
GRANT EXECUTE ON FUNCTION get_user_id_from_phone(TEXT) TO authenticated;
```

Currently restricted to `service_role` only. The webhook service account needs it.

### Webhook handler creates a service account client

The webhook handler authenticates as the webhook service account:

```typescript
// In whatsapp/route.ts
import { getUserClient } from "@/lib/media/db";

function createWebhookClient() {
  const client = getUserClient({
    url: process.env.NEXT_PUBLIC_SUPABASE_URL!,
    anonKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  });
  // Authenticate as webhook service account
  // Credentials stored in env vars (NOT the service role key)
  return client;
}
```

**Environment variables for the webhook service account:**
- `WEBHOOK_SERVICE_ACCOUNT_EMAIL=webhook@sitemgr.internal`
- `WEBHOOK_SERVICE_ACCOUNT_PASSWORD=<generated>`

These are real Supabase auth credentials for a specific user — not the god-mode service role key.

### Alternative considered: SECURITY DEFINER RPCs for everything

We could create SECURITY DEFINER RPCs for every operation the webhook needs and call them with the anon key. This avoids a service account but requires maintaining many RPCs that duplicate `db.ts` logic. The service account approach is simpler — existing `db.ts` functions work as-is, they just get a different client.

## Section 5: Switch CLI from Admin Client to User Client

The CLI currently uses `getAdminClient()` with `SUPABASE_SECRET_KEY`. Switch to `getUserClient()` with the stored JWT from `smgr login`.

### Target state

```typescript
async function getClient() {
  const { url, anonKey } = resolveApiConfig();  // SMGR_API_URL + SMGR_API_KEY
  const client = getUserClient({ url, anonKey });

  const creds = await refreshSession();
  if (!creds) {
    cliError("Not logged in. Run 'smgr login' first.", EXIT.USER);
  }

  const { error } = await client.auth.setSession({
    access_token: creds.access_token,
    refresh_token: creds.refresh_token,
  });
  if (error) {
    cliError(`Session invalid: ${error.message}. Run 'smgr login'.`, EXIT.USER);
  }

  return client;
}
```

### What changes

1. **`getClient()` becomes `async`** — all callers add `await getClient()`.
2. **Import `getUserClient` instead of `getAdminClient`** from `db.ts`, and `refreshSession` from `cli-auth.ts`.
3. **Remove all `SUPABASE_SECRET_KEY` / `SUPABASE_SERVICE_ROLE_KEY` references** from the CLI. It only needs `SMGR_API_URL` and `SMGR_API_KEY`.
4. **Update help text** — remove service role key from Environment section.
5. **Update CLI tests** — stop passing `SUPABASE_SECRET_KEY` to the subprocess.

### Why this works

- Every `db.ts` function already filters by `userId` (belt-and-suspenders with RLS)
- `cli-auth.ts` already implements `login()`, `refreshSession()`, `loadCredentials()`, `resolveApiConfig()`
- The stored JWT has the user's `sub` claim — RLS checks `auth.uid()` against it
- S3 operations use `createS3Client()` which reads `SMGR_S3_*` env vars — independent of Supabase auth

## Section 6: Remove Service Role Key from Instrumentation

**`web/instrumentation.ts`** currently validates `SUPABASE_SECRET_KEY` as a required env var. Since no application code reads the service role key anymore, remove it from the required list:

```typescript
const required = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  // SUPABASE_SERVICE_ROLE_KEY removed — not used by application code
];
```

Also update the comment in `cli-auth.ts` line 6 which references `SUPABASE_SECRET_KEY`.

## Section 7: Consolidate Remaining `SUPABASE_SECRET_KEY` References

After removing the service role key from application code, `SUPABASE_SECRET_KEY` still appears in test setup, CI, and docs. Rename all remaining occurrences to `SUPABASE_SERVICE_ROLE_KEY` for consistency with Supabase's naming.

### Files to rename

**Test files:**
- `web/__tests__/integration/setup.ts` — `SUPABASE_SERVICE_KEY` reads from `process.env.SUPABASE_SECRET_KEY` → `process.env.SUPABASE_SERVICE_ROLE_KEY`
- `web/__tests__/integration/smgr-cli.test.ts` — passes `SUPABASE_SECRET_KEY` to subprocess → `SUPABASE_SERVICE_ROLE_KEY` (only needed for test setup, not CLI itself)
- `web/__tests__/integration/smgr-e2e.test.ts` — same
- `web/__tests__/phone-migration-app.test.ts` — already uses `SUPABASE_SERVICE_ROLE_KEY` ✅
- `web/__tests__/agent-core.test.ts` — already uses `SUPABASE_SERVICE_ROLE_KEY` ✅

**CI:**
- `.github/workflows/ci.yml` — `SUPABASE_SECRET_KEY` → `SUPABASE_SERVICE_ROLE_KEY` in integration test job. Keep it for test setup (creating users) but not for app runtime.

**Config:**
- `web/.env.example` — rename and add comment: "Only for tests and admin scripts"
- `.env.example` — same
- `scripts/setup/verify.sh` — rename the checked var

**Docs:**
- `docs/ENV_VARS.md` — rename and document that it's test/admin only
- `docs/QUICKSTART.md` — rename
- `docs/DEPLOYMENT.md` — rename

## Section 8: Refactor Integration Tests to Use App Layer

While touching every test file for the above changes, also refactor tests to call our code instead of raw Supabase SDK.

### Principle

Test assertions call our code (`db.ts`, `s3.ts`). Test setup/teardown can use admin SDK (no app-layer equivalent for `auth.admin.createUser()`).

**Exception:** `tenant-isolation.test.ts` intentionally uses raw SDK to prove RLS works at the database level. Leave as-is.

### What changes

**`media-lifecycle.test.ts`:**
- `admin.from("events").insert({...})` → `insertEvent(admin, eventData)`

**Test files import app functions directly** from `@/lib/media/db` — no re-exports through `setup.ts`.

### Files already correct

- `media-storage.test.ts` — already uses `uploadS3Object()` from `s3.ts` ✅
- `auth-smoke.test.ts` — already uses `getAdminClient()` and `getUserClient()` from `db.ts` ✅

## Section 9: Add Next.js Dev Server to `globalSetup.ts`

Auth smoke tests need to hit `/api/*` endpoints.

1. After validating Supabase connectivity, check if port 3000 is in use
2. If not, spawn `npm run dev` with `PORT` set
3. Poll `http://localhost:{port}/api/health` until 200 (timeout 60s)
4. Store child process on `globalThis.__WEB_SERVER__`
5. In teardown, kill if we spawned it

## Section 10: Update CI Workflow

### Integration tests job

- `SUPABASE_SECRET_KEY` → `SUPABASE_SERVICE_ROLE_KEY` (for test setup only)
- Add `WEBHOOK_SERVICE_ACCOUNT_PASSWORD` if webhook tests exist

### Deployment job

- Storage bucket creation curl uses service role key in `Authorization` header — this is an admin operation, keep but rename to `SUPABASE_SERVICE_ROLE_KEY`

### Manual steps

- **Vercel Production:** Remove `SUPABASE_SECRET_KEY`, add `WEBHOOK_SERVICE_ACCOUNT_EMAIL` and `WEBHOOK_SERVICE_ACCOUNT_PASSWORD`
- **GitHub Production Environment:** Rename `SUPABASE_SECRET_KEY` → `SUPABASE_SERVICE_ROLE_KEY` (only needed for deployment scripts, not app runtime)
- Document in PR description

## Section 11: Update Config and Documentation

### `.env.example` files

Remove service role key from app section, keep in test/admin section with clear comment.

### `docs/ENV_VARS.md`

Document the new architecture:
- Application code never uses the service role key
- Browser and CLI both use anon key + user JWT
- WhatsApp webhook uses a service account (not god-mode key)
- Service role key only for test setup and deployment scripts

### `CLAUDE.md`

Update the Environment Variables & Secrets Strategy section to reflect that `SUPABASE_SERVICE_ROLE_KEY` is test/admin only.

## Implementation Order

1. **Section 1** (ES256 workaround) — Foundation, `local-dev.sh` generates the env file
2. **Section 2** (Health endpoint) — Simple, isolated change
3. **Section 3** (Agent core refactor) — Largest change, dependency-inject clients
4. **Section 4** (Webhook service account) — New migration + RLS policies
5. **Section 5** (CLI user client) — Switch from admin to user JWT
6. **Section 6** (Instrumentation) — Remove from required vars
7. **Section 7** (Rename remaining) — Mechanical find-and-replace in tests/CI
8. **Section 8** (Test refactor) — Use app layer functions
9. **Section 9** (Dev server in globalSetup) — Test infrastructure
10. **Section 10** (CI workflow) — Depends on sections 7-8
11. **Section 11** (Config/docs) — Last, documents final state

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| RLS policies missing for tables the agent accesses | Verify RLS on `events`, `enrichments`, `watched_keys`, `conversations`, `bucket_configs`, `user_profiles` before switching; the RLS audit from spec 01 should have covered these |
| Webhook service account bypasses intended RLS | Policies are narrowly scoped to one UUID; review in PR |
| `get_user_id_from_phone` exposed to `authenticated` role | Acceptable — requires a valid user session, not anonymous. Phone→user mapping is not sensitive when you're already authenticated |
| CLI `setSession()` fails with expired token | `refreshSession()` called first; if refresh fails, prompt re-login |
| Agent core refactor breaks WhatsApp webhook | Test webhook path with service account before removing admin client |
| Integration tests need service role key for setup | Keep it in test-only code (`setup.ts`), just not in app code |
| Vercel production expects old env var names | Document manual rename steps in PR description; coordinate deploy |
