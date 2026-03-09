# Architecture

> **v1 scope: cloud-based.** The first version requires an internet
> connection and uses Supabase (Postgres + Storage) as the backend.
> Local-first/offline support is deferred to a future version.
> Supabase is used for testing and prototyping — the long-term goal
> is to support any S3-compatible storage API (backlog).
>
> **Post-prototype idea:** Store enrichment metadata as sidecar files
> in S3 (e.g., `{hash}.meta.json` next to `{hash}.jpg`), so metadata
> always lives alongside the user's media in their own storage. Worth
> exploring once the prototype is working.

## System Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    CAPTURE & SYNC                            │
│                                                             │
│  ┌──────────────┐  ┌──────────┐  ┌────────────────────────┐ │
│  │ Phone camera │  │  CLI     │  │ Future: FS Watch, iOS  │ │
│  │ → S3 sync    │  │ smgr add │  │                        │ │
│  │ (rclone etc) │  │          │  │                        │ │
│  └──────┬───────┘  └────┬─────┘  └───────────┬────────────┘ │
└─────────┼───────────────┼────────────────────┼──────────────┘
          │               │                    │
          ▼               ▼                    ▼
┌─────────────────────────────────────────────────────────────┐
│                    S3-COMPATIBLE STORAGE                     │
│                                                             │
│  Media lands here first. sitemgr watches, not moves.        │
│  Supabase Storage for v1 (testing). BYO S3 is backlog.      │
│                                                             │
└────────────────────────┬────────────────────────────────────┘
                         │
                    smgr watch / webhook
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                    EVENT STORE                               │
│                                                             │
│  Append-only. Every action becomes an event.                │
│  Events are immutable. Stored in Supabase Postgres.         │
│                                                             │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐             │
│  │evt 1 │→│evt 2 │→│evt 3 │→│evt 4 │→│evt 5 │→ ...        │
│  └──────┘ └──────┘ └──────┘ └──────┘ └──────┘             │
└────────────────────────┬────────────────────────────────────┘
                         │
                    ┌────┴─────┐
                    ▼          ▼
          ┌────────────┐ ┌────────────────┐
          │ ENRICHMENT │ │ QUERY          │
          │            │ │ INTERFACE      │
          │ BYO: Claude│ │                │
          │ GPT, Gemini│ │ Postgres       │
          │            │ │ tsvector + GIN │
          │ media →    │ │ full-text      │
          │ structured │ │ search         │
          │ metadata   │ │                │
          └─────┬──────┘ └───────┬────────┘
                │                │
                ▼                │
   ┌──────────────────┐         │
   │ Enrichment result│         │
   │ stored as event  │         │
   └──────────┬───────┘         │
              │                 │
              └────────┬────────┘
                       ▼
            ┌──────────┼──────────┐
            ▼          ▼          ▼
  ┌────────────┐ ┌───────────┐ ┌──────────────┐
  │    CLI     │ │ WhatsApp  │ │   FUTURE UI  │
  │            │ │ Bot       │ │              │
  │  smgr     │ │ (Supabase │ │  Web, mobile │
  │  query    │ │  Edge Fn) │ │  dashboard   │
  └────────────┘ └───────────┘ └──────────────┘
```

---

## Component Details

### 1. Capture & Sync Triggers

Content enters the system through explicit user action or agent-driven
workflows — not background observers. Modern Android is hostile to
long-running background services (Doze, battery optimization, OEM kill),
and the user can't generate media while sitemgr is foregrounded anyway.
The agent (via OpenClaw) drives sync on demand — the user decides when to
pull photos, what to enrich, and what to query, giving full control over
API costs and processing.

**CLI (primary):**
- `smgr add <file>` creates a `create` event and imports the file
- `smgr add --enrich <file>` adds and immediately enriches
- `smgr enrich --pending` enriches all un-enriched items (batch catch-up)
- `smgr sync push` uploads unsynced blobs to S3
- Works on any platform with a terminal
- The agent (via OpenClaw) composes these commands in conversational workflows

**Android app (future):**
- **No background service.** Modern Android is hostile to long-running
  background services (Doze, battery optimization, OEM kill). The user
  can't generate media while sitemgr is foregrounded anyway.
- **On-open batch detection.** When the app launches, scan MediaStore for
  new photos since last run. Show the batch to the user for confirmation
  before syncing.
- **WorkManager for uploads.** Once the user confirms a sync batch,
  uploads are enqueued via Android WorkManager. This survives app
  backgrounding, process death, and device reboots. WorkManager respects
  system constraints (network, battery) and retries failed uploads
  automatically.
- **Resumable by design.** Each synced item gets a `sync` event in the
  local database. On resume, the app queries for items with a `create`
  event but no `sync` event — no S3 round-trips needed to determine
  what's left. A full camera roll sync may span multiple sessions; each
  session picks up where the last one left off.

**FS Watcher (desktop, future):**
- Uses `inotify` (Linux) / `FSEvents` (macOS) / `ReadDirectoryChangesW` (Windows)
- Watches configured directories for file create/modify/delete
- Same pipeline: detect → event → sync → index (enrichment runs separately)
- Runs as a background daemon (launchd / systemd)

**Future:**
- iOS: PhotoKit + background task API
- Web app / PWA for quick notes and bookmarks

### 2. Event Store (Postgres)

The event store is the source of truth. For v1, it's a single Supabase
Postgres database — shared, cloud-hosted, always available.

**Properties:**
- Append-only (no edits, no deletes — delete is a new event)
- Content-addressed (events reference content by hash)
- Single shared database (all devices write to the same Postgres instance)
- Every event carries a `device_id` for provenance
- JSONB for flexible metadata
- Full-text search via `tsvector` + GIN indexes

**Why Postgres for v1 (not SQLite):**
- Shared access — all devices and the Edge Function query the same database
- No sync protocol needed — just write to Postgres
- Supabase provides managed hosting, auth (future), and Edge Functions
- `tsvector` + GIN for full-text search, native JSONB operators
- Gets something working fast without building a sync layer

**v1 tradeoff:** Requires internet connectivity. No offline support. This
is acceptable for getting a working prototype — offline/local-first with
SQLite is a future version concern.

**Future: SQLite local-first (backlog)**
The per-device SQLite model from the original design is sound and worth
revisiting once v1 is validated. The append-only event model and
`device_id` provenance make eventual local-first migration tractable.

**Event schema:** See [interfaces.md](interfaces.md).

### 3. Enrichment (BYO LLM)

The enrichment layer sends media to an LLM and gets structured metadata back.
This is what turns dumb files into queryable knowledge.

**Auto-enrichment is an optimization, not the whole story.** Each piece of
media gets enriched independently at capture time. The enrichment result
varies by content type — a photo gets a visual description and object
labels, a voice memo gets a transcript and topic summary, a PDF gets
extracted text and key entities. The schema adapts to the content rather
than forcing everything into a single structure. This pre-populates the
event log with searchable content so that later, when a user or agent
queries across events, the metadata is already there. The agent assembles
project-level context at query time by reading across the collection of
enriched events — it doesn't need each item to know about the others.

The agent can also trigger re-enrichment on demand: "re-enrich these 12
photos as a group" or "regenerate enrichment for everything from last week."
This is just another CLI call (`smgr enrich`). Auto-enrichment at capture
handles the common case cheaply; agent-driven enrichment handles everything
else.

**Pipeline:**
```
1. User triggers capture (CLI `smgr add` or future Android batch sync) → `create` event
2. Enrichment picks up event (async, or immediately via `smgr add --enrich`)
3. Sends media bytes + mime_type to enrichment provider
4. Provider returns structured metadata appropriate to the content type
5. `enrich` event inserted into events.db with the structured metadata
6. Index updated with enriched data
```

**Key design decisions:**

- **Fully external, never blocking.** Enrichment is an external process that
  watches the event store for new `create` events. It makes an API call, and
  when (if) it finishes, inserts an `enrich` event back into the store. That's it.
  Nothing waits on enrichment. Apps that produce media have no idea enrichment
  exists — they write files, the user (or agent) runs a sync, a `create`
  event is written, and that's it. Enrichment output shows up in the log later.

- **Provider-agnostic.** The enrichment provider interface is:
  `enrich(media_bytes, mime_type) → EnrichmentResult`. Swap providers by
  changing config. Claude, GPT, Gemini, Ollama — same contract.

- **Cost control.** Config controls which media types get auto-enriched.
  Default: camera photos and screenshots. Skip memes, downloads, app-generated
  images unless explicitly requested. Per-watcher `auto_enrich` flag. Show
  estimated cost when processing a batch — Claude vision API charges per-token
  regardless of subscription plan (~$0.01–0.05 per photo depending on
  resolution).

- **Retry on failure.** If the enrichment API call fails (provider error,
  timeout, etc.), an `enrich_failed` event is inserted into the store so
  it can be retried later. Content is never lost — the `create` event
  and blob are unaffected. `smgr enrich --pending` retries all failed items.

- **Raw response preserved.** The full LLM response is stored in the event.
  If we improve the structured extraction later, we can re-process from the
  raw response without re-calling the API.

### 4. Blob Storage

Binary content (photos, videos, audio) lives in S3-compatible storage.
For v1, media arrives in the bucket via external sync tools (rclone,
Syncthing, etc.) — sitemgr watches the bucket, not uploads to it.

**v1: Supabase Storage** (S3-compatible API, used for testing/prototyping).
**Backlog: BYO S3** — support any S3-compatible provider (AWS S3, R2,
MinIO, GCS). The storage provider interface is designed for this, but
v1 focuses on getting things working with Supabase.

**Key scheme:** Content-addressed.
```
media/{first-2-chars-of-hash}/{full-hash}.{ext}
```

**Provider interface:**
```
put(hash, bytes, ext) → remote_path
get(hash) → bytes
exists(hash) → bool
delete(hash) → void
```

### 5. Document Sync (Git) *(future)*

Text content (notes, documents, bookmarks) syncs to a git remote. Unlike
blobs, **documents are not content-hashed** — git handles their identity,
history, and deduplication. The local filesystem is mirrored to git as-is.

**Behavior:**
- Watch directory is itself a git repo (or a subdirectory of one)
- On file change: auto-commit with a message template
- Commits and pushes happen **frequently** — on every save, app
  background, or context switch — not on a timer
- On app foreground or device switch: pull before opening

**Sync model: one editor at a time, small frequent commits.** The main
use case is an individual switching between devices (mobile and laptop),
not simultaneous editing. The sync cycle:

1. When the app backgrounds, closes, or the user switches context, write
   the file to disk immediately.
2. The background service detects the file change and commits + pushes to
   git immediately.
3. When the app foregrounds on another device, pull before opening the
   file.

Commits should be small and frequent so diffs stay readable. We do not
need to support two editors writing the same file at the same time. Worst
case, if a conflict does occur (e.g., both devices were offline), it is a
normal git merge conflict and can be resolved manually.

**Why git:**
- Already handles text merge well
- History is built in
- Works with any git host (GitHub, Gitea, self-hosted)
- Users already know it

### 6. Query Provider (BYO Query)

The query provider sits in front of the event store and abstracts how
queries are executed. All consumers go through this interface — the third
BYO contract.

**The abstraction:**
```
query(filter) → Event[]
```

Where filter supports:
- `content_type` — photo, video, note, etc.
- `tags` — match on enrichment-suggested or user-applied tags
- `search` — full-text search across descriptions, titles, tags
- `since` / `until` — date range
- `type` — event type (create, enrich, sync, etc.)
- `device_id` — filter by originating device

**Consumers of the query interface:**
- **CLI** — `smgr query --tags bed-repair --type photo` (foundational)
- **Agent (OpenClaw)** — translates natural language to CLI calls via chat
- **Future UI** — web dashboard querying across device databases

The Edge Function queries Postgres directly. The CLI also queries Postgres.
They all go through the query interface. The query backend is swappable.

**v1 implementation: Postgres + tsvector/GIN**

The event store and query index are the same database. Tables:
- `events` — all events, indexed by type, content_type, timestamp, device_id
- `enrichments` — enrichment results linked to source events, with GIN-indexed
  `tsvector` column for full-text search
- `watched_keys` — S3 sync tracking

All devices and consumers query the same Postgres instance — no sync or
merge logic needed.

**Future: SQLite + FTS5 for local-first (backlog).** The original design
used per-device SQLite with `ATTACH DATABASE` for cross-device queries.
This is still a valid architecture for a future offline-capable version.

### 7. Renderers *(future)*

Renderers turn query results into output formats.

**Input:** A set of events + a template + a resolver function.
**Output:** HTML, JSON, Markdown, or Atom/RSS.

The resolver function is what makes templates portable: it maps
`smgr://sha256:abc123` to either a local file path or an S3 URL depending
on context.

**Built-in templates:**
- `gallery` — photo grid with lightbox
- `note` — clean reading layout
- `blog` — article with date/tags
- `quote` — styled card with attribution
- `bookmarks` — categorized link list
- `feed` — Atom/RSS feed

### 8. Publish *(future)*

Publish = render + upload.

- Renders HTML using the web context (S3 URLs)
- Uploads HTML + any referenced assets to storage
- Returns a shareable URL
- Optional: private URLs (non-guessable path)

### 9. Observability

Multiple async pipelines (capture → event → enrichment) need to be
debuggable. The event log is itself the primary observability tool — every
action produces an event, including failures (`enrich_failed`, etc.).

**Key queries:**
- `smgr enrich --status` — how many items are pending enrichment, how many
  failed, what errors occurred
- `smgr sync status` — what's pending upload, what failed, queue depth
- `smgr index stats` — event counts by type, storage usage, index health

**Failure visibility:** Failed enrichments produce `enrich_failed` events
with error details and attempt counts. Failed syncs produce equivalent
events. The agent or CLI can query for these to surface problems:
"are any of my photos stuck?" → `smgr query --type enrich_failed`.

No separate logging infrastructure needed — the event store is the log.

---

## Data Flow: The Core Loop

### Photo Arrives in S3 → Index + Enrich (v1)

```
1. User takes photo on phone
2. rclone/Syncthing/s3drive syncs it to S3: photos/2025/03/IMG_1234.jpg
3. smgr watch detects new object (polling) or webhook fires
4. smgr downloads the image bytes, computes SHA-256 hash
5. CREATE event inserted into Postgres:
   { type: "create", content_type: "photo", device_id: "s3-watch",
     content_hash: "sha256:...",
     remote_path: "s3://bucket/photos/2025/03/IMG_1234.jpg",
     metadata: { source: "s3-watch", size_bytes: 2450320 } }
6. Enrichment sends image to Claude:
   { description: "Cracked wooden bed frame, split along side rail...",
     objects: ["bed frame", "wood", "crack"], context: "furniture repair",
     suggested_tags: ["bed-repair", "woodworking"] }
7. ENRICH event inserted into Postgres with tsvector index updated
8. Now searchable via WhatsApp bot or CLI
```

### WhatsApp Query (v1)

```
User: "what did I photograph this week?"
Bot:  Queries Postgres → enrichments full-text search
      Returns conversational summary of matching photos
```

A single capture produces multiple sitemgr events (CREATE, ENRICH).
Since the event store is append-only, these events can be processed
in sequence. Items with CREATE but no ENRICH event are pending —
`smgr enrich --pending` catches them up.

### Agent Query + Content Generation

The user interacts via WhatsApp (Twilio → Supabase Edge Function).
The Edge Function queries Postgres directly — no CLI subprocess.

```
1. User (via WhatsApp): "write a blog post about my bed repair project"
2. Edge Function calls Claude with the user's message
3. Claude generates a structured query intent
4. Edge Function queries Postgres: full-text search on enrichments
5. Returns 12 matching events spanning two months, each with pre-computed metadata
6. Claude reads the enriched descriptions chronologically and generates a narrative
7. Response sent back via WhatsApp
```

The blog post is grounded — every description came from the LLM looking at
the actual photo at capture time. The agent assembles the narrative from
pre-existing metadata. No additional vision calls needed, no hallucination
about what happened.

---

## Configuration (v1)

All via environment variables (12-factor friendly):

```bash
# Supabase (required for v1)
export SUPABASE_URL=https://<ref>.supabase.co
export SUPABASE_SECRET_KEY=eyJ...

# S3 bucket (where media lives)
export SMGR_S3_BUCKET=my-photos
export SMGR_S3_PREFIX=photos/
export SMGR_S3_ENDPOINT=https://...    # Supabase Storage or external S3
export SMGR_S3_REGION=us-east-1

# Enrichment
export SMGR_ENRICHMENT_PROVIDER=anthropic
export ANTHROPIC_API_KEY=sk-...
export SMGR_AUTO_ENRICH=true

# Watcher
export SMGR_WATCH_INTERVAL=30  # seconds between polls

# WhatsApp bot
export TWILIO_ACCOUNT_SID=AC...
export TWILIO_AUTH_TOKEN=...
export TWILIO_WHATSAPP_FROM=whatsapp:+14155238886
```

---

## Technology Choices (v1)

| Component       | Choice                  | Rationale                                     |
|-----------------|-------------------------|-----------------------------------------------|
| Event store     | Supabase Postgres       | Managed, shared, no sync protocol needed      |
| Full-text search| Postgres tsvector + GIN | Built into Postgres, no separate engine       |
| Blob storage    | Supabase Storage (S3)   | S3-compatible, co-located with Postgres. BYO S3 is backlog. |
| Enrichment      | LLM API                 | BYO — Claude, GPT, Gemini, Ollama             |
| Webhook handler | Supabase Edge Functions | Serverless Deno/TypeScript, free tier          |
| Bot transport   | Twilio (WhatsApp)       | WhatsApp Business API                          |
| Agent brain     | Claude                  | Natural language → structured queries          |
| Config          | Environment variables   | 12-factor, works with Edge Functions           |

**Future technology options (backlog):**

| Component       | Choice         | Rationale                                     |
|-----------------|----------------|-----------------------------------------------|
| Language        | Rust           | Single binary, fast, cross-platform            |
| Local event store| SQLite (WAL)  | Per-device, offline-capable                    |
| Local FTS       | FTS5           | Built into SQLite                              |
| CLI framework   | clap           | Standard Rust CLI library                      |
| Doc storage     | Git            | Already handles text well, built-in history    |

---

## What We're NOT Building

- **Not a CMS.** No admin panel, no WYSIWYG editor.
- **Not a photo editor / note editor / etc.** We observe what other apps produce.
- **Not a backup system.** Sync ≠ backup. Use restic/borg/etc. for backups.
- **Not an LLM.** We call LLMs. Swap providers any time.
- **Not a sync tool.** Media gets to S3 via existing tools (rclone, Syncthing, etc.). We watch, index, and enrich.

**v1 uses Supabase as a hosted backend.** This is a pragmatic choice to
get a working prototype fast. The architecture preserves provider
interfaces so a future version can support BYO storage and local-first
operation.

---

---

## Future Considerations

- **Local-first / offline mode.** The original per-device SQLite design is
  sound. Once v1 is validated with cloud Postgres, revisit local-first with
  SQLite + FTS5 for offline-capable operation. The append-only event model
  and `device_id` provenance make this migration tractable.

- **BYO S3-compatible storage.** v1 uses Supabase Storage. Support any
  S3-compatible API (AWS S3, Cloudflare R2, MinIO, GCS) so users own
  their storage infrastructure.

- **Enrichment metadata in S3.** Store enrichment results as sidecar JSON
  files in S3 alongside the media (e.g., `{hash}.meta.json`). This makes
  metadata portable — it lives in the user's storage, not just in Postgres.
  If the user switches backends or wants to export, the metadata travels
  with the media. Worth exploring after the prototype is working.

- **Enrichment batching.** Group rapid-fire captures (e.g., 20 photos at a
  job site) into a single enrichment call with session context so the LLM can
  infer relationships across photos. This is a cost and quality optimization —
  not required for the core loop. Single-item auto-enrichment at capture
  handles the common case. The agent can always re-enrich a set of photos
  with shared context on demand at query time.
