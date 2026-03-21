# 02-media-pipeline — Spec

## Overview

S3 bucket watching, media enrichment via Claude vision API, and full-text search indexing. This is the core data processing pipeline that detects new media, generates AI descriptions, and makes content searchable.

## Requirements Reference

See `REQUIREMENTS.md` sections: Core Features §1 (S3 Bucket Watching), §2 (Media Enrichment), §4 (Full-Text Search).

## Scope

### S3 Bucket Watching
- Detect new objects in configured S3-compatible buckets
- Poll-based scanning with cursor (`last_synced_key`) for incremental sync
- Track processed keys via `watched_keys` table to avoid re-processing
- Multi-bucket support with per-bucket encrypted credentials
- Support for multiple S3 providers: AWS, Supabase Storage, MinIO
- S3 v2 API with v1 fallback (for Supabase Storage/MinIO compatibility)
- Path-style URL support for non-AWS providers

### Media Enrichment
- Automatic enrichment via Claude vision API (currently Haiku model) on new media
- Generates: description, detected objects, context, suggested tags
- Photo support (video enrichment deferred)
- Failed enrichments tracked with `enrich_failed` event type
- Retryable via CLI (`smgr enrich --pending`)
- Batch enrichment with configurable concurrency

### Full-Text Search Indexing
- Postgres tsvector + GIN index on enrichment data
- Weighted search: description (A), context (B), tags/objects (C)
- Filters: content type, date range, device
- Exposed via `search_events()` RPC function
- Custom `immutable_array_to_string()` function for GIN index compatibility

## Implementation Status

**Fully implemented.** S3 client handles multi-provider, watcher does incremental polling, enrichment uses Claude vision, FTS with weighted tsvector.

### Key Files
- `web/lib/media/s3.ts` — S3 client operations (list, verify, count, index)
- `web/lib/media/enrichment.ts` — Claude vision enrichment
- `web/lib/media/db.ts` — Database operations, search interface
- `web/__tests__/s3-actions.test.ts` — Comprehensive S3 tests
- `web/__tests__/media-utils.test.ts` — Content type detection, hashing

## Dependencies

**Depends on:** 01-data-foundation (events/enrichments/watched_keys schema, encryption for bucket credentials, Supabase client)

**Provides to:**
- 03-agent-messaging: search interface, media operations API
- 04-web-application: media data, search results
- 05-cli: S3 operations, enrichment, search

## Key Decisions
- Poll-based scanning (not event-driven) — simpler for v1
- Claude Haiku for enrichment (cost-effective for vision)
- Content-addressed blobs with SHA-256
- Auto-enrich configurable via `SMGR_AUTO_ENRICH` env var
