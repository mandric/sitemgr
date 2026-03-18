# 01-data-foundation — Spec

## Overview

Core data infrastructure for sitemgr: Postgres event store, encryption system, Supabase auth, Row Level Security, and database migrations.

## Requirements Reference

See `REQUIREMENTS.md` sections: Core Features §3 (Event Store), §4 (Full-Text Search data layer), Security & Encryption, Data Model, Tech Stack.

## Scope

### Database Schema
- **events** table — Immutable append-only event log (ULID ids via `newEventId()`, event types: create/sync/enrich/enrich_failed/delete/publish, content_hash SHA-256, device_id, parent_id, user_id NOT NULL, bucket_config_id)
- **enrichments** table — AI-generated metadata (description, objects[], context, tags[], fts tsvector, user_id NOT NULL)
- **watched_keys** table — S3 sync tracking. Primary key: `(s3_key, bucket_config_id)`. Columns: event_id, etag, size_bytes, user_id NOT NULL
- **bucket_configs** table — Per-user S3 credentials with encrypted secret keys. Unique constraint: `(user_id, bucket_name)`. `phone_number` column dropped after migration
- **conversations** table — WhatsApp chat history. Primary key: `user_id`. `phone_number` retained as display column, `history` JSONB
- **user_profiles** table — Phone-to-user mapping (id UUID PK references auth.users, phone_number TEXT UNIQUE)
- **Content types:** photo, video, audio, note, bookmark

### Encryption
- AES-256-GCM encryption at rest for S3 secret keys in `bucket_configs`
- `encryption.ts` accepts key as a parameter (no process.env side-channel)
- Key derivation: Input key → SHA-256 hash → 256-bit AES key
- Random 12-byte IV per encryption, prepended to ciphertext
- Status-based key naming: `ENCRYPTION_KEY_CURRENT` / `_PREVIOUS` / `_NEXT`
- Label-prefixed ciphertext format: `current:base64(iv+ciphertext)`
- Legacy format support (no prefix, assumed "previous")
- Lazy migration: data re-encrypts to current key on access (non-blocking background update in `getBucketConfig()`)
- Zero-downtime key rotation — see `docs/KEY_ROTATION.md` for the operational runbook

### Auth & Security
- Supabase Auth (email/password with email confirmation)
- Row Level Security on all tables with user_id-only policies
- All RLS policies use `(SELECT auth.uid()) = user_id` for initPlan caching performance
- All RLS policies use `TO authenticated` to block anon-role connections
- Phone number retained in `user_profiles` for WhatsApp display, no longer used for auth
- Two client constructors: `getAdminClient()` (service role, bypasses RLS) and `getUserClient()` (publishable key, RLS enforced)
- See `docs/RLS_POLICIES.md` for complete policy documentation

### RPC Functions
- `search_events(p_user_id UUID, ...)` — Full-text search across enrichments, filtered by user_id
- `stats_by_content_type(p_user_id UUID)` / `stats_by_event_type(p_user_id UUID)` — Statistics scoped to user
- `get_user_id_from_phone(TEXT)` — Phone to user_id mapping (restricted to service_role only)

### Event ID Format
- `newEventId()` generates ULIDs (Universally Unique Lexicographically Sortable Identifiers)
- Mixed ID formats in the events table: older records have truncated UUIDs, newer records have ULIDs
- The `timestamp` column remains the authoritative chronological sort key (not the ULID's embedded timestamp)

## Implementation Status

**Fully implemented.** 11 migration files, all tables with indexes and RLS policies, versioned encryption with lazy migration, phone-to-user_id migration complete.

### Key Files
- `supabase/migrations/` — 11 migration files (schema, RLS, RPC isolation, phone migration)
- `web/lib/crypto/encryption-versioned.ts` — Multi-key versioned encryption
- `web/lib/crypto/encryption.ts` — Base AES-256-GCM (key as parameter)
- `web/lib/media/db.ts` — Database operations (all functions accept userId parameter)
- `web/lib/agent/core.ts` — Agent logic with `resolveUserId()` for phone→user mapping
- `web/__tests__/encryption*.test.ts` — Encryption test suite
- `web/__tests__/rls-policies.test.ts` — RLS integration tests (22 tests)
- `web/__tests__/rpc-user-isolation.test.ts` — RPC isolation tests (6 tests)
- `web/__tests__/phone-migration-app.test.ts` — Phone migration unit tests
- `docs/KEY_ROTATION.md` — Key rotation operational runbook
- `docs/RLS_POLICIES.md` — Complete RLS policy documentation

## Dependencies

**Provides to:**
- 02-media-pipeline: schema, encryption utilities, Supabase client
- 03-agent-messaging: schema, Supabase client
- 04-web-application: auth, Supabase client
- 05-cli: schema, encryption, Supabase client

## Key Decisions (from interview/CLAUDE.md)
- v1 is cloud-based (not local-first) — Supabase Postgres is the event store
- Tests use `vi.stubEnv()` with fixture values, not real secrets
- No GitHub secrets for tests — only CI secrets for services tests actually connect to
- Auth is user_id-only after phone migration; phone numbers retained only for WhatsApp display
