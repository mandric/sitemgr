# Supabase Deployment Architecture

## Overview

Deploy the smgr WhatsApp bot as a fully managed stack on Supabase:
- **Edge Function** — Deno/TypeScript serverless handler for Twilio webhooks
- **Postgres** — Replaces SQLite as the event store
- **Supabase Storage** — S3-compatible media storage (replaces standalone S3/MinIO)

One platform, one dashboard. GitHub Actions deploys on push.

## Why Supabase

| Concern | SQLite prototype | Supabase |
|---------|-----------------|----------|
| Database | Local file, lost on redeploy | Managed Postgres, persistent |
| Storage | External S3 bucket | Supabase Storage (S3-compatible API) |
| Webhook handler | Long-running Python HTTP server | Stateless Edge Function |
| Full-text search | FTS5 virtual table | Postgres `tsvector`/`tsquery` |
| Hosting | Requires a VPS or container | Serverless, free tier |
| Auth (future) | None | Supabase Auth built-in |

## Architecture

```
WhatsApp User
    │
    ▼
Twilio (WhatsApp Business API)
    │
    ▼ POST /whatsapp
Supabase Edge Function (Deno/TypeScript)
    ├── Validates Twilio signature
    ├── Calls Claude API (agent brain)
    ├── Queries Supabase Postgres (replaces smgr CLI)
    ├── Reads media metadata from Storage
    └── Sends response via Twilio API
    │
    ▼
Supabase Postgres
    ├── events (immutable event log)
    ├── events_fts (full-text search view)
    └── watched_keys (S3 sync tracking)

Supabase Storage
    └── media/ bucket (photos, videos)
```

## Postgres Schema

Direct migration from SQLite with Postgres-native improvements:

### `events` table

```sql
CREATE TABLE events (
    id          TEXT PRIMARY KEY,       -- UUID hex (26 chars)
    timestamp   TIMESTAMPTZ NOT NULL,   -- Native timestamp (was TEXT)
    device_id   TEXT NOT NULL,
    type        TEXT NOT NULL,          -- create, update, delete, sync, enrich, enrich_failed, publish
    content_type TEXT,                  -- photo, video, audio, note, document, etc.
    content_hash TEXT,                  -- sha256:{hex}
    local_path  TEXT,
    remote_path TEXT,                   -- storage://media/{hash}.{ext}
    metadata    JSONB,                  -- Native JSONB (was TEXT)
    parent_id   TEXT REFERENCES events(id)
);

CREATE INDEX idx_events_type ON events(type);
CREATE INDEX idx_events_content_type ON events(content_type);
CREATE INDEX idx_events_content_hash ON events(content_hash);
CREATE INDEX idx_events_timestamp ON events(timestamp);
CREATE INDEX idx_events_device_id ON events(device_id);
CREATE INDEX idx_events_remote_path ON events(remote_path);
CREATE INDEX idx_events_parent_id ON events(parent_id);
```

### Full-text search

Replace FTS5 with Postgres GIN-indexed tsvector:

```sql
CREATE TABLE enrichments (
    event_id    TEXT PRIMARY KEY REFERENCES events(id),
    description TEXT,
    objects     TEXT[],          -- Array (was space-separated TEXT)
    context     TEXT,
    tags        TEXT[],          -- Array (was space-separated TEXT)
    fts         TSVECTOR GENERATED ALWAYS AS (
        setweight(to_tsvector('english', COALESCE(description, '')), 'A') ||
        setweight(to_tsvector('english', COALESCE(context, '')), 'B') ||
        setweight(to_tsvector('english', COALESCE(array_to_string(tags, ' '), '')), 'C') ||
        setweight(to_tsvector('english', COALESCE(array_to_string(objects, ' '), '')), 'C')
    ) STORED
);

CREATE INDEX idx_enrichments_fts ON enrichments USING GIN(fts);
```

### `watched_keys` table

```sql
CREATE TABLE watched_keys (
    s3_key      TEXT PRIMARY KEY,
    first_seen  TIMESTAMPTZ NOT NULL,
    event_id    TEXT REFERENCES events(id),
    etag        TEXT,
    size_bytes  BIGINT
);
```

### Key differences from SQLite

| SQLite | Postgres |
|--------|----------|
| `TEXT` timestamps | `TIMESTAMPTZ` native |
| `TEXT` JSON blobs | `JSONB` with operators |
| FTS5 virtual table | `tsvector` + GIN index |
| Space-separated lists | `TEXT[]` arrays |
| `json_extract(metadata, '$.size_bytes')` | `metadata->>'size_bytes'` |
| `INSERT OR IGNORE` | `INSERT ... ON CONFLICT DO NOTHING` |

## Edge Function: `/whatsapp`

The Edge Function replaces both `bot.py` (webhook handler) and `smgr.py` (CLI queries).
It does not shell out to smgr — it queries Postgres directly.

### Request flow

```
1. Receive POST from Twilio
2. Parse: From, Body
3. Call Claude with agent prompt + user message
4. Claude returns SQL-like intent (query params, not raw SQL)
5. Edge Function builds parameterized query
6. Query Supabase Postgres
7. Call Claude to summarize results
8. Send response via Twilio REST API
9. Return 200 with empty TwiML
```

### Agent prompt adaptation

Instead of generating `smgr` CLI commands, the agent generates structured intents:

```json
{
  "action": "query",
  "params": {
    "search": "beach sunset",
    "type": "photo",
    "since": "2024-01-01",
    "limit": 10
  }
}
```

Or for stats:
```json
{
  "action": "stats"
}
```

The Edge Function maps these intents to parameterized Postgres queries.
This is safer than generating raw SQL and equivalent to the CLI's query builder.

### Supported actions

| Action | Maps to | Postgres query |
|--------|---------|----------------|
| `query` | `smgr query` | `SELECT` from events + enrichments with filters |
| `show` | `smgr show <id>` | `SELECT` by event ID with enrichment join |
| `stats` | `smgr stats` | Aggregate counts, sizes, types |
| `search` | `smgr query --search` | `WHERE fts @@ plainto_tsquery(?)` |
| `enrich_status` | `smgr enrich --status` | Count enriched vs pending |

### Conversation state

In-memory per-user conversation history (same as bot.py).
Edge Functions are stateless, so we store conversation history in Postgres:

```sql
CREATE TABLE conversations (
    phone_number TEXT PRIMARY KEY,
    history      JSONB NOT NULL DEFAULT '[]',
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

A scheduled cron (pg_cron or GitHub Actions) can clean up old conversations.

## Supabase Storage

Media files stored in a `media` bucket with the same content-addressed scheme:

```
media/{first-2-chars-of-hash}/{full-hash}.{ext}
```

The Edge Function generates signed URLs when a user asks to view a photo,
so the bot can send actual image previews in WhatsApp (Twilio supports media URLs).

### Migration from external S3

If media already lives in an external S3 bucket, two options:
1. **Keep external S3** — Edge Function reads from external S3 via fetch (works fine)
2. **Migrate to Supabase Storage** — One-time copy via `aws s3 sync` or a migration script

For testing, option 1 is simpler. Just configure the external S3 credentials
as Edge Function secrets.

## GitHub Actions Pipeline

### Workflow: `.github/workflows/deploy-supabase.yml`

```yaml
name: Deploy to Supabase
on:
  push:
    branches: [main, develop]
    paths:
      - 'supabase/**'

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: supabase/setup-cli@v1
        with:
          version: latest

      - name: Link project
        run: supabase link --project-ref ${{ secrets.SUPABASE_PROJECT_REF }}
        env:
          SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}

      - name: Run migrations
        run: supabase db push
        env:
          SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}

      - name: Deploy Edge Functions
        run: supabase functions deploy whatsapp --no-verify-jwt
        env:
          SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}

      - name: Set secrets
        run: |
          supabase secrets set \
            ANTHROPIC_API_KEY=${{ secrets.ANTHROPIC_API_KEY }} \
            TWILIO_ACCOUNT_SID=${{ secrets.TWILIO_ACCOUNT_SID }} \
            TWILIO_AUTH_TOKEN=${{ secrets.TWILIO_AUTH_TOKEN }} \
            TWILIO_WHATSAPP_FROM=${{ secrets.TWILIO_WHATSAPP_FROM }}
        env:
          SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}
```

### Required GitHub Secrets

| Secret | Description |
|--------|-------------|
| `SUPABASE_ACCESS_TOKEN` | Supabase personal access token |
| `SUPABASE_PROJECT_REF` | Project reference ID (from dashboard URL) |
| `ANTHROPIC_API_KEY` | Claude API key for agent brain |
| `TWILIO_ACCOUNT_SID` | Twilio account SID |
| `TWILIO_AUTH_TOKEN` | Twilio auth token |
| `TWILIO_WHATSAPP_FROM` | Twilio WhatsApp sender number |

## Directory Structure

```
supabase/
├── config.toml                          # Supabase project config
├── migrations/
│   └── 20260305000000_initial_schema.sql  # Postgres schema
└── functions/
    └── whatsapp/
        ├── index.ts                     # Edge Function entry point
        └── deps.ts                      # Shared dependencies
```

## Setup Steps

1. **Create Supabase project** at https://supabase.com/dashboard
2. **Install Supabase CLI**: `npm install -g supabase`
3. **Initialize locally**: `supabase init` (creates `supabase/` directory)
4. **Link project**: `supabase link --project-ref <ref>`
5. **Run migration**: `supabase db push`
6. **Deploy function**: `supabase functions deploy whatsapp --no-verify-jwt`
7. **Set secrets**: `supabase secrets set ANTHROPIC_API_KEY=... TWILIO_ACCOUNT_SID=...`
8. **Configure Twilio webhook**: Point to `https://<ref>.supabase.co/functions/v1/whatsapp`
9. **Add GitHub secrets** for CI/CD
10. **Push to main** — GitHub Actions deploys automatically

## Testing Locally

```bash
# Start local Supabase (Postgres + Edge Functions)
supabase start

# Seed the database with test data
supabase db reset

# Run the Edge Function locally
supabase functions serve whatsapp --env-file .env.local

# Test with curl (simulating Twilio webhook)
curl -X POST http://localhost:54321/functions/v1/whatsapp \
  -d "From=whatsapp:+1234567890&Body=show me my photos"
```

## Cost

Supabase free tier includes:
- 500 MB Postgres storage
- 1 GB file storage
- 500K Edge Function invocations/month
- 2 GB bandwidth

For a personal testing environment, this is more than enough.

## Future Extensions

- **Supabase Auth** — Add user authentication for multi-user support
- **Realtime** — Push notifications when new media is enriched
- **pg_cron** — Scheduled S3 polling (replaces `smgr watch`)
- **Supabase Storage triggers** — Auto-enrich on upload via database webhooks
- **Row Level Security** — Per-user media isolation when multi-user
