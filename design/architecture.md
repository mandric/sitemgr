# Architecture

## System Overview

```
┌─────────────────────────────────────────────────────────────┐
│                        OBSERVERS                            │
│                                                             │
│  ┌─────────────┐  ┌───────────┐  ┌──────────┐  ┌────────┐  │
│  │ FS Watcher  │  │   CLI     │  │ Web App  │  │ Mobile │  │
│  │ (daemon)    │  │           │  │ (PWA)    │  │        │  │
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
              ┌──────────┼──────────┐
              ▼                     ▼
┌──────────────────────┐ ┌──────────────────────┐
│     BLOB SYNC        │ │    DOCUMENT SYNC     │
│                      │ │                      │
│  S3-compatible API   │ │  Git remote          │
│                      │ │                      │
│  - hash → S3 key     │ │  - auto-commit       │
│  - upload on create  │ │  - auto-push         │
│  - content-addressed │ │  - conflict = branch │
│    key scheme        │ │                      │
└──────────┬───────────┘ └──────────┬───────────┘
           │                        │
           ▼                        ▼
┌─────────────────────────────────────────────────────────────┐
│                         INDEX                               │
│                                                             │
│  SQLite. Derived from the event log.                        │
│  Deletable and rebuildable at any time.                     │
│                                                             │
│  - Full-text search (FTS5)                                  │
│  - Filter by content type, tags, date range                 │
│  - Hash → local path, remote URL                            │
│  - Event log position (for replay)                          │
└────────────────────────┬────────────────────────────────────┘
                         │
              ┌──────────┼──────────┐
              ▼                     ▼
┌──────────────────────┐ ┌──────────────────────┐
│     QUERY API        │ │     RENDERERS        │
│                      │ │                      │
│  HTTP (local daemon) │ │  Markdown → HTML     │
│  or CLI              │ │  Templates per type  │
│                      │ │  Static site export  │
│  - list events       │ │                      │
│  - search            │ │  Gallery, blog,      │
│  - resolve hashes    │ │  feed, note, ...     │
└──────────────────────┘ └──────────┬───────────┘
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

**FS Watcher (daemon):**
- Uses `inotify` (Linux) / `FSEvents` (macOS) / `ReadDirectoryChangesW` (Windows)
- Watches configured directories for file create/modify/delete
- Computes content hash (SHA-256) for new/modified files
- Emits events to the event log
- Runs as a background daemon (launchd / systemd)

**CLI:**
- `smgr add` commands create events directly
- Useful for content types that aren't file-based (bookmarks, quotes)

**Web App (PWA):**
- Posts events via the HTTP API
- For mobile capture (quick notes, bookmarks, photos from camera roll)

**Mobile:**
- Android: ContentObserver for media changes
- iOS: PhotoKit observers, file provider

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

### 3. Blob Sync (S3)

Binary content (photos, videos, audio) syncs to S3-compatible storage.

**Key scheme:** Content-addressed.
```
s3://bucket/prefix/{first-2-chars-of-hash}/{full-hash}.{ext}
```

Example:
```
s3://my-bucket/sync/a1/a1b2c3d4e5f6...jpg
```

**Sync behavior:**
- On `create` event: upload blob to S3 key derived from hash
- On `delete` event: check if hash is still referenced; if not, delete from S3
- Idempotent: re-uploading the same hash is a no-op (content-addressed)
- Retry with exponential backoff on failure

### 4. Document Sync (Git)

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

### 5. Index (SQLite)

The index is a derived, rebuildable view of the event log optimized for
queries.

**Tables:**
- `events` — all events, indexed by type, content_type, timestamp
- `tags` — tag → event_id mapping
- `fts` — FTS5 virtual table for full-text search across titles, descriptions, body text
- `hashes` — content_hash → local_path, remote_url mapping

**Rebuild:** `smgr index rebuild` replays the event log from scratch.

### 6. Query API

Dual interface: HTTP (for web app / agent) and CLI (for terminal / scripts).

Both return the same data. The CLI supports `--format json` for machine
consumption. The HTTP API always returns JSON.

See [interfaces.md](interfaces.md) for the full API surface.

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
- Uploads HTML + any referenced assets to S3
- Returns a shareable URL
- Optional: private URLs (non-guessable path)

---

## Data Flow Examples

### Screenshot Capture

```
1. User takes screenshot → ~/Screenshots/screen.png
2. FS Watcher detects new file
3. Watcher computes SHA-256 hash
4. Watcher emits event: { type: "create", content_type: "photo", content_hash: "sha256:...", local_path: "..." }
5. Event appended to ~/.sitemgr/events.ndjson
6. Index updated (SQLite)
7. Blob sync picks up event, uploads to S3
8. Event updated with remote_path (new "sync" event appended)
```

### Publish Gallery

```
1. User (or agent) runs: smgr publish gallery.md
2. CLI reads gallery.md, parses frontmatter (type: gallery)
3. CLI queries index for events referenced in the markdown (smgr:// URIs)
4. Renderer resolves smgr:// → S3 URLs
5. Renderer applies gallery template → HTML
6. CLI uploads HTML to S3
7. CLI returns the public URL
```

### Agent Workflow

```
1. User: "Make a gallery from last week's photos"
2. Agent calls: smgr ls --type photo --since 2024-01-08 --format json
3. Agent receives JSON list of photo events with hashes
4. Agent generates gallery.md with frontmatter and smgr:// references
5. Agent calls: smgr publish gallery.md
6. Agent receives URL
7. Agent: "Here's your gallery: https://..."
```

---

## Technology Choices

| Component       | Choice         | Rationale                                     |
|-----------------|----------------|-----------------------------------------------|
| Language        | Rust           | Single binary, fast, good async, good CLI libs|
| Event log       | ndjson file    | Simple, appendable, mergeable                 |
| Index           | SQLite + FTS5  | Embedded, fast, full-text search built in     |
| Blob storage    | S3-compatible  | Commodity, any provider works                 |
| Doc storage     | Git            | Already handles text well, built-in history   |
| FS watching     | notify crate   | Cross-platform (inotify/FSEvents/ReadDir)     |
| CLI framework   | clap           | Standard Rust CLI library                     |
| HTTP server     | axum           | Lightweight, async, good ergonomics           |
| Templates       | tera           | Jinja2-like, familiar syntax                  |
| Config          | TOML           | Readable, standard in Rust ecosystem          |

---

## What We're NOT Building

- **Not a database.** SQLite is a cache/index. The event log is the source of truth.
- **Not a CMS.** No admin panel, no user accounts, no WYSIWYG editor.
- **Not a sync protocol.** We use S3 and git — commodity sync.
- **Not a photo editor / note editor / etc.** We observe what other apps produce.
- **Not a backup system.** Sync ≠ backup. Use restic/borg/etc. for backups.

---

## Phasing

### Phase 1: Core Loop
- Event log (ndjson)
- FS watcher daemon (photos + notes)
- S3 blob sync
- Git document sync
- SQLite index
- CLI (`smgr add`, `smgr ls`, `smgr show`, `smgr resolve`)

### Phase 2: Render + Publish
- Template engine
- Built-in templates (gallery, note, blog)
- `smgr render` and `smgr publish`
- `smgr://` URI resolution

### Phase 3: Agent Integration
- HTTP query API (localhost)
- MCP server or Claude Code skill wrapping CLI
- Agent-driven gallery/blog/feed creation

### Phase 4: Mobile + Web
- PWA for mobile capture
- Web dashboard (read-only browse + quick add)
- Android ContentObserver integration

### Phase 5: Cross-Device Sync
- Event log sync between devices
- Conflict resolution
- Multi-device index merge
