# 15: CLI Bucket Config — Server-Side S3 Operations

## Problem

The CLI (`smgr.ts`) talks to S3 directly for `watch`, `add`, and `enrich` commands, requiring S3 credentials as env vars or CLI flags on every machine. This means:

- S3 credentials leak to every developer/CI machine
- Bucket configuration is scattered across env vars, CLI flags, and `.env.local`
- Adding a new bucket means reconfiguring every client
- No central view of which buckets exist or their status

## Current State (post spec 18)

Significant infrastructure already exists:

**Database:** `bucket_configs` table with `id`, `user_id`, `bucket_name`, `endpoint_url`, `region`, `access_key_id`, `secret_access_key` (AES-256-GCM encrypted), `encryption_key_version`, `last_synced_key`. RLS enforces user_id ownership. FK relationships to `events.bucket_config_id` and `watched_keys.bucket_config_id`.

**Web app:** Buckets management page (`/buckets`) with add/delete via server actions (`components/buckets/actions.ts`). Media proxy route (`/api/media/[id]`) already reads bucket_configs, decrypts credentials, and creates S3 clients.

**Agent:** `lib/agent/core.ts` has `addBucket`, `listBuckets`, `removeBucket`, `getBucketConfig`, `requireS3Client` functions that handle encryption, decryption, and lazy key migration.

**CLI (spec 18):** The CLI now talks only to the web API for all data operations (`apiFetch`/`apiGet`/`apiPost`). But `watch`, `add`, and `enrich` still use direct S3 via env vars (`SMGR_S3_BUCKET`, `SMGR_S3_ENDPOINT`, `SMGR_S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`).

**What's missing:** API routes for bucket CRUD and server-side S3 operations that the CLI can call.

## Goal

Move all S3 operations server-side. The CLI manages bucket configs and triggers S3 operations via the web API. S3 credentials never leave the server.

## Changes

### 1. Bucket CRUD API routes (new)

- `GET /api/buckets` — list user's bucket configs (id, bucket_name, region, endpoint_url, created_at, last_synced_key; no secrets)
- `POST /api/buckets` — add a bucket config (encrypts secret_access_key server-side)
- `DELETE /api/buckets/[id]` — remove a bucket config
- `POST /api/buckets/[id]/test` — server-side S3 connectivity test (list objects, confirm credentials work)

All routes use `authenticateRequest` from `lib/supabase/api-auth.ts` (Bearer token auth, per spec 18).

Encryption uses existing `encryptSecretVersioned`/`decryptSecretVersioned` from `lib/crypto/encryption-versioned.ts`.

### 2. Server-side S3 operation routes (new)

- `POST /api/buckets/[id]/scan` — server scans S3 bucket for new objects, creates events and watched_keys. Replaces CLI's `watch --once`. Accepts optional `prefix` param.
- `POST /api/buckets/[id]/upload` — server accepts file upload, stores in S3, creates event. Replaces CLI's `add <file>`.

These routes:
1. Fetch bucket config from DB (checking user_id via RLS)
2. Decrypt `secret_access_key`
3. Create S3 client
4. Perform operation
5. Insert events/watched_keys with `bucket_config_id` set

Pattern already exists in `lib/agent/core.ts` (`requireS3Client` + `getBucketConfig`). Extract shared helpers.

### 3. CLI updates (`web/bin/smgr.ts`)

**Add `bucket` subcommand group:**
- `smgr bucket add` — prompts for or accepts bucket config fields, calls `POST /api/buckets`
- `smgr bucket list` — calls `GET /api/buckets`, displays table
- `smgr bucket remove <id|name>` — calls `DELETE /api/buckets/[id]`
- `smgr bucket test <id|name>` — calls `POST /api/buckets/[id]/test`

**Update existing commands to use bucket_config_id:**
- `smgr watch` — calls `POST /api/buckets/[id]/scan` instead of direct S3. Requires `--bucket <name>` to identify which bucket config. Polling loop calls scan endpoint repeatedly.
- `smgr add <file>` — calls `POST /api/buckets/[id]/upload` instead of direct S3. Requires `--bucket <name>`.
- `smgr enrich` — downloads from S3 still needed (for sending image bytes to model). Two options:
  - (a) Add `GET /api/buckets/[id]/download/[key]` to proxy S3 downloads server-side
  - (b) Keep direct S3 download in CLI but get credentials from `GET /api/buckets/[id]` (leaks creds to CLI — defeats purpose)
  - **Choose (a)** — server proxies S3 downloads too. The media proxy (`/api/media/[id]`) already does this for the web app.

**Remove:**
- `resolveS3Args()` function
- `s3Options` (CLI flags: `--endpoint`, `--region`, `--access-key-id`, `--secret-access-key`)
- Direct `createS3Client`, `listS3Objects`, `downloadS3Object`, `uploadS3Object` imports
- All `SMGR_S3_*` and `S3_*` env var reads from CLI

### 4. Shared S3 helpers (refactor)

Extract from `lib/agent/core.ts` into a shared module (e.g. `lib/media/bucket-service.ts`):
- `getBucketConfig(supabase, userId, bucketName)` — fetch + decrypt
- `createS3ClientFromConfig(config)` — create S3 client from decrypted config
- `scanBucket(supabase, s3, config, userId, opts)` — scan for new objects, insert events/watched_keys

The agent core, API routes, and any future consumers all use the same helpers.

### 5. Env var cleanup

**Remove from CLI:**
- `SMGR_S3_ENDPOINT`
- `SMGR_S3_BUCKET`
- `SMGR_S3_REGION`
- `S3_ACCESS_KEY_ID`
- `S3_SECRET_ACCESS_KEY`

**Remove from `.env.example`:**
- Entire S3 / Storage section

**Keep in `scripts/lib.sh`:** S3 vars are still needed for integration test setup (test fixtures create S3 clients directly). These are test infrastructure concerns.

**CLI env after this spec:** `SMGR_WEB_URL` only (plus `SMGR_DEVICE_ID`, `SMGR_AUTO_ENRICH`, `ANTHROPIC_API_KEY` for enrichment).

### 6. Update integration tests

- `smgr-cli.test.ts`: No S3 env vars in CLI subprocess. Tests that use `watch`/`add` need a seeded bucket_config and the dev server running.
- `smgr-e2e.test.ts`: Same — S3 operations go through web API.
- Add tests for new bucket CRUD routes.
- Add tests for scan/upload routes.

## Out of Scope

- BYO S3 provider onboarding UI (future)
- Offline/local-first mode
- Presigned URL upload flow (direct upload through API proxy first)
- Continuous watch mode on the server (server-side background polling) — the CLI still orchestrates the poll loop, but each scan is a server-side API call

## Dependencies

- Spec 18 (CLI web API only) — **done**
- `bucket_configs` table — **exists**
- Encryption infrastructure — **exists**
- `authenticateRequest` Bearer token auth — **exists**
