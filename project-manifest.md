<!-- SPLIT_MANIFEST
01-data-foundation
02-media-pipeline
03-agent-messaging
04-web-application
05-cli
END_MANIFEST -->

# Project Manifest — sitemgr

## Overview

sitemgr is a media management system that watches S3 buckets for photos/videos, enriches them with Claude AI vision, indexes in Postgres with full-text search, and exposes natural language queries via WhatsApp bot, CLI, and web UI.

This manifest covers the full v1 project scope. The codebase is ~80% implemented; each spec notes what exists and what remains.

## Splits

### 01-data-foundation
**Purpose:** Core data infrastructure — database schema, encryption system, Supabase auth, RLS policies, and migrations.

**Scope:**
- Postgres event store (events, enrichments, watched_keys, bucket_configs, conversations, user_profiles)
- Immutable append-only event log design
- Content-addressed blobs (SHA-256)
- AES-GCM encryption with versioned keys and lazy migration
- Row Level Security policies on all tables
- Supabase Auth integration
- RPC functions (search_events, stats)

**Status:** Fully implemented (8 migrations, all tables, RLS, encryption with key rotation)

**Provides to other splits:**
- Database schema and types
- Encryption utilities (`lib/crypto/`)
- Supabase client helpers (`lib/supabase/`)
- RPC function contracts

---

### 02-media-pipeline
**Purpose:** S3 bucket watching, media enrichment via Claude vision, and full-text search indexing.

**Scope:**
- S3 client with multi-provider support (AWS, Supabase Storage, MinIO)
- Poll-based bucket scanning with cursor tracking
- Multi-bucket support with per-bucket encrypted credentials
- Claude vision API enrichment (description, objects, context, tags)
- Batch enrichment with retry logic
- tsvector + GIN index on enrichment data
- Weighted full-text search (description A, context B, tags/objects C)

**Status:** Fully implemented (S3 client, watcher, enrichment, FTS)

**Depends on:** 01-data-foundation (schema, encryption, Supabase client)
**Provides to other splits:**
- Media operations API (`lib/media/`)
- Search interface (`search_events()` RPC)
- S3 operations (`lib/media/s3.ts`)

---

### 03-agent-messaging
**Purpose:** Claude agent with plan/execute/summarize flow, WhatsApp bot integration, and conversation management.

**Scope:**
- Agent core: plan → execute → summarize flow
- Action dispatch to database/S3 operations
- Multi-turn conversation history (JSONB)
- Twilio WhatsApp webhook handler (Vercel API route)
- Message routing and response formatting
- Natural language query understanding

**Status:** Fully implemented (agent core, WhatsApp route). Minor gaps: web chat agent lacks user context (buckets/stats).

**Depends on:** 01-data-foundation (schema, Supabase client), 02-media-pipeline (search, media operations)
**Provides to other splits:**
- Agent API (`lib/agent/core.ts`)
- WhatsApp webhook route (`/api/whatsapp`)

---

### 04-web-application
**Purpose:** Next.js web UI — authentication flows, bucket configuration, media browsing/search, and agent chat interface.

**Scope:**
- Next.js App Router with React 19
- Supabase Auth pages (login, signup, password reset, email confirmation)
- Bucket configuration UI (add/edit/delete S3 credentials)
- Media gallery/grid view (NOT YET IMPLEMENTED)
- Search results display (NOT YET IMPLEMENTED)
- Media detail page with enrichment data (NOT YET IMPLEMENTED)
- Agent chat interface
- Responsive design with Tailwind CSS + Radix UI

**Status:** Partially implemented. Auth, bucket config, and basic agent chat work. Media browsing/search UI is the biggest remaining gap.

**Depends on:** 01-data-foundation (auth, Supabase client), 02-media-pipeline (search, media data), 03-agent-messaging (agent API)

---

### 05-cli
**Purpose:** `smgr` command-line tool for managing media collections.

**Scope:**
- `smgr stats` — database statistics
- `smgr query` — full-text search with filters (type, date, text, format)
- `smgr show <id>` — event details
- `smgr enrich --pending` — batch enrichment of unenriched media
- `smgr watch` — monitor S3 bucket for new files (with auto-enrich)
- `smgr add <file>` — create event + upload (NOT YET IMPLEMENTED)

**Status:** Mostly implemented. All commands work except `add`.

**Depends on:** 01-data-foundation (schema, encryption, Supabase client), 02-media-pipeline (S3, enrichment, search)

---

## Dependency Graph

```
01-data-foundation
    ├── 02-media-pipeline
    │       ├── 03-agent-messaging
    │       ├── 04-web-application
    │       └── 05-cli
    └── (direct)
            ├── 03-agent-messaging
            ├── 04-web-application
            └── 05-cli
```

## Execution Order

1. **01-data-foundation** — Must be planned first (everything depends on it)
2. **02-media-pipeline** — Second (agent, web, and CLI depend on media operations)
3. **03-agent-messaging**, **04-web-application**, **05-cli** — Can be planned in parallel (independent of each other, both depend on 01 + 02)

## Parallel Groups

- **Sequential:** 01 → 02
- **Parallel after 02:** 03, 04, 05

## Cross-Cutting Concerns

- **TypeScript types** — Shared across all splits via `lib/` modules
- **Environment variables** — Status-based encryption keys, Supabase credentials, API keys
- **Testing strategy** — Vitest with `vi.stubEnv()` for unit tests, Playwright for E2E
- **Error handling** — Consistent patterns across CLI, API routes, and agent

## Next Steps

Run /deep-plan for each split in order:
```
/deep-plan @01-data-foundation/spec.md
/deep-plan @02-media-pipeline/spec.md
/deep-plan @03-agent-messaging/spec.md    # after 02 completes
/deep-plan @04-web-application/spec.md    # after 02 completes
/deep-plan @05-cli/spec.md               # after 02 completes
```
