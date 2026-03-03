# System Interfaces

This document defines the concrete data structures, configuration format,
and API surface for sitemgr. These are the contracts that components
talk through.

---

## 1. Event Schema

Every action in the system produces an event. Events are the atoms.

```jsonc
{
  // Unique event ID. ULID — lexicographically sortable by time.
  "id": "01HQ3K5P7Y4X2M8N6R1T0W9V3B",

  // When the event occurred (ISO 8601, UTC).
  "timestamp": "2024-01-15T14:32:07.123Z",

  // What happened.
  "type": "create",  // "create" | "update" | "delete" | "sync" | "publish"

  // What kind of content this event concerns.
  "content_type": "photo",  // see Content Types below

  // SHA-256 hash of the content. This is the content-addressable ID.
  // Format: "sha256:{hex}"
  "content_hash": "sha256:a1b2c3d4e5f6...",

  // Where the content lives locally. Null for remote-only events.
  "local_path": "/Users/me/Screenshots/screen-2024-01-15.png",

  // Where the content lives remotely. Null until synced.
  // Format depends on sync target:
  //   S3:  "s3://{bucket}/{key}"
  //   Git: "git://{repo}/{path}"
  "remote_path": null,

  // Arbitrary metadata. Schema varies by content_type (see below).
  "metadata": {
    "title": null,
    "description": null,
    "tags": [],
    "mime_type": "image/png",
    "size_bytes": 245032,
    "source": "fs-watcher",
    "dimensions": { "width": 1920, "height": 1080 }
  },

  // For update/delete: the event ID of the original create event.
  // Null for create events.
  "parent_id": null
}
```

### Delete Events

A `delete` event is emitted by the FS watcher when a file is removed from
the filesystem. It references the original `create` event via `parent_id`
and carries the same `content_hash`. Delete events are never triggered
manually — users delete files normally, and the daemon observes the change.

The sync layer propagates the deletion to the remote target (S3 or git),
using the content hash to decide whether to delete the remote blob:

```jsonc
{
  "id": "01HQ5N8R2A...",
  "timestamp": "2024-01-16T09:12:44.000Z",
  "type": "delete",
  "content_type": "photo",
  "content_hash": "sha256:a1b2c3d4e5f6...",
  "local_path": null,         // file is gone
  "remote_path": null,        // filled after sync deletes remote copy (or left null if blob is still referenced)
  "metadata": {
    "source": "fs-watcher"
  },
  "parent_id": "01HQ3K5P7Y..."  // the original create event
}
```

**Remote blob deletion rule:** The sync layer queries the index for any
other event that shares the same `content_hash`. If none exist, the
remote blob is deleted. If the hash is still referenced (e.g. the same
photo was captured from two sources), the blob stays. This is the only
safe behavior for content-addressed storage — delete the pointer, only
delete the data when no pointers remain.

### Content Types

| Type         | Description                        | Sync Target | Metadata Fields                          |
|--------------|------------------------------------|-------------|------------------------------------------|
| `photo`      | Image file (png, jpg, webp, etc.)  | S3          | mime_type, dimensions, size_bytes, geo    |
| `video`      | Video file                         | S3          | mime_type, dimensions, duration, size_bytes |
| `audio`      | Audio file                         | S3          | mime_type, duration, size_bytes           |
| `note`       | Short markdown note                | Git         | title, tags                              |
| `document`   | Long-form markdown                 | Git         | title, tags                              |
| `quote`      | A text excerpt with attribution    | Git         | title, tags, source_url, author          |
| `bookmark`   | A URL with optional description    | Git         | url, title, description, tags            |
| `gallery`    | A published collection (output)    | S3          | title, item_hashes, template             |

**Blob types** (photo, video, audio) sync to S3.
**Document types** (note, document, quote, bookmark) sync to Git as `.md` files.

### Content-Addressable URI Scheme

References in markdown use a custom URI scheme so they resolve correctly
in any rendering context:

```
smgr://sha256:a1b2c3d4e5f6...
```

Renderers resolve this to:
- **Local context:** `/Users/me/.sitemgr/blobs/a1/a1b2c3d4e5f6...jpg`
- **Web context:** `https://bucket.s3.amazonaws.com/sync/a1/a1b2c3d4e5f6...jpg`

This means a markdown note like:

```markdown
# Paris Trip

![Eiffel Tower](smgr://sha256:a1b2c3d4...)

Great day in Paris. See also [full album](smgr://sha256:f7e8d9c0...).
```

...works on your laptop AND on the published web page without editing.

---

## 2. Sync Daemon Configuration

Configuration lives at `~/.sitemgr/config.toml`.

```toml
# Where the event log is stored
event_log = "~/.sitemgr/events.ndjson"

# Where the local index (SQLite) is stored
index_db = "~/.sitemgr/index.db"

# Where synced blobs are cached locally (content-addressed)
blob_store = "~/.sitemgr/blobs"

# --- Watchers ---
# Each watcher monitors a directory and emits events for matching files.

[[watcher]]
path = "~/Screenshots"
content_type = "photo"
patterns = ["*.png", "*.jpg", "*.jpeg", "*.webp"]
sync_target = "s3"
# Only watch for new files (don't re-process existing on startup)
watch_mode = "new"  # "new" | "all"

[[watcher]]
path = "~/Pictures/Camera Roll"
content_type = "photo"
patterns = ["*.jpg", "*.jpeg", "*.heic", "*.png"]
sync_target = "s3"
watch_mode = "new"
# Optional: disable this watcher without removing it
enabled = true

[[watcher]]
path = "~/notes"
content_type = "note"
patterns = ["*.md"]
sync_target = "git"
watch_mode = "all"
# For git-synced dirs: parse front matter for title/tags
parse_frontmatter = true

[[watcher]]
path = "~/documents"
content_type = "document"
patterns = ["*.md"]
sync_target = "git"
watch_mode = "all"
parse_frontmatter = true

# --- Sync Targets ---

[targets.s3]
endpoint = "https://s3.us-east-1.amazonaws.com"
bucket = "my-sync-data"
prefix = "sync/"
region = "us-east-1"
# Credentials come from env vars or AWS credential chain:
#   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
#   or ~/.aws/credentials

[targets.git]
# The git remote for document sync
remote = "git@github.com:user/notes.git"
branch = "main"
# How often to push (batches commits)
push_interval = "5m"
# Commit message template. {event_id} and {file} are interpolated.
commit_message = "sync: {file} [{event_id}]"
```

### Frontmatter Convention

Markdown files can include YAML frontmatter that the system parses into
event metadata:

```markdown
---
title: Paris Trip Notes
tags: [travel, paris, 2024]
date: 2024-01-15
---

# Paris Trip Notes

Arrived at Gare du Nord at 10am...
```

---

## 3. CLI Interface

The CLI is the primary interface for v0, and the surface the agent calls.
Binary name: `smgr`. All query commands support `--format json` for
machine-readable output (which is what the agent uses).

### Daemon Control

The daemon is the background process that watches the filesystem and syncs
content. It's bundled in the same `smgr` binary — not a separate install.

```
smgr daemon start           # Start in background (forks, writes PID file)
smgr daemon stop            # Stop the daemon
smgr daemon status          # Show status, active watchers, sync queue
smgr daemon install         # Install as system service (launchd on macOS, systemd on Linux)
smgr daemon uninstall       # Remove the system service

# On macOS, `smgr daemon install` creates a launchd plist at:
#   ~/Library/LaunchAgents/com.smgr.daemon.plist
# On Linux, it creates a systemd user unit at:
#   ~/.config/systemd/user/smgr.service
#
# Either way, the daemon starts automatically on login.
```

### Content Operations

```
# Add content explicitly (bypasses fs watcher)
smgr add <file>                         # Auto-detect content type
smgr add --type photo <file>            # Explicit type
smgr add --type bookmark --url <url>    # Create a bookmark
smgr add --type quote --text "..." --author "..." --source <url>
smgr add --type note --title "..." --tags tag1,tag2  # Opens $EDITOR for body

# List / query events
smgr ls                                 # Recent events (default: last 20)
smgr ls --type photo                    # Filter by content type
smgr ls --tag travel                    # Filter by tag
smgr ls --since 2024-01-01             # Filter by date
smgr ls --search "paris"               # Full-text search
smgr ls --format json                   # Output as JSON
smgr ls --format table                  # Output as table (default)

# Show details for a specific event or content hash
smgr show <event_id>
smgr show <content_hash>

# Get paths for content
smgr resolve <content_hash>             # Print local and remote paths
smgr resolve --local <content_hash>     # Print only local path
smgr resolve --remote <content_hash>    # Print only remote URL
```

### Sync Operations

```
smgr sync status                        # Show sync queue and status
smgr sync push                          # Force push pending items now
smgr sync push --content-hash <hash>    # Push a specific item
```

### Render Operations

```
# Render a markdown file (with typed frontmatter) to HTML
smgr render <markdown-file>                     # Output to stdout
smgr render <markdown-file> --output ./out.html # Output to file
smgr render <markdown-file> --context web       # Resolve smgr:// → S3 URLs (default)
smgr render <markdown-file> --context local     # Resolve smgr:// → local paths

# The frontmatter `type` field determines the HTML template:
#   type: gallery  → photo grid with lightbox
#   type: note     → clean reading layout
#   type: blog     → article layout with date/tags
#   type: quote    → styled card with attribution
#   type: bookmarks → categorized link list
```

### Publish Operations

```
# Render and upload in one step
smgr publish <markdown-file>                    # Render → upload → return URL
smgr publish <markdown-file> --private          # Generate a non-guessable URL
smgr publish <markdown-file> --output ./out.html # Also save local copy

# Publish a pre-rendered HTML file
smgr publish --html <html-file>

# Publish a feed (Atom/RSS) of recent notes
smgr publish feed --type note --limit 20 --output ./feed.xml
```

### Export (SSG Integration)

```
# Export content for use with a static site generator (e.g., Zola, Hugo)
smgr export --type note --format zola --output ./content/
smgr export --type note,document --format hugo --output ./content/

# This:
# 1. Copies markdown files to the output directory
# 2. Rewrites smgr:// URIs to relative paths
# 3. Copies/links referenced blobs into a static/ directory
# 4. Adjusts frontmatter to match the SSG's expected format
```

### Index Operations

```
smgr index rebuild                      # Rebuild index from event log
smgr index stats                        # Show index statistics
```

---

## 4. Query API (HTTP)

A lightweight HTTP API served by the daemon for the web app and
programmatic access. Runs on localhost by default.

### `GET /api/events`

Query the event log / index.

**Query Parameters:**

| Param          | Type     | Description                          |
|----------------|----------|--------------------------------------|
| `content_type` | string   | Filter by content type               |
| `tag`          | string   | Filter by tag (repeatable)           |
| `search`       | string   | Full-text search query               |
| `since`        | ISO 8601 | Events after this timestamp          |
| `until`        | ISO 8601 | Events before this timestamp         |
| `type`         | string   | Filter by event type                 |
| `limit`        | int      | Max results (default 20, max 100)    |
| `offset`       | int      | Pagination offset                    |

**Response:**

```jsonc
{
  "events": [
    {
      "id": "01HQ3K5P7Y...",
      "timestamp": "2024-01-15T14:32:07.123Z",
      "type": "create",
      "content_type": "photo",
      "content_hash": "sha256:a1b2c3d4...",
      "local_path": "/Users/me/Screenshots/screen.png",
      "remote_path": "s3://bucket/sync/a1/a1b2c3d4...png",
      "metadata": { ... }
    }
    // ...
  ],
  "total": 142,
  "limit": 20,
  "offset": 0
}
```

### `GET /api/events/:id`

Get a single event by ID.

### `POST /api/events`

Create a new event (used by the web app to add notes, bookmarks, etc.)

**Request Body:**

```jsonc
{
  "content_type": "note",
  "metadata": {
    "title": "Quick thought",
    "tags": ["idea"],
  },
  // For notes/documents: the markdown body
  "body": "# Quick thought\n\nThis is an idea I had...",
  // For bookmarks: the URL
  "url": null,
  // For blobs: multipart upload (separate endpoint, see below)
}
```

**Response:** The created event.

### `POST /api/blobs`

Upload a binary blob (photo, video, audio). Multipart form data.

**Response:**

```jsonc
{
  "content_hash": "sha256:a1b2c3d4...",
  "event": { ... }  // The created event
}
```

### `GET /api/resolve/:content_hash`

Resolve a content hash to paths.

**Response:**

```jsonc
{
  "content_hash": "sha256:a1b2c3d4...",
  "local_path": "/Users/me/.sitemgr/blobs/a1/a1b2c3d4...jpg",
  "remote_url": "https://bucket.s3.amazonaws.com/sync/a1/a1b2c3d4...jpg",
  "content_type": "photo",
  "mime_type": "image/jpeg"
}
```

### `GET /api/stats`

Index statistics.

```jsonc
{
  "total_events": 4521,
  "by_content_type": {
    "photo": 3200,
    "note": 800,
    "bookmark": 400,
    "document": 100,
    "quote": 21
  },
  "by_type": {
    "create": 2500,
    "sync": 2000,
    "update": 15,
    "delete": 6
  },
  "storage": {
    "local_blobs_bytes": 5368709120,
    "events_log_bytes": 2097152
  }
}
```

---

## 5. Renderer Interface

Renderers are pure functions: `(query_result, template, resolve_fn) → output`.

```
trait Renderer {
    /// Render a set of events into an output format.
    fn render(
        events: Vec<Event>,
        template: Template,
        resolver: impl Fn(ContentHash) -> ResolvedPaths,
    ) -> Output;
}

struct ResolvedPaths {
    local_path: Option<PathBuf>,
    remote_url: Option<Url>,
}

enum Output {
    Html(String),
    Json(String),
    Markdown(String),
    Atom(String),
}
```

The `resolver` function is what makes the same template work locally and
on the web. In a local context, it returns file:// paths. In a publish
context, it returns S3 URLs.

---

## 6. Event Log Sync (Between Devices)

For v0, the event log is local-only. But the design should accommodate
future cross-device sync. Two options:

### Option A: Log as Git-Synced File

The event log itself is a file in the git repo. Each device appends to it
and git merges are line-based (ndjson is line-oriented). Conflicts are
unlikely since events have unique IDs and are append-only.

**Pro:** No new infrastructure. **Con:** Git isn't great for high-frequency
appends.

### Option B: Log Segments on S3

The log is split into segments (one file per day or per N events). Segments
are uploaded to S3. Each device reads segments it hasn't seen.

```
s3://bucket/log/2024-01-15.ndjson
s3://bucket/log/2024-01-16.ndjson
```

**Pro:** Scales better. **Con:** Need merge logic for concurrent writers.

### Recommendation

Start with **Option A** for simplicity. Move to **Option B** when the log
grows large or when more than 2 devices are in play.

---

## 7. Directory Layout

```
~/.sitemgr/
├── config.toml          # Daemon configuration
├── events.ndjson        # The append-only event log
├── index.db             # SQLite index (derived, rebuildable)
├── blobs/               # Local blob cache (content-addressed)
│   ├── a1/
│   │   └── a1b2c3d4...jpg
│   ├── e5/
│   │   └── e5f6a7b8...png
│   └── ...
├── templates/           # HTML templates for renderers
│   ├── gallery.html
│   ├── note.html
│   └── feed.xml
└── daemon.pid           # PID file when daemon is running
```
