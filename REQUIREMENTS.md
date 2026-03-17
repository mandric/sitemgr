# sitemgr — Requirements (v1)

Media management system that watches S3 buckets for photos/videos, enriches them with Claude AI vision, indexes in Postgres with full-text search, and exposes natural language queries via WhatsApp bot, CLI, and web UI.

## Target Users

Developers/power users who sync camera rolls to S3 (via rclone, Syncthing, etc.) and want searchable, AI-described media collections.

## v1 Scope

- **Cloud-based** — Supabase Postgres event store, Supabase Storage for media, online required
- **No offline/local-first** — deferred to future version

---

## Core Features

### 1. S3 Bucket Watching
- Detect new objects in configured S3-compatible buckets
- Poll-based scanning with cursor (`last_synced_key`) for incremental sync
- Track processed keys to avoid re-processing (watched_keys table)
- Multi-bucket support with per-bucket credentials (encrypted at rest)

### 2. Media Enrichment
- Automatic enrichment via Claude vision API on new media
- Generates: description, detected objects, context, suggested tags
- Supports photos and videos; audio/other types future
- Failed enrichments tracked; retryable via CLI (`smgr enrich --pending`)

### 3. Event Store (Append-Only)
- Immutable event log — no edits/deletes on rows
- Event types: `create`, `sync`, `enrich`, `enrich_failed`, `delete`, `publish`
- Content-addressed blobs (SHA-256): `smgr://sha256:{hex}`
- Device provenance (`device_id`) on all events
- Parent references (`parent_id`) for update/delete chains

### 4. Full-Text Search
- Postgres tsvector + GIN index on enrichment data
- Weighted: description (A), context (B), tags/objects (C)
- Filters: content type, date range, device
- Exposed via `search_events()` RPC function

### 5. WhatsApp Bot
- Natural language queries via Twilio webhook (Vercel API route)
- Multi-turn conversation history
- Plan → Execute → Summarize flow using Claude agent
- Example: "what did I photograph this week?"

### 6. Web UI (Next.js)
- Supabase Auth (email confirmation flow)
- Bucket configuration (add/edit S3 credentials)
- Media browsing and search
- Agent chat interface

### 7. CLI (`smgr`)
- `stats` — database statistics
- `query` — full-text search with filters (type, date, text)
- `show <id>` — event details
- `enrich --pending` — batch enrichment
- `watch` — monitor S3 bucket for new files
- `add <file>` — create event + upload

---

## Data Model

| Entity | Key Fields | Purpose |
|--------|-----------|---------|
| **events** | id (ULID), type, content_type, content_hash, device_id, parent_id, user_id, bucket_config_id | Immutable event log |
| **enrichments** | event_id (FK), description, objects[], context, tags[], fts (tsvector) | AI-generated metadata + search index |
| **watched_keys** | s3_key, event_id, etag, bucket_config_id | S3 sync tracking |
| **bucket_configs** | phone_number, bucket_name, endpoint_url, access_key_id, secret_access_key (encrypted) | Per-user S3 credentials |
| **conversations** | phone_number, history (JSONB) | WhatsApp chat history |

**Content types:** photo, video, audio, note, bookmark

---

## Security & Encryption

- S3 secret keys encrypted with AES-GCM at rest
- Status-based key naming: `ENCRYPTION_KEY_CURRENT` / `_PREVIOUS` / `_NEXT`
- Label-prefixed ciphertext format: `current:base64ciphertext`
- Lazy migration: data re-encrypts to current key on access
- Row Level Security (RLS) on all tables

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js, React 19, Tailwind CSS, Radix UI |
| Backend | Next.js API routes, Supabase PostgREST |
| Database | Supabase Postgres |
| Storage | Supabase Storage (S3-compatible) |
| Auth | Supabase Auth |
| LLM | Anthropic Claude API (vision) |
| Messaging | Twilio WhatsApp Business API |
| CLI | tsx (TypeScript executor) |
| Testing | Vitest (unit/integration), Playwright (E2E) |
| CI/CD | GitHub Actions → Vercel (app) + Supabase (db) |

---

## Open Issues

- #15: Add version/build info to health endpoint

---

## Out of Scope (Backlog)

- Local-first / offline mode (per-device SQLite)
- BYO S3 storage (any provider beyond Supabase)
- Enrichment metadata as S3 sidecar files
- Native mobile apps (iOS/Android)
- Document sync via git
- Publishing/rendering templates (galleries, blogs)
