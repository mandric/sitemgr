# 15: CLI Bucket Config — Server-Side S3 Credentials

## Problem

The smgr CLI currently talks to S3 directly, requiring S3 credentials (endpoint, access key, secret key, bucket, region) as CLI flags or env vars on every machine that runs the CLI. This means:

- S3 credentials leak to every developer/CI machine
- Bucket configuration is scattered across env vars, CLI flags, and `.env.local`
- Adding a new bucket means reconfiguring every client
- No central view of which buckets exist or their status

## Goal

Move bucket configuration (S3 endpoint, credentials, bucket name, region) to the server. The CLI manages bucket configs via the web API and never touches S3 directly. The web API does all S3 operations using credentials stored in the database (encrypted at rest).

## New Workflow

1. **`smgr bucket add`** — CLI sends bucket config (endpoint, credentials, bucket, region) to the web API, which stores it encrypted in the DB
2. **`smgr bucket list`** — CLI fetches all bucket configs for the authenticated user via the web API
3. **`smgr bucket test`** — CLI asks the web API to perform a test S3 list operation on a bucket config, confirming connectivity
4. **`smgr bucket remove`** — CLI removes a bucket config via the web API
5. **`smgr watch`** — CLI tells the web API to watch a bucket (server polls S3, not the CLI)
6. **`smgr add <file>`** — CLI uploads via the web API (or gets a presigned URL)
7. **`smgr stats`** — CLI fetches enrichment stats (processed/pending) for all buckets via the web API

## What Changes

### CLI (`web/bin/smgr.ts`)

- Remove S3 CLI flags: `--endpoint`, `--region`, `--access-key-id`, `--secret-access-key`, `--bucket`
- Remove `resolveS3Args()` function
- Remove direct `createS3Client` usage in CLI commands
- Add `bucket` subcommand group (`add`, `list`, `test`, `remove`)
- `watch` and `add` commands call web API endpoints instead of S3 directly
- `stats` command calls web API for aggregated enrichment status

### Web API (`web/app/api/`)

- New `/api/buckets` endpoint — CRUD for bucket configs (encrypted S3 credentials stored in DB)
- New `/api/buckets/[id]/test` endpoint — server-side S3 connectivity test
- `watch` and media operations use bucket config from DB, not env vars
- `S3_ENDPOINT_URL`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` read by the web API (server-side only)

### Database

- New `bucket_configs` table: `id`, `user_id`, `name`, `endpoint_url`, `bucket`, `region`, `access_key_id` (encrypted), `secret_access_key` (encrypted), `created_at`, `updated_at`
- RLS: users can only access their own bucket configs

### Env Vars

- `SMGR_S3_ENDPOINT`, `SMGR_S3_BUCKET`, `SMGR_S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` — no longer needed by the CLI, only by the web API as defaults or for migration
- `S3_ENDPOINT_URL` — used by the web API for server-side S3 operations
- CLI only needs `SMGR_API_URL` and `SMGR_API_KEY` (auth to web API)

## Out of Scope

- BYO S3 providers (future — bucket configs table supports it, but UI/onboarding is deferred)
- Offline/local-first mode
- Presigned URL upload flow (may do direct upload through API first)
