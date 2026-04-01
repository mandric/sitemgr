# 15: CLI Bucket Config — Server-Side S3 Operations

## Problem

The CLI (`smgr.ts`) talks to S3 directly for `watch`, `add`, and `enrich` commands, requiring S3 credentials as env vars or CLI flags on every machine that runs the CLI. This means:

- S3 credentials leak to every developer/CI machine
- Bucket configuration is scattered across env vars, CLI flags, and `.env.local`
- Adding a new bucket means reconfiguring every client
- No central view of which buckets exist or their status

## Current State (post spec 18)

Significant infrastructure already exists:

**Database:** `bucket_configs` table with `id`, `user_id`, `bucket_name`, `endpoint_url`, `region`, `access_key_id`, `secret_access_key` (AES-256-GCM encrypted), `encryption_key_version`, `last_synced_key`. RLS enforces user_id ownership. FK relationships to `events.bucket_config_id` and `watched_keys.bucket_config_id`.

**Web app:** Buckets management page (`/buckets`) with add/delete via server actions (`components/buckets/actions.ts`). Media proxy route (`/api/media/[id]`) already reads bucket_configs, decrypts credentials, and creates S3 clients.

**Agent:** `lib/agent/core.ts` has `addBucket`, `listBuckets`, `removeBucket`, `getBucketConfig`, `requireS3Client` functions that handle encryption, decryption, and lazy key migration.

**CLI (spec 18):** The CLI talks only to the web API for all data operations (`apiFetch`/`apiGet`/`apiPost`). But `watch`, `add`, and `enrich` still use direct S3 via env vars.

**What's missing:** API routes for bucket CRUD and server-side S3 operations that the CLI can call.

## Goal

The bucket is the primary resource. All S3 operations happen server-side. The CLI is a thin HTTP client — no AWS SDK, no S3 credentials, no model API keys. The server owns all I/O: S3 uploads, downloads, listing, scanning, and enrichment.

## CLI UX

```
smgr bucket add                         # register a new bucket config (interactive or flags)
smgr bucket list                        # list user's bucket configs
smgr bucket test <bucket>               # server-side S3 connectivity check
smgr bucket remove <bucket>             # delete a bucket config

smgr add <bucket> <file>                # upload file to bucket via API
smgr watch <bucket> [--once] [--prefix] # server scans bucket for new objects
smgr enrich <bucket> [--pending]        # server enriches unenriched images in bucket
smgr query [--bucket <name>]            # query events, optionally filtered by bucket
smgr show <event_id>                    # show single event (unchanged)
smgr stats [--bucket <name>]            # stats, optionally per bucket
```

`<bucket>` is the `bucket_name` from `bucket_configs`. The server resolves it to the full config (endpoint, credentials, region) via the DB.

## Changes

### 1. Bucket CRUD API routes (new)

- `GET /api/buckets` — list user's bucket configs (id, bucket_name, region, endpoint_url, created_at, last_synced_key; no secrets in response)
- `POST /api/buckets` — add a bucket config (accepts plaintext secret, encrypts server-side)
- `DELETE /api/buckets/[id]` — remove a bucket config
- `POST /api/buckets/[id]/test` — server-side S3 connectivity test (list objects, confirm credentials work)

All routes use `authenticateRequest` from `lib/supabase/api-auth.ts` (Bearer token auth, per spec 18).

Encryption uses existing `encryptSecretVersioned`/`decryptSecretVersioned` from `lib/crypto/encryption-versioned.ts`.

### 2. Server-side S3 operation routes (new)

- `POST /api/buckets/[id]/scan` — server scans S3 bucket for new objects, creates events and watched_keys with `bucket_config_id` set. Replaces CLI's `watch --once`. Accepts optional `prefix` and `auto_enrich` params. Returns `{ new_objects, created_events }`.
- `POST /api/buckets/[id]/upload` — server accepts file upload (multipart), stores in S3, creates event with `bucket_config_id`. Replaces CLI's `add <file>`. Returns `{ event_id }`.
- `POST /api/buckets/[id]/enrich` — server enriches unenriched images in this bucket. For each: downloads from S3, calls model API (using `model_configs` from DB), saves enrichment. Accepts optional `event_id` (single), `concurrency`, `dry_run`. Returns `{ enriched, failed, skipped, total }`.

These routes:
1. Fetch bucket config from DB (checking user_id via RLS)
2. Decrypt `secret_access_key`
3. Create S3 client
4. Perform operation
5. Insert/update events/watched_keys/enrichments with `bucket_config_id` set

Pattern already exists in `lib/agent/core.ts` (`requireS3Client` + `getBucketConfig`). Extract shared helpers.

### 3. Shared bucket service (refactor)

Extract from `lib/agent/core.ts` into `lib/media/bucket-service.ts`:
- `getBucketConfig(supabase, userId, bucketNameOrId)` — fetch + decrypt
- `createS3ClientFromConfig(config)` — create S3 client from decrypted config
- `scanBucket(supabase, s3, config, userId, opts)` — scan for new objects, insert events/watched_keys
- `enrichBucket(supabase, s3, config, userId, opts)` — enrich pending images

The agent core, API routes, and any future consumers all use the same helpers. The agent core functions become thin wrappers.

### 4. CLI updates (`web/bin/smgr.ts`)

**Add `bucket` subcommand group:**
- `smgr bucket add` — collects bucket config fields (flags or interactive), calls `POST /api/buckets`
- `smgr bucket list` — calls `GET /api/buckets`, displays table
- `smgr bucket remove <bucket>` — resolves bucket name to id, calls `DELETE /api/buckets/[id]`
- `smgr bucket test <bucket>` — calls `POST /api/buckets/[id]/test`

**Update existing commands:**
- `smgr watch <bucket>` — calls `POST /api/buckets/[id]/scan`. Polling loop in CLI calls scan endpoint repeatedly with interval. `--once` calls it once.
- `smgr add <bucket> <file>` — reads file locally, calls `POST /api/buckets/[id]/upload` with multipart body.
- `smgr enrich <bucket>` — calls `POST /api/buckets/[id]/enrich`. All enrichment happens server-side.
- `smgr query` — add optional `--bucket <name>` filter.
- `smgr stats` — add optional `--bucket <name>` filter.

**Remove:**
- `resolveS3Args()` function
- `s3Options` (CLI flags: `--endpoint`, `--region`, `--access-key-id`, `--secret-access-key`, `--bucket`)
- All S3 SDK imports (`createS3Client`, `listS3Objects`, `downloadS3Object`, `uploadS3Object`)
- All enrichment imports (`enrichImage`) — enrichment is server-side now
- `SMGR_S3_*` and `S3_*` env var reads
- `ANTHROPIC_API_KEY` env var read (server handles model calls)
- `p-limit` dependency (concurrency is server-side)

### 5. Env var cleanup

**CLI env after this spec:** `SMGR_WEB_URL` only (plus `SMGR_DEVICE_ID`).

**Remove from `.env.example`:**
- Entire "S3 / Storage" section
- `SMGR_AUTO_ENRICH` (server-side concern now)

**Keep in `scripts/lib.sh`:** S3 vars are still needed for integration test setup (test fixtures create S3 clients directly for seeding). These are test infrastructure concerns.

### 6. Update existing API routes

- `GET /api/events` — add optional `bucket_config_id` query param for filtering
- `GET /api/stats` — add optional `bucket_config_id` query param for per-bucket stats

### 7. Update integration tests

- `smgr-cli.test.ts`: No S3 env vars in CLI subprocess. Tests that use `watch`/`add` call the scan/upload API via the CLI.
- `smgr-e2e.test.ts`: Same — all S3 operations through web API.
- Add tests for bucket CRUD routes.
- Add tests for scan/upload/enrich routes.

## Out of Scope

- BYO S3 provider onboarding UI (future)
- Offline/local-first mode
- Presigned URL upload flow (direct upload through API proxy first)
- Continuous server-side watch (background polling on the server) — the CLI still orchestrates the poll loop, but each scan is a server-side API call
- Streaming responses for long-running operations (scan/enrich with many files) — return summary JSON for now

## Dependencies

- Spec 18 (CLI web API only) — **done**
- `bucket_configs` table — **exists**
- Encryption infrastructure — **exists**
- `authenticateRequest` Bearer token auth — **exists**
- Agent core S3 helpers — **exists, need extraction**
