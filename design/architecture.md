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
│                      EVENT LOG                              │
│                                                             │
│  Append-only, locally stored, content-addressed.            │
│  Every action becomes an event. Events are immutable.       │
│  Stored as newline-delimited JSON (ndjson).                 │
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
│                │ │ Ollama     │ │  conflict =    │
│ content-       │ │            │ │  branch        │
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
│                         INDEX                               │
│                      (Query Provider)                       │
│                                                             │
│  Derived from the event log. Deletable and rebuildable.     │
│  Abstracts the index backend behind a query interface.      │
│                                                             │
│  - Full-text search (FTS5)                                  │
│  - Semantic search over enriched descriptions               │
│  - Filter by content type, tags, date range                 │
│  - Hash → local path, remote URL                            │
│  - Event log position (for replay)                          │
└────────────────────────┬────────────────────────────────────┘
                         │
              ┌──────────┼──────────┐
              ▼          ▼          ▼
┌──────────────┐ ┌────────────┐ ┌──────────────┐
│    AGENT     │ │    CLI     │ │   FUTURE UI  │
│              │ │            │ │              │
│  Translates  │ │  smgr query│ │  Web, mobile │
│  natural     │ │  smgr show │ │  dashboard   │
│  language →  │ │  smgr ls   │ │              │
│  query calls │ │            │ │              │
└──────────────┘ └────────────┘ └──────┬───────┘
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
- Emits `create` event to the event log immediately
- Triggers async enrichment (does not block the user)
- Runs as a foreground service or WorkManager job

**CLI:**
- `smgr add` commands create events directly
- Useful for content types that aren't file-based (bookmarks, quotes)
- Works on any platform with a terminal

**FS Watcher (desktop):**
- Uses `inotify` (Linux) / `FSEvents` (macOS) / `ReadDirectoryChangesW` (Windows)
- Watches configured directories for file create/modify/delete
- Same pipeline: event → enrich → sync → index
- Runs as a background daemon (launchd / systemd)

**Future:**
- iOS: PhotoKit observers, file provider
- Web app / PWA for quick notes and bookmarks

### 2. Event Log

The event log is the source of truth. It's an append-only file stored as
newline-delimited JSON (ndjson). Each line is a self-contained event.

**Properties:**
- Append-only (no edits, no deletes — delete is a new event)
- Content-addressed (events reference content by hash)
- Locally stored (sync between devices is a separate concern)
- Human-readable (it's just JSON lines)

**Why ndjson:**
- Easy to append (just write a line)
- Easy to stream/tail
- Easy to merge (line-oriented, like git)
- Easy to parse in any language
- Good enough for hundreds of thousands of events

**Event schema:** See [interfaces.md](interfaces.md).

### 3. Enrichment (BYO LLM)

The enrichment layer sends media to an LLM and gets structured metadata back.
This is what turns dumb files into queryable knowledge.

**Pipeline:**
```
1. Observer detects new media → emits `create` event (immediate)
2. Enrichment picks up event (async, background)
3. Sends media bytes + mime_type to enrichment provider
4. Provider returns: description, objects, context, suggested_tags
5. `enrich` event appended to log with the structured metadata
6. Index updated with enriched data
```

**Key design decisions:**

- **Async.** The `create` event is logged immediately. Enrichment happens in
  the background. The user is never waiting on an API call to take their next
  photo. The `enrich` event links back to the `create` event via `parent_id`.

- **Provider-agnostic.** The enrichment provider interface is:
  `enrich(media_bytes, mime_type) → EnrichmentResult`. Swap providers by
  changing config. Claude, GPT, Gemini, Ollama — same contract.

- **Batching.** If the user takes 20 photos in quick succession (e.g., at a
  job site), batch them into a single enrichment call with context: "these
  are part of the same session." The LLM can infer project relationships
  across photos. Batching is optional — single-photo enrichment works fine.

- **Cost control.** Config controls which media types get auto-enriched.
  Default: camera photos and screenshots. Skip memes, downloads, app-generated
  images unless explicitly requested. Per-watcher `auto_enrich` flag.

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
- On conflict: create a branch, never lose data

**Why git:**
- Already handles text merge well
- History is built in
- Works with any git host (GitHub, Gitea, self-hosted)
- Users already know it

### 6. Index / Query Provider (BYO Index)

The index is a derived, rebuildable view of the event log optimized for
queries. It sits behind the **query provider** interface — the third BYO
contract.

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

**Consumers of the query interface:**
- **Agent** — translates natural language to structured queries
- **CLI** — `smgr query --tags bed-repair --type photo`
- **Future UI** — web dashboard, mobile browse

The agent does NOT know about SQLite. The CLI does NOT know about SQLite.
They both call the query interface. The index backend is swappable.

**Default implementation: SQLite + FTS5**

Tables:
- `events` — all events, indexed by type, content_type, timestamp
- `tags` — tag → event_id mapping
- `enrichments` — enrichment results linked to source events
- `fts` — FTS5 virtual table for full-text search across descriptions,
  titles, tags
- `hashes` — content_hash → local_path, remote_url mapping

**Rebuild:** `smgr index rebuild` replays the event log from scratch.

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

---

## Data Flow: The Core Loop

### Photo Capture + Enrichment (Android)

```
1. User takes photo → camera app saves to MediaStore
2. ContentObserver fires: new image detected
3. App computes SHA-256 hash of the image
4. CREATE event appended to events.ndjson:
   { type: "create", content_type: "photo", content_hash: "sha256:...",
     metadata: { mime_type: "image/jpeg", size_bytes: 2450320, ... } }
5. Index updated with new event
6. Blob sync uploads image to S3 (background)
7. SYNC event appended: { type: "sync", parent_id: "...", remote_path: "s3://..." }
8. Enrichment sends image to Claude (background)
9. Claude returns: { description: "Cracked wooden bed frame, split along
   side rail...", objects: ["bed frame", "wood", "crack"], context: "furniture
   repair", suggested_tags: ["bed-repair", "woodworking"] }
10. ENRICH event appended: { type: "enrich", parent_id: "...", metadata:
    { enrichment: { ... } } }
11. Index updated with enriched metadata — now searchable
```

Steps 4-5 are immediate. Steps 6-11 are async — the user can keep taking
photos without waiting.

### Agent Query + Content Generation

```
1. User: "give me all photos from the bed repair project"
2. Agent calls query interface: { tags: ["bed-repair"], content_type: "photo" }
3. Query provider searches index, returns matching events with enrichment data
4. Agent presents results to user with descriptions and thumbnails

5. User: "write a blog post about the bed repair project"
6. Agent calls query interface again for full event set
7. Agent reads enriched descriptions in chronological order
8. Agent generates markdown with smgr:// references to actual photos
9. Agent calls: smgr publish blog.md
10. HTML rendered, uploaded to S3, URL returned
11. Agent: "Here's your blog post: https://..."
```

The blog post is grounded — every description came from the LLM looking at
the actual photo. No hallucination about what happened; the enrichment data
is the source of truth.

---

## Configuration

```toml
# ~/.sitemgr/config.toml

# Where the event log is stored
event_log = "~/.sitemgr/events.ndjson"

# Where the local index (SQLite) is stored
index_db = "~/.sitemgr/index.db"

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

# Batching: group rapid-fire captures into one enrichment call
batch_window = "30s"        # group photos taken within 30s of each other
max_batch_size = 10         # max photos per batch call

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
| Event log       | ndjson file    | Simple, appendable, mergeable                 |
| Index           | SQLite + FTS5  | Embedded, fast, full-text search built in     |
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
- **Not a database.** SQLite is a cache/index. The event log is the source of truth.
- **Not a CMS.** No admin panel, no user accounts, no WYSIWYG editor.
- **Not a sync protocol.** We use S3 and git — commodity sync.
- **Not a photo editor / note editor / etc.** We observe what other apps produce.
- **Not a backup system.** Sync ≠ backup. Use restic/borg/etc. for backups.
- **Not an LLM.** We call LLMs. Swap providers any time.

---

## Phasing

### Phase 1: Android Core Loop (MVP)
- Android app with ContentObserver on MediaStore
- Event log (ndjson) — local on device
- Enrichment provider interface + Anthropic implementation
- Async enrichment pipeline (capture → enrich → store)
- Storage provider interface + S3 implementation
- SQLite index with FTS5
- Query provider interface
- Basic on-device UI: browse events, see enrichment results

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

### Phase 4: Cross-Device Sync
- Event log sync between devices (phone ↔ desktop)
- Conflict resolution
- Multi-device index merge

### Phase 5: Expand
- iOS support
- Additional enrichment types (audio transcription, video keyframes)
- Semantic search (vector embeddings from enrichment)
- Web dashboard (read-only browse + quick add)
