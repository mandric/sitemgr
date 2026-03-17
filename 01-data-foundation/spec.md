# 01-data-foundation — Spec

## Overview

Core data infrastructure for sitemgr: Postgres event store, encryption system, Supabase auth, Row Level Security, and database migrations.

## Requirements Reference

See `REQUIREMENTS.md` sections: Core Features §3 (Event Store), §4 (Full-Text Search data layer), Security & Encryption, Data Model, Tech Stack.

## Scope

### Database Schema
- **events** table — Immutable append-only event log (ULID ids, event types: create/sync/enrich/enrich_failed/delete/publish, content_hash SHA-256, device_id, parent_id, user_id, bucket_config_id)
- **enrichments** table — AI-generated metadata (description, objects[], context, tags[], fts tsvector)
- **watched_keys** table — S3 sync tracking (s3_key, event_id, etag, bucket_config_id)
- **bucket_configs** table — Per-user S3 credentials with encrypted secret keys
- **conversations** table — WhatsApp chat history (phone_number, JSONB history)
- **user_profiles** table — Phone-to-user mapping
- **Content types:** photo, video, audio, note, bookmark

### Encryption
- AES-GCM encryption at rest for S3 secret keys
- Status-based key naming: `ENCRYPTION_KEY_CURRENT` / `_PREVIOUS` / `_NEXT`
- Label-prefixed ciphertext format: `current:base64ciphertext`
- Legacy format support (no prefix, assumed "previous")
- Lazy migration: data re-encrypts to current key on access (non-blocking background update)
- Zero-downtime key rotation

### Auth & Security
- Supabase Auth (email/password with email confirmation)
- Row Level Security on all tables
- Dual auth: phone_number (WhatsApp) and user_id (web)

### RPC Functions
- `search_events()` — Full-text search across enrichments
- `stats_by_content_type()` / `stats_by_event_type()` — Statistics
- `get_user_id_from_phone()` — Phone to user_id mapping

## Implementation Status

**Fully implemented.** 8 migration files, all tables with indexes and RLS policies, versioned encryption with lazy migration.

### Key Files
- `supabase/migrations/` — All 8 migration files
- `web/lib/crypto/encryption-versioned.ts` — Multi-key encryption
- `web/lib/crypto/encryption.ts` — Base AES-GCM
- `web/lib/supabase/` — Supabase client helpers
- `web/__tests__/encryption*.test.ts` — Encryption test suite

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
