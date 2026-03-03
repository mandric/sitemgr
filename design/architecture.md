# Architecture

## System Overview

```
┌─────────────────────────────────────────────────────────────┐
│                        OBSERVERS                            │
│                                                             │
│  ┌─────────────┐  ┌───────────┐  ┌──────────┐  ┌────────┐  │
│  │  Android     │  │   CLI     │  │ FS Watch │  │ Future │  │
│  │  ContentObs  │  │           │  │ (desktop)│  │ (iOS)  │  │
│  └──────┬──────┘  └─────┬─────┘  └────┬─────┘  └───┬────┘  │
└─────────┼───────────────┼─────────────┼────────────┼────────┘
          │               │             │            │
          ▼               ▼             ▼            ▼
┌─────────────────────────────────────────────────────────────┐
│                    EVENT STORE                               │
│                                                             │
│  Append-only, locally stored, content-addressed.            │
│  Every action becomes an event. Events are immutable.       │
│  Stored in a per-device SQLite database (WAL mode).         │
│  Each event carries a device_id for provenance.             │
│                                                             │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐             │
│  │evt 1 │→│evt 2 │→│evt 3 │→│evt 4 │→│evt 5 │→ ...        │
│  └──────┘ └──────┘ └──────┘ └──────┘ └──────┘             │
└────────────────────────┬────────────────────────────────────┘
                         │
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
┌────────────────┐ ┌────────────┐ ┌────────────────┐
│  BLOB SYNC     │ │ ENRICHMENT │ │  DOCUMENT SYNC │
│  (Storage      │ │ (Enrichment│ │  (Git)         │
│   Provider)    │ │  Provider) │ │                │
│                │ │            │ │                │
│ BYO: S3, R2,  │ │ BYO: Claude│ │  auto-commit   │
│ GCS, local     │ │ GPT, Gemini│ │  auto-push     │
│                │ │ Ollama     │ │  conflict       │
│ content-       │ │            │ │  resolution TBD │
│ addressed      │ │ media →    │ │                │
│ key scheme     │ │ structured │ │                │
│                │ │ metadata   │ │                │
└───────┬────────┘ └─────┬──────┘ └───────┬────────┘
        │                │                │
        │                ▼                │
        │  ┌──────────────────────┐       │
        │  │  Enrichment result   │       │
        │  │  appended as new     │       │
        │  │  event to log        │       │
        │  └──────────┬───────────┘       │
        │             │                   │
        └─────────────┼───────────────────┘
                      ▼
┌─────────────────────────────────────────────────────────────┐
│                    QUERY INTERFACE                           │
│                      (Query Provider)                       │
│                                                             │
│  Queries run against the SQLite event store directly.       │
│  FTS5 indexes are maintained alongside event data.          │
│                                                             │
│  - Full-text search (FTS5)                                  │
│  - Semantic search over enriched descriptions               │
│  - Filter by content type, tags, date range, device_id      │
│  - Hash → local path, remote URL                            │
│  - ATTACH multiple device DBs for cross-device queries      │
└────────────────────────┬────────────────────────────────────┘
                         │
              ┌──────────┼──────────┐
              ▼          ▼          ▼
┌────────────┐ ┌──────────────┐ ┌──────────────┐
│    CLI     │ │    AGENT     │ │   FUTURE UI  │
│            │ │              │ │              │
│  smgr query│ │  Translates  │ │  Web, mobile │
│  smgr show │ │  natural     │ │  dashboard   │
│  smgr enrich│ │  language →  │ │              │
│  smgr sync │ │  CLI calls   │ │              │
└────────────┘ └──────────────┘ └──────┬───────┘
                                       │
                                       ▼
                            ┌──────────────────────┐
                            │     RENDERERS        │
                            │                      │
                            │  Markdown → HTML     │
                            │  Templates per type  │
                            │  Static site export  │
                            │                      │
                            │  Gallery, blog,      │
                            │  feed, note, ...     │
                            └──────────┬───────────┘
                                       │
                                       ▼
                            ┌──────────────────────┐
                            │     PUBLISH          │
                            │                      │
                            │  Upload rendered     │
                            │  HTML + assets to S3 │
                            │                      │
                            │  → shareable URL     │
                            └──────────────────────┘
```

---

## Component Details

### 1. Observers

Observers detect changes in the outside world and emit events.

**Android ContentObserver (primary):**
- Registers `ContentObserver` on `MediaStore.Images`, `MediaStore.Video`
- Fires on every new photo, video, or screenshot
- Computes content hash (SHA-256) for new files
- Emits `create` event to the event store immediately
- **Runs as a background service** with a persistent notification ("sitemgr
  is watching for new media"). This is the only way to guarantee timely
  event detection on Android 12+. WorkManager cannot provide the "within
  seconds" latency the core loop requires. The background service runs the
  full pipeline — event detection, hash computation, blob sync, enrichment,
  and indexing — so data is always fresh and ready when the UI opens. No
  work is deferred to app launch. This is a core service that must always
  be running.

**CLI:**
- `smgr add` commands create events directly
- Useful for content types that aren't file-based (bookmarks, quotes)
- Works on any platform with a terminal

**FS Watcher (desktop):**
- Uses `inotify` (Linux) / `FSEvents` (macOS) / `ReadDirectoryChangesW` (Windows)
- Watches configured directories for file create/modify/delete
- Same pipeline: detect → event → sync → index (enrichment runs separately)
- Runs as a background daemon (launchd / systemd)

**Future:**
- iOS: PhotoKit observers, file provider
- Web app / PWA for quick notes and bookmarks

### 2. Event Store (SQLite)

The event store is the source of truth. It's a per-device SQLite database
running in WAL mode. Each device maintains its own database — no concurrent
writer conflicts, no file locking, no dual-write consistency problems.

**Properties:**
- Append-only (no edits, no deletes — delete is a new event)
- Content-addressed (events reference content by hash)
- Per-device (each device owns its own database)
- Every event carries a `device_id` for provenance
- SQLite WAL mode handles concurrent reads safely
- Single database for both event storage and querying — no separate index to keep in sync

**Why SQLite (not ndjson):**
- Writes and queries in one place — no separate log + index to keep in sync
- Built-in concurrency (WAL mode) — no file locking needed
- `INSERT` is as easy as appending a line to a file
- FTS5 for full-text search lives alongside the data
- Handles millions of events easily
- Cross-device queries via `ATTACH DATABASE` — no merge logic needed
- Still inspectable: `sqlite3 events.db "SELECT * FROM events"`

**Multi-device model:**
- Each device maintains its own `events.db`
- A web dashboard or CLI can `ATTACH` multiple device databases and query
  across them (e.g., "show me all photos from all devices last week")
- No merge, no conflict resolution, no sync protocol needed for reads
- Cross-device sync (replicating events between devices) is a future concern
  with its own design — but the per-device model works now

**Event schema:** See [interfaces.md](interfaces.md).

### 3. Enrichment (BYO LLM)

The enrichment layer sends media to an LLM and gets structured metadata back.
This is what turns dumb files into queryable knowledge.

**Auto-enrichment is an optimization, not the whole story.** Each piece of
media gets enriched independently at capture time — the LLM describes what
it sees in the image and returns structured metadata (description, objects,
context, tags). This pre-populates the event log with searchable content so
that later, when a user or agent queries across events, the metadata is
already there. The agent assembles project-level context at query time by
reading across the collection of enriched events — it doesn't need each
photo to know about the others.

The agent can also trigger re-enrichment on demand: "re-enrich these 12
photos as a group" or "regenerate enrichment for everything from last week."
This is just another CLI call (`smgr enrich`). Auto-enrichment at capture
handles the common case cheaply; agent-driven enrichment handles everything
else.

**Pipeline:**
```
1. Observer detects new media → emits `create` event (immediate)
2. Enrichment picks up event (async, background)
3. Sends media bytes + mime_type to enrichment provider
4. Provider returns: description, objects, context, suggested_tags
5. `enrich` event inserted into events.db with the structured metadata
6. Index updated with enriched data
```

**Key design decisions:**

- **Fully external, never blocking.** Enrichment is an external process that
  watches the event store for new `create` events. It makes an API call, and
  when (if) it finishes, inserts an `enrich` event back into the store. That's it.
  Nothing waits on enrichment. Apps that produce media have no idea enrichment
  exists — they write files, an observer emits a `create` event, and the app
  is done. Enrichment output just shows up in the log later.

- **Provider-agnostic.** The enrichment provider interface is:
  `enrich(media_bytes, mime_type) → EnrichmentResult`. Swap providers by
  changing config. Claude, GPT, Gemini, Ollama — same contract.

- **Cost control.** Config controls which media types get auto-enriched.
  Default: camera photos and screenshots. Skip memes, downloads, app-generated
  images unless explicitly requested. Per-watcher `auto_enrich` flag.

- **Offline-safe.** Enrichment is an external API call. If the device is
  offline (or the provider is unreachable), the call fails and an
  `enrich_failed` event is inserted into the store so it can be retried later.
  Content is never lost — the `create` event and blob are unaffected.

- **Online trigger.** When connectivity is restored, the enrichment process
  queries the index for `create` events that have no corresponding `enrich`
  event. Any unenriched items are re-queued automatically. This means the
  user can take photos all day on airplane mode and enrichment catches up
  when they're back online.

- **Raw response preserved.** The full LLM response is stored in the event.
  If we improve the structured extraction later, we can re-process from the
  raw response without re-calling the API.

### 4. Blob Sync (BYO Storage)

Binary content (photos, videos, audio) syncs to user-provided storage.

**Key scheme:** Content-addressed.
```
s3://bucket/prefix/{first-2-chars-of-hash}/{full-hash}.{ext}
```

Example:
```
s3://my-bucket/sync/a1/a1b2c3d4e5f6...jpg
```

**Sync behavior:**
- On `create` event: upload blob to storage key derived from hash
- On `delete` event: check if hash is still referenced; if not, delete
- Idempotent: re-uploading the same hash is a no-op (content-addressed)
- Retry with exponential backoff on failure

**Provider interface:**
```
put(hash, bytes, ext) → remote_path
get(hash) → bytes
exists(hash) → bool
delete(hash) → void
```

Implementations: S3, Cloudflare R2, Google Cloud Storage, local filesystem.

### 5. Document Sync (Git)

Text content (notes, documents, bookmarks) syncs to a git remote.

**Behavior:**
- Watch directory is itself a git repo (or a subdirectory of one)
- On file change: auto-commit with a message template
- Batch commits and push on a configurable interval (default: 5 minutes)

**Conflict avoidance (v0): single-writer per device.** Each device writes
to its own directory within the repo (e.g., `notes/pixel-7a/`, `notes/
thinkpad-x1/`). No two devices write to the same path, so git push never
conflicts. Cross-device reads work — the laptop can read the phone's notes
directory. Multi-device editing of the same file is a future concern that
may require CRDTs or an explicit merge UX; for now we avoid it by
construction.

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
- **Agent** — translates natural language to CLI calls
- **Future UI** — web dashboard querying across device databases

The CLI does NOT know about SQLite. The agent calls the CLI. They all go
through the query interface. The query backend is swappable.

**Default implementation: SQLite + FTS5**

The event store and query index are the same database. Tables:
- `events` — all events, indexed by type, content_type, timestamp, device_id
- `tags` — tag → event_id mapping
- `enrichments` — enrichment results linked to source events
- `fts` — FTS5 virtual table for full-text search across descriptions,
  titles, tags
- `hashes` — content_hash → local_path, remote_url mapping

**Cross-device queries:** A web dashboard or desktop CLI can `ATTACH`
multiple device databases and query across them using SQLite's built-in
cross-database query support. No merge or replication needed for read access.

**Rebuild:** `smgr index rebuild` rebuilds FTS and derived indexes from
the events table.

### 7. Renderers

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

### 8. Publish

Publish = render + upload.

- Renders HTML using the web context (S3 URLs)
- Uploads HTML + any referenced assets to storage
- Returns a shareable URL
- Optional: private URLs (non-guessable path)

### 9. Observability

Multiple async pipelines (observer → event → sync → enrichment) need to be
debuggable. The event log is itself the primary observability tool — every
action produces an event, including failures (`enrich_failed`, sync errors).

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

### Photo Capture + Enrichment (Android)

```
1. User takes photo → camera app saves to MediaStore
2. ContentObserver fires: new image detected
3. App computes SHA-256 hash of the image
4. CREATE event inserted into device's events.db:
   { type: "create", content_type: "photo", device_id: "pixel-7a",
     content_hash: "sha256:...",
     metadata: { mime_type: "image/jpeg", size_bytes: 2450320, ... } }
5. FTS index updated automatically (same database)
6. Blob sync uploads image to S3 (background)
7. SYNC event inserted: { type: "sync", parent_id: "...", remote_path: "s3://..." }
8. Enrichment sends image to Claude (background)
9. Claude returns: { description: "Cracked wooden bed frame, split along
   side rail...", objects: ["bed frame", "wood", "crack"], context: "furniture
   repair", suggested_tags: ["bed-repair", "woodworking"] }
10. ENRICH event inserted: { type: "enrich", parent_id: "...", metadata:
    { enrichment: { ... } } }
11. FTS index updated — now searchable
```

Steps 4-5 are immediate. Steps 6-11 are async — the user can keep taking
photos without waiting.

### Agent Query + Content Generation

```
1. User: "write a blog post about my bed repair project from the last few months"
2. Agent calls CLI: smgr query --search "bed repair" --type photo --format json
3. Query provider searches FTS index across enriched descriptions, returns
   12 matching events spanning two months, each with pre-computed metadata
4. Agent reads the enriched descriptions chronologically — it can see the
   full arc of the project without re-analyzing any images
5. Agent generates markdown with smgr:// references to actual photos
6. Agent calls: smgr publish blog.md
7. HTML rendered, uploaded to S3, URL returned
8. Agent: "Here's your blog post: https://..."
```

The blog post is grounded — every description came from the LLM looking at
the actual photo at capture time. The agent assembles the narrative from
pre-existing metadata. No additional vision calls needed, no hallucination
about what happened.

---

## Configuration

```toml
# ~/.sitemgr/config.toml

# Device identity — unique per device, human-readable
device_id = "pixel-7a"
device_name = "Milan's Pixel 7a"

# Where the event store (SQLite) lives
events_db = "~/.sitemgr/events.db"

# Where synced blobs are cached locally (content-addressed)
blob_store = "~/.sitemgr/blobs"

# --- Storage Provider (BYO) ---

[storage]
provider = "s3"             # "s3" | "r2" | "gcs" | "local"
bucket = "my-site-assets"
prefix = "sync/"
region = "us-east-1"
# Credentials from env vars or cloud SDK credential chain

# --- Enrichment Provider (BYO) ---

[enrichment]
provider = "anthropic"      # "anthropic" | "openai" | "google" | "ollama"
model = "claude-sonnet-4-20250514"
auto_enrich = true
media_types = ["image/*", "video/*"]
# For Ollama: endpoint = "http://localhost:11434"
# API keys from env vars: ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.

# --- Watchers ---

# Android watchers are configured in the Android app settings.
# Desktop watchers use the same format as before:

[[watcher]]
path = "~/Screenshots"
content_type = "photo"
patterns = ["*.png", "*.jpg", "*.jpeg", "*.webp"]
auto_enrich = true

[[watcher]]
path = "~/notes"
content_type = "note"
patterns = ["*.md"]
auto_enrich = false         # text notes don't need vision enrichment

# --- Document Sync (Git) ---

[targets.git]
remote = "git@github.com:user/notes.git"
branch = "main"
push_interval = "5m"
commit_message = "sync: {file} [{event_id}]"
```

---

## Technology Choices

| Component       | Choice         | Rationale                                     |
|-----------------|----------------|-----------------------------------------------|
| Primary platform| Android (Kotlin)| Mobile-first — photos are taken on phones    |
| CLI / Desktop   | Rust           | Single binary, fast, cross-platform           |
| Event store     | SQLite (WAL)   | Writes + queries in one place, no dual-write  |
| Full-text search| FTS5           | Built into SQLite, no separate engine needed  |
| Blob storage    | S3-compatible  | BYO — any provider works                      |
| Enrichment      | LLM API        | BYO — Claude, GPT, Gemini, Ollama             |
| Doc storage     | Git            | Already handles text well, built-in history   |
| FS watching     | notify crate   | Cross-platform (inotify/FSEvents/ReadDir)     |
| CLI framework   | clap           | Standard Rust CLI library                     |
| HTTP server     | axum           | Lightweight, async, good ergonomics           |
| Templates       | tera           | Jinja2-like, familiar syntax                  |
| Config          | TOML           | Readable, standard in Rust ecosystem          |

---

## What We're NOT Building

- **Not a platform.** No accounts, no hosted service, no subscription. BYO everything.
- **Not a centralized database.** Each device owns its own SQLite event store. There is no central server.
- **Not a CMS.** No admin panel, no user accounts, no WYSIWYG editor.
- **Not a sync protocol.** We use S3 and git — commodity sync.
- **Not a photo editor / note editor / etc.** We observe what other apps produce.
- **Not a backup system.** Sync ≠ backup. Use restic/borg/etc. for backups.
- **Not an LLM.** We call LLMs. Swap providers any time.

---

## Phasing

### Phase 1a: Android Capture + Sync
- Android app with ContentObserver on MediaStore (foreground service)
- Per-device SQLite event store (WAL mode) with device_id on every event
- Storage provider interface + S3 implementation
- Blob sync pipeline (capture → hash → store event → upload to S3)
- Basic on-device UI: browse events, view sync status
- Database export to S3 for cross-device reads

This phase proves the hardest part: reliable background event detection on
Android, content-addressed storage, and the S3 sync loop. No enrichment
yet — get the capture pipeline right first.

### Phase 1b: Enrichment
- Enrichment provider interface + Anthropic implementation
- Async enrichment pipeline (pick up create events → enrich → store)
- FTS5 indexes maintained in the same database
- Query provider interface (filter by tags, search descriptions)
- On-device UI: see enrichment results, search enriched content

Layered on top of a working capture pipeline. Now the event log becomes
searchable and queryable.

### Phase 2: CLI + Agent
- Rust CLI (`smgr query`, `smgr show`, `smgr resolve`, `smgr add`)
- Query interface exposed via CLI (same contract as Android)
- MCP server or Claude Code skill wrapping CLI
- Agent-driven query and content generation
- `smgr publish` for static site output

### Phase 3: Desktop + Render
- FS watcher daemon (macOS/Linux)
- Git document sync
- Template engine + built-in templates
- `smgr render` and `smgr publish`
- `smgr://` URI resolution

### Phase 4: Cross-Device Access + Sync
- Web dashboard that ATTACHes multiple device databases for aggregate queries
- Device database discovery (local network, shared storage, or manual path)
- Event replication between devices (phone → desktop, desktop → phone)
- Define concrete use cases that require merging vs. just cross-device reads

### Phase 5: Expand
- iOS support
- Additional enrichment types (audio transcription, video keyframes)
- Semantic search (vector embeddings from enrichment)
- Web dashboard (read-only browse + quick add)

---

## Future Considerations

- **Enrichment batching.** Group rapid-fire captures (e.g., 20 photos at a
  job site) into a single enrichment call with session context so the LLM can
  infer relationships across photos. This is a cost and quality optimization —
  not required for the core loop. Single-item auto-enrichment at capture
  handles the common case. The agent can always re-enrich a set of photos
  with shared context on demand at query time.
