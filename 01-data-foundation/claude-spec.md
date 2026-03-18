# 01-data-foundation — Complete Specification

## Overview

Audit and improve the existing data foundation layer for sitemgr: Postgres event store, AES-GCM encryption system, Supabase Auth, Row Level Security, database migrations, and associated test coverage. The layer is fully implemented but has never been audited for security gaps, performance at scale, or test completeness.

## Goals

1. **Security audit** — Verify RLS policies actually block unauthorized access; validate encryption implementation against best practices; identify auth model weaknesses
2. **Test coverage expansion** — Add RLS policy tests, migration tests, event store edge case tests; ensure all critical paths have automated verification
3. **Performance assessment** — Profile FTS+RLS query paths; identify index gaps; validate schema for 10K-100K event scale
4. **Phone→user_id migration** — Plan and implement unification of dual auth model to user_id-only
5. **Event ID improvement** — Evaluate replacing truncated UUID IDs with proper ULIDs for better ordering
6. **Key rotation validation** — Exercise the untested lazy migration encryption system end-to-end

## Current State

### Database Schema (8 migrations applied)

**Tables:**
- `events` — Immutable append-only event log (TEXT PK, ULID-style IDs, types: create/sync/enrich/enrich_failed/delete/publish, content types: photo/video/audio/note/bookmark, SHA-256 content_hash, parent_id chains, bucket_config_id, user_id)
- `enrichments` — AI metadata (description, objects[], context, tags[], weighted tsvector FTS with GIN index)
- `watched_keys` — S3 sync tracking (s3_key PK, event_id, etag, bucket_config_id, user_id)
- `bucket_configs` — Per-user S3 credentials (UUID PK, encrypted secret_access_key via AES-GCM, encryption_key_version, dual unique constraints on phone_number+bucket and user_id+bucket)
- `conversations` — WhatsApp chat history (phone_number PK, user_id, JSONB history)
- `user_profiles` — Phone-to-user mapping (auth.users FK, unique phone_number)

**RPC Functions:**
- `search_events()` — Full-text search with ts_rank, content_type/date filters, result limit
- `stats_by_content_type()` / `stats_by_event_type()` — Aggregate counts
- `get_user_id_from_phone()` — Phone→user_id mapping

**RLS:** All tables enabled. Dual auth: `auth.uid() = user_id` OR `phone_number = auth.jwt()->>'phone'`.

### Encryption System

- Base: AES-256-GCM via Web Crypto API, SHA-256 key derivation, random 12-byte IV
- Versioned: Status-based keys (CURRENT/PREVIOUS/NEXT), label-prefixed format (`current:base64...`), legacy support (no prefix → "previous")
- Lazy migration: `needsMigration()` detection, re-encrypt on read
- **Key rotation never tested in practice**

### Testing

- Vitest (globals, node environment), Playwright for E2E
- Encryption roundtrip tests exist and are solid
- **Gaps:** No RLS policy tests, no migration tests, no event store edge case tests
- Pattern: `vi.stubEnv()` with fixtures, mocked Supabase client via `mockFrom`

### Known Issues from Research

1. **RLS + FTS performance risk**: Non-LEAKPROOF functions in RLS policies can prevent GIN index usage. Dual auth OR conditions in policies may compound this.
2. **Missing `(SELECT auth.uid())` wrapping**: RLS policies should wrap `auth.uid()` in SELECT for per-statement caching instead of per-row evaluation.
3. **No client-side filters alongside RLS**: Application queries should add explicit `.eq('user_id', userId)` to help query planner.
4. **Event ID format**: Truncated UUIDs lack time-ordering benefits of ULIDs.
5. **IV/nonce safety**: Current implementation uses random IVs (correct), but no monitoring for key wear-out.

## Scope Boundaries

### In Scope
- Security audit of RLS policies and encryption
- RLS policy test suite
- Migration testing framework
- Event store edge case tests
- Key rotation end-to-end validation
- Phone→user_id migration strategy and implementation plan
- Event ID format evaluation (ULID recommendation)
- RLS performance optimization (SELECT wrapping, index review)
- FTS+RLS interaction analysis

### Out of Scope
- Non-S3 credential types (v1 is S3 only)
- Offline/local-first support
- Table partitioning (not needed at 10K-100K scale)
- Supabase real-time subscriptions
- UI changes in web application

## Dependencies

**Provides to:**
- 02-media-pipeline: schema, encryption utilities, Supabase client
- 03-agent-messaging: schema, Supabase client
- 04-web-application: auth, Supabase client
- 05-cli: schema, encryption, Supabase client

**Any changes to schema, RLS, or encryption must maintain backward compatibility with existing consumers.**

## Key Decisions

- v1 is cloud-based (Supabase Postgres, not local-first)
- Tests use `vi.stubEnv()` with fixture values, never production secrets
- Phone auth is transitional → migrate to user_id only
- Event IDs should move to proper ULIDs (pending evaluation)
- Expected scale: 10K-100K events in next 6-12 months
