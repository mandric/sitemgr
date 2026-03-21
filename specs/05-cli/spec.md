# 05-cli — Spec

## Overview

`smgr` command-line tool for managing media collections — database stats, full-text search, event inspection, batch enrichment, S3 watching, and file upload.

## Requirements Reference

See `REQUIREMENTS.md` sections: Core Features §7 (CLI).

## Scope

### Commands
- `smgr stats` — Database statistics (events by type, by content type)
- `smgr query [--search Q] [--type TYPE] [--format json] [--limit N]` — Full-text search with filters
- `smgr show <id>` — Event details with enrichment data
- `smgr enrich [--pending] [--status] [<event_id>]` — Batch enrichment of unenriched media, status check, or single event enrichment
- `smgr watch [--once]` — Monitor S3 bucket for new files with optional auto-enrichment
- `smgr add <file>` — Create event + upload to S3 (NOT YET IMPLEMENTED)

### Runtime
- TypeScript executed via `tsx`
- Direct Supabase client connection (service role key)
- Environment variables for S3 config (SMGR_S3_BUCKET, SMGR_S3_ENDPOINT, etc.)

## Implementation Status

**Mostly implemented.** All commands work except `add`.

### Key Files
- `web/bin/smgr.ts` — CLI entry point with all commands
- Uses: `web/lib/media/s3.ts`, `web/lib/media/enrichment.ts`, `web/lib/media/db.ts`

### Missing
- `smgr add <file>` — Needs to: read local file, compute SHA-256 hash, upload to S3, create event in database

## Dependencies

**Depends on:**
- 01-data-foundation (schema, encryption, Supabase client with service role)
- 02-media-pipeline (S3 operations, enrichment, search)

## Key Decisions
- Uses `tsx` for TypeScript execution (no compilation step)
- Service role key for database access (bypasses RLS)
- `SMGR_DEVICE_ID` defaults to "default" for event provenance
- Watch interval configurable via `SMGR_WATCH_INTERVAL` (default 30s)
- Auto-enrich on watch configurable via `SMGR_AUTO_ENRICH` (default true)
