# Codebase Research — 11-service-role-key-audit

## Key Findings

### 1. ES256 Workaround (`scripts/local-dev.sh` lines 61-91)

The workaround:
1. Finds running `supabase_auth_*` Docker container
2. Extracts `GOTRUE_JWT_KEYS` env var
3. Parses JWKS for EC private key with `alg: "ES256"` and `d` component
4. Hand-signs JWT: `{iss: "supabase-local", role: "service_role", exp: 9999999999}`
5. Uses this as `SUPABASE_SECRET_KEY`

No longer needed with CLI ≥ 2.76.4.

### 2. Env Var Output (`scripts/local-dev.sh` lines 93-122)

Currently outputs both canonical and alias names:
```bash
NEXT_PUBLIC_SUPABASE_URL=${api_url}
SMGR_API_URL=${api_url}                    # alias
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${anon_key}
SMGR_API_KEY=${anon_key}                   # alias
SUPABASE_SECRET_KEY=${supabase_secret_key} # wrong canonical name
```

### 3. `scripts/setup/verify.sh` (56 lines)

Checks: `SMGR_API_URL`, `SMGR_API_KEY`, `SUPABASE_SECRET_KEY`, `ENCRYPTION_KEY_CURRENT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`. Also does connectivity test with curl.

### 4. Application Code

**`web/bin/smgr.ts:46-51`** — CLI client factory:
```typescript
function getClient() {
  return getAdminClient({
    url: process.env.SMGR_API_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL!,
    serviceKey: process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY!,
  });
}
```
Prefers old names, falls back to canonical.

**`web/lib/auth/cli-auth.ts:103-109`** — CLI auth:
```typescript
export function resolveApiConfig(): { url: string; anonKey: string } {
  const url = process.env.SMGR_API_URL?.trim();
  const anonKey = process.env.SMGR_API_KEY?.replace(/\s+/g, "");
  // ...
}
```
Only uses `SMGR_API_URL` and `SMGR_API_KEY`.

**`web/instrumentation.ts:9-35`** — Validates `SUPABASE_SECRET_KEY` (inconsistent with server code which reads `SUPABASE_SERVICE_ROLE_KEY`).

**`web/app/api/health/route.ts`** and **`web/lib/agent/core.ts`** — Already use `SUPABASE_SERVICE_ROLE_KEY` (correct canonical name).

### 5. Database/S3 API Surface

**`web/lib/media/db.ts` (446 lines)**

Client factories:
- `getAdminClient({url, serviceKey})` — admin client (bypasses RLS)
- `getUserClient({url, anonKey})` — user client (respects RLS)

Query functions:
- `queryEvents(client, opts)` — full-text search or filtered query
- `showEvent(client, eventId, userId?)` — single event
- `getStats(client, opts?)` — counts by type/content
- `getEnrichStatus(client, userId?)` — pending enrichment count
- `findEventByHash(client, hash, userId?)` — duplicate check
- `getPendingEnrichments(client, userId?)` — unenriched photos

Write functions:
- `insertEvent(client, event)` — create event
- `insertEnrichment(client, eventId, result, userId?)` — save enrichment
- `upsertWatchedKey(client, s3Key, eventId, etag, sizeBytes, userId?, bucketConfigId?)` — track S3 objects

Read functions:
- `getWatchedKeys(client, userId?)` — list tracked keys
- `getModelConfig(client, userId, provider?)` — active model config

All return `{ data, error }` pattern (no re-wrapping, per CLAUDE.md).

**`web/lib/media/s3.ts` (229 lines)**

- `createS3Client(config?)` — AWS SDK S3Client
- `listS3Objects(client, bucket, prefix?)` — with pagination, v2→v1 fallback
- `downloadS3Object(client, bucket, key)` — download with error classification
- `uploadS3Object(client, bucket, key, body, contentType?)` — upload

### 6. Integration Tests — Current State

**`setup.ts` (287 lines):**
```typescript
const SUPABASE_URL = process.env.SMGR_API_URL ?? "http://127.0.0.1:54321";
const SUPABASE_ANON_KEY = process.env.SMGR_API_KEY ?? "";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SECRET_KEY ?? "";
```
Helpers: `getSupabaseConfig()`, `getAdminClient()`, `createTestUser()`, `cleanupTestData()`, `seedUserData()`, `cleanupUserData()`, `getS3Config()`, `assertInsert()`. No re-exports of `db.ts`/`s3.ts`.

**`globalSetup.ts` (37 lines):** Checks if Supabase is running. Does NOT start Next.js dev server.

**`tenant-isolation.test.ts`** — Uses raw SDK:
```typescript
await aliceClient.from("events").select("*");
await aliceClient.from("enrichments").select("*");
await aliceClient.from("watched_keys").select("*");
```

**`media-lifecycle.test.ts`** — Uses raw SDK for inserts:
```typescript
await admin.from("events").insert({...});
await admin.from("bucket_configs").insert({...});
```

**`media-storage.test.ts`** — Already uses `uploadS3Object()` from `s3.ts` ✅

**`smgr-cli.test.ts` and `smgr-e2e.test.ts`** — Pass env vars `SMGR_API_URL`, `SMGR_API_KEY`, `SUPABASE_SECRET_KEY` to CLI subprocess.

**`auth-smoke.test.ts`** — Already uses `getAdminClient()` and `getUserClient()` from `db.ts` ✅

### 7. CI Workflow (`.github/workflows/ci.yml`)

Integration tests job extracts:
```bash
echo "SMGR_API_URL=$(echo "$STATUS_JSON" | jq -r .API_URL)" >> $GITHUB_ENV
echo "SMGR_API_KEY=$(echo "$STATUS_JSON" | jq -r .ANON_KEY)" >> $GITHUB_ENV
echo "SUPABASE_SECRET_KEY=$(echo "$STATUS_JSON" | jq -r .SERVICE_ROLE_KEY)" >> $GITHUB_ENV
```

Deployment job also references `SUPABASE_SECRET_KEY` for storage bucket creation with curl.

### 8. Config Files

**`web/.env.example`:** Has both `SUPABASE_SECRET_KEY` and `SMGR_API_URL`/`SMGR_API_KEY` aliases.

**`.env.example`:** Has `SUPABASE_SECRET_KEY` for deployment.

**`docs/ENV_VARS.md`:** Documents encryption keys but not the 6→4 consolidation.

### 9. Test Framework

- **Vitest** with two projects: `unit` (excludes integration) and `integration` (sequential, 60s timeout)
- Global setup: `__tests__/integration/globalSetup.ts`
- `npm test` = unit, `npm run test:integration` = integration

### 10. Unit Tests

**`agent-core.test.ts`** and **`phone-migration-app.test.ts`** — Mock `db.ts` and stub `SUPABASE_SERVICE_ROLE_KEY` (already using canonical name ✅). Don't connect to real Supabase.

## Summary: What Needs Changing

| Category | Status |
|----------|--------|
| ES256 workaround | Delete + add version check |
| `SUPABASE_SECRET_KEY` → `SUPABASE_SERVICE_ROLE_KEY` | 8+ files |
| `SMGR_API_URL` → `NEXT_PUBLIC_SUPABASE_URL` | 5+ files |
| `SMGR_API_KEY` → `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | 5+ files |
| Raw SDK → `db.ts` in tests | 2-3 test files |
| Raw SDK → `s3.ts` in tests | Already done ✅ |
| Next.js dev server in globalSetup | New addition |
| Auth smoke tests | Already exists ✅ |
