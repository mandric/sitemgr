# System Interfaces

This document defines the concrete data structures, provider interfaces,
configuration format, and API surface for sitemgr. These are the contracts
that components talk through.

---

## 1. Event Schema

Every action in the system produces an event. Events are the atoms.

```jsonc
{
  // Unique event ID. ULID — lexicographically sortable by time.
  "id": "01HQ3K5P7Y4X2M8N6R1T0W9V3B",

  // When the event occurred (ISO 8601, UTC).
  "timestamp": "2024-01-15T14:32:07.123Z",

  // Which device created this event. Set from config at event creation time.
  // Used for provenance tracking and cross-device queries.
  "device_id": "pixel-7a",

  // What happened.
  "type": "create",  // "create" | "update" | "delete" | "sync" | "enrich" | "publish"

  // What kind of content this event concerns.
  "content_type": "photo",  // see Content Types below

  // SHA-256 hash of the content. Used as the content-addressable ID for
  // blob types (photo, video, audio). Null for document types (note,
  // document, quote, bookmark) — those are tracked by git, not by hash,
  // because they change frequently.
  // Format: "sha256:{hex}" | null
  "content_hash": "sha256:a1b2c3d4e5f6...",  // null for document types

  // Where the content lives locally. Null for remote-only events.
  "local_path": "/storage/emulated/0/DCIM/Camera/IMG_20240115_143207.jpg",

  // Where the content lives remotely. Null until synced.
  // Format depends on storage provider:
  //   S3:  "s3://{bucket}/{key}"
  //   Git: "git://{repo}/{path}"
  "remote_path": null,

  // Arbitrary metadata. Schema varies by content_type and event type.
  "metadata": {
    "title": null,
    "description": null,
    "tags": [],
    "mime_type": "image/jpeg",
    "size_bytes": 2450320,
    "source": "android-mediastore",
    "dimensions": { "width": 4032, "height": 3024 }
  },

  // For update/delete/sync/enrich: the event ID of the original create event.
  // Null for create events.
  "parent_id": null
}
```

### Event Types

| Type      | Description                                     | When                          |
|-----------|-------------------------------------------------|-------------------------------|
| `create`         | New content detected                            | User adds content (`smgr add` or app sync) |
| `update`         | Existing content modified                       | Content re-added or modified       |
| `delete`         | Content removed from local filesystem           | User deletes content or FS watcher detects removal |
| `sync`           | Content uploaded/synced to remote storage        | After blob/doc sync completes      |
| `enrich`         | LLM-generated metadata attached to content      | After enrichment completes         |
| `enrich_failed`  | Enrichment call failed (offline, error, etc.)   | Enrichment attempted but failed    |
| `publish`        | Content rendered and published to a public URL  | After publish pipeline             |

### Enrich Events

An `enrich` event is appended when the enrichment provider returns metadata
for a piece of media. It references the original `create` event via `parent_id`.

```jsonc
{
  "id": "01HQ3K7R9Z...",
  "timestamp": "2024-01-15T14:32:12.456Z",
  "type": "enrich",
  "content_type": "photo",
  "content_hash": "sha256:a1b2c3d4e5f6...",
  "local_path": null,       // enrichment doesn't change the file
  "remote_path": null,
  "metadata": {
    "source": "enrichment",
    "enrichment": {
      "provider": "anthropic",
      "model": "claude-sonnet-4-20250514",
      "description": "Broken wooden bed frame, split along the side rail near the center support. The crack runs along the grain of the wood, approximately 18 inches long. Visible screws and wood glue from a previous repair attempt.",
      "objects": ["bed frame", "wood", "crack", "screws", "wood glue"],
      "context": "furniture repair",
      "suggested_tags": ["bed-repair", "woodworking", "damage-assessment"],
      "raw_response": "..."  // full LLM output for future re-processing
    }
  },
  "parent_id": "01HQ3K5P7Y..."  // the original create event
}
```

### Enrich Failed Events

An `enrich_failed` event is appended when enrichment cannot complete — typically
because the device is offline or the provider returns an error. This marks the
item for retry when connectivity is restored.

```jsonc
{
  "id": "01HQ3K9T1B...",
  "timestamp": "2024-01-15T14:35:00.000Z",
  "type": "enrich_failed",
  "content_type": "photo",
  "content_hash": "sha256:c3d4e5f6a7b8...",
  "local_path": null,
  "remote_path": null,
  "metadata": {
    "source": "enrichment",
    "error": "network_unreachable",
    "provider": "anthropic",
    "attempts": 1
  },
  "parent_id": "01HQ3K8M2A..."  // the original create event
}
```

On reconnect, the enrichment process queries the index for `create` events
with no corresponding `enrich` event and re-queues them.

### Delete Events

A `delete` event is emitted when content is removed — either explicitly
via the CLI or detected by a file system watcher. It references the
original `create` event via `parent_id` and carries the same
`content_hash`.

```jsonc
{
  "id": "01HQ5N8R2A...",
  "timestamp": "2024-01-16T09:12:44.000Z",
  "type": "delete",
  "content_type": "photo",
  "content_hash": "sha256:a1b2c3d4e5f6...",
  "local_path": null,         // file is gone
  "remote_path": null,
  "metadata": {
    "source": "android-mediastore"
  },
  "parent_id": "01HQ3K5P7Y..."  // the original create event
}
```

**Remote blob deletion rule:** The sync layer queries the index for any
other event that shares the same `content_hash`. If none exist, the
remote blob is deleted. If the hash is still referenced, the blob stays.

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

**Blob types** (photo, video, audio) sync to the storage provider and are
candidates for auto-enrichment. Blobs are content-addressed by SHA-256 hash.

**Document types** (note, document, quote, bookmark) sync to Git as `.md` files.
Documents are **not** content-hashed — they change frequently and git already
tracks their identity and history. The git repo mirrors the local filesystem.
Documents are committed and pushed frequently (on every save / background event)
and pulled on foreground / device switch. Sync requires an internet connection;
offline edits are committed locally and pushed when connectivity resumes.

### Content-Addressable URI Scheme

References in markdown use a custom URI scheme so they resolve correctly
in any rendering context:

```
smgr://sha256:a1b2c3d4e5f6...
```

Renderers resolve this to:
- **Local context:** `~/.sitemgr/blobs/a1/a1b2c3d4e5f6...jpg`
- **Web context:** `https://bucket.s3.amazonaws.com/sync/a1/a1b2c3d4e5f6...jpg`

---

## 2. Provider Interfaces

The three BYO contracts. Each is a trait/interface that can be swapped by
changing configuration.

### 2.1 Storage Provider

Stores and retrieves blobs by content hash.

```
trait StorageProvider {
    /// Upload a blob. Returns the remote path/URL.
    fn put(hash: ContentHash, bytes: &[u8], ext: &str) -> RemotePath;

    /// Download a blob by hash.
    fn get(hash: ContentHash) -> Vec<u8>;

    /// Check if a blob exists in remote storage.
    fn exists(hash: ContentHash) -> bool;

    /// Delete a blob from remote storage.
    fn delete(hash: ContentHash) -> void;

    /// Get the public URL for a blob (for rendering/publishing).
    fn url(hash: ContentHash, ext: &str) -> Url;
}
```

**Implementations:**

| Provider  | Config key   | Notes                                    |
|-----------|-------------|------------------------------------------|
| S3        | `"s3"`      | Any S3-compatible: AWS, MinIO, etc.      |
| R2        | `"r2"`      | Cloudflare R2 (S3-compatible, no egress) |
| GCS       | `"gcs"`     | Google Cloud Storage                     |
| Local     | `"local"`   | `./blobs/` directory, works offline      |

### 2.2 Enrichment Provider

Sends media to an LLM. Gets structured metadata back.

```
trait EnrichmentProvider {
    /// Enrich a single media item.
    fn enrich(
        media: &[u8],
        mime_type: &str,
    ) -> EnrichmentResult;

    /// Enrich a batch of media items (optional — falls back to
    /// sequential single calls if not implemented).
    fn enrich_batch(
        items: Vec<(ContentHash, &[u8], &str)>,
    ) -> Vec<EnrichmentResult>;
}

struct EnrichmentResult {
    /// Human-readable description of the media content.
    description: String,

    /// Objects, subjects, or elements detected in the media.
    objects: Vec<String>,

    /// Inferred context or activity (e.g., "furniture repair",
    /// "cooking", "hiking").
    context: String,

    /// Tags suggested by the LLM for categorization.
    suggested_tags: Vec<String>,

    /// The full raw LLM response. Preserved for future re-processing
    /// if the structured extraction schema changes.
    raw_response: String,

    /// Provider and model that produced this result.
    provider: String,
    model: String,
}
```

**Implementations:**

| Provider   | Config key     | Notes                                |
|------------|---------------|--------------------------------------|
| Anthropic  | `"anthropic"` | Claude with vision                   |
| OpenAI     | `"openai"`    | GPT-4o with vision                   |
| Google     | `"google"`    | Gemini with vision                   |
| Ollama     | `"ollama"`    | Local models (LLaVA, etc.)           |

**Prompt structure:** The enrichment provider sends a system prompt that
asks for structured JSON output:

```
Analyze this image and return a JSON object with:
- description: A detailed description of what you see (2-3 sentences)
- objects: A list of notable objects, subjects, or elements
- context: The likely activity or context (e.g., "furniture repair", "travel")
- suggested_tags: 3-5 short tags for categorization

Be specific and concrete. Describe what you actually see, not what you
think the user might want to hear.
```

**Content-type-aware prompting (future).** The default prompt above works
well for photos of physical scenes and objects. For other media types
(screenshots, receipts, diagrams, documents), a specialized prompt may
produce better metadata — e.g., extracting text content from screenshots,
structured fields from receipts (vendor, amount, date), or conceptual
descriptions from diagrams. The `EnrichmentResult` schema is intentionally
flexible enough to accommodate this: `objects` can hold UI elements or line
items, `context` can describe a transaction or a workflow. Prompt
specialization by content type is an optimization, not a schema change.

### 2.3 Query Provider

Abstracts the index backend. All consumers (agent, CLI, future UI) go
through this interface.

```
trait QueryProvider {
    /// Query events matching a filter. Returns matching events with
    /// their enrichment data (if any) joined in.
    fn query(filter: QueryFilter) -> QueryResult;

    /// Get a single event by ID, with related events (sync, enrich)
    /// joined in.
    fn get(event_id: EventId) -> Option<EventWithRelated>;

    /// Get events related to a content hash (all events that reference
    /// this content).
    fn by_hash(hash: ContentHash) -> Vec<Event>;

    /// Resolve a content hash to local and remote paths.
    fn resolve(hash: ContentHash) -> Option<ResolvedPaths>;

    /// Rebuild derived indexes (FTS, tags) from the events table.
    fn rebuild() -> void;
}

struct QueryFilter {
    content_type: Option<String>,    // "photo", "video", "note", etc.
    tags: Vec<String>,               // match any of these tags
    search: Option<String>,          // full-text search query
    since: Option<DateTime>,         // events after this time
    until: Option<DateTime>,         // events before this time
    event_type: Option<String>,      // "create", "enrich", "sync", etc.
    device_id: Option<String>,       // filter by originating device
    limit: u32,                      // max results (default 20)
    offset: u32,                     // pagination offset
}

struct QueryResult {
    events: Vec<EventWithRelated>,
    total: u64,
    limit: u32,
    offset: u32,
}

/// An event with its related events (sync status, enrichment data)
/// joined in for convenience. This is what consumers actually work with.
struct EventWithRelated {
    event: Event,                            // the create event
    sync: Option<Event>,                     // the sync event (if synced)
    enrichment: Option<EnrichmentResult>,    // the enrichment data (if enriched)
    remote_url: Option<Url>,                 // resolved remote URL
}
```

**Implementations:**

| Provider | Config key   | Notes                                    |
|----------|-------------|------------------------------------------|
| Postgres | `"postgres"`| **v1 default.** tsvector + GIN for FTS.  |
| SQLite   | `"sqlite"`  | Backlog. FTS5 for local-first.           |
| Tantivy  | `"tantivy"` | Backlog. Rust search engine.             |

**Key design point:** The `EventWithRelated` struct joins across event types.
When you query for photos, you don't get raw `create` events — you get
events enriched with their sync status and LLM-generated metadata. This is
what the agent and CLI consume. They never need to manually join `create`
and `enrich` events.

---

## 3. Configuration

### v1: Environment Variables

All configuration via environment variables (12-factor). See
`design/architecture.md` for the full list. Key variables:

```bash
SUPABASE_URL, SUPABASE_SECRET_KEY  # Postgres + Storage
SMGR_S3_BUCKET, SMGR_S3_PREFIX          # Where media lives
ANTHROPIC_API_KEY                         # Enrichment
TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN    # WhatsApp bot
```

### Future: Desktop CLI config (backlog)

```toml
device_id = "thinkpad-x1"
device_name = "Milan's ThinkPad"
events_db = "~/.sitemgr/events.db"

[storage]
provider = "s3"
bucket = "my-site-assets"

[enrichment]
provider = "anthropic"
model = "claude-sonnet-4-20250514"
auto_enrich = true
```

---

## 4. CLI Interface

The CLI is the primary desktop interface and the surface the agent calls.
Binary name: `smgr`. All query commands output JSON by default (agent-friendly).

### Query Operations (via Query Provider)

```
# Query events — goes through the query provider interface
smgr query                                   # Recent events (default: last 20)
smgr query --type photo                      # Filter by content type
smgr query --tags bed-repair                 # Filter by tag (from enrichment)
smgr query --tags bed-repair --type photo    # Combine filters
smgr query --since 2024-01-01               # Filter by date
smgr query --search "cracked bed frame"     # Full-text search (searches enrichment descriptions)
smgr query --device pixel-7a                 # Filter by device
smgr query --limit 50                        # Pagination
smgr query --format table                    # Human-readable table output

# Show details for a specific event (with related sync/enrich events)
smgr show <event_id>

# Get paths for content
smgr resolve <content_hash>                  # Print local and remote paths
smgr resolve --local <content_hash>          # Print only local path
smgr resolve --remote <content_hash>         # Print only remote URL
```

### Content Operations

```
# Add content
smgr add <file>                              # Auto-detect content type
smgr add --type photo <file>                 # Explicit type
smgr add --type bookmark --url <url>         # Create a bookmark
smgr add --type quote --text "..." --author "..." --source <url>
smgr add --type note --title "..." --tags tag1,tag2  # Opens $EDITOR for body
smgr add --enrich <file>                     # Add and immediately enrich
```

### Enrichment Operations

```
# Manually trigger enrichment for a specific event/hash
smgr enrich <event_id>
smgr enrich <content_hash>

# Re-enrich (e.g., after switching to a better model)
smgr enrich --force <event_id>

# Enrich all un-enriched media
smgr enrich --pending

# Show enrichment status
smgr enrich --status
```

### Sync Operations

```
smgr sync status                             # Show sync queue and status
smgr sync push                               # Force push pending items now
smgr sync push --content-hash <hash>         # Push a specific item
```

### Render + Publish Operations

```
smgr render <markdown-file>                  # Output HTML to stdout
smgr render <markdown-file> --output ./out.html
smgr publish <markdown-file>                 # Render → upload → return URL
smgr publish <markdown-file> --private       # Non-guessable URL
```

### Index Operations

```
smgr index rebuild                           # Rebuild FTS and derived indexes from events table
smgr index stats                             # Show event store statistics
```

---

## 5. Query API (HTTP)

A lightweight HTTP API for programmatic access. Runs on localhost. Backed
by the same query provider interface as the CLI.

### `GET /api/events`

Query events. All parameters map to `QueryFilter` fields.

**Query Parameters:**

| Param          | Type     | Description                          |
|----------------|----------|--------------------------------------|
| `content_type` | string   | Filter by content type               |
| `tag`          | string   | Filter by tag (repeatable)           |
| `search`       | string   | Full-text search query               |
| `since`        | ISO 8601 | Events after this timestamp          |
| `until`        | ISO 8601 | Events before this timestamp         |
| `type`         | string   | Filter by event type                 |
| `device_id`    | string   | Filter by originating device         |
| `limit`        | int      | Max results (default 20, max 100)    |
| `offset`       | int      | Pagination offset                    |

**Response:**

```jsonc
{
  "events": [
    {
      "event": {
        "id": "01HQ3K5P7Y...",
        "timestamp": "2024-01-15T14:32:07.123Z",
        "device_id": "pixel-7a",
        "type": "create",
        "content_type": "photo",
        "content_hash": "sha256:a1b2c3d4...",
        "local_path": "/storage/emulated/0/DCIM/Camera/IMG_20240115.jpg",
        "remote_path": "s3://bucket/sync/a1/a1b2c3d4...jpg",
        "metadata": { ... }
      },
      "enrichment": {
        "description": "Broken wooden bed frame, split along the side rail...",
        "objects": ["bed frame", "wood", "crack", "screws"],
        "context": "furniture repair",
        "suggested_tags": ["bed-repair", "woodworking"],
        "provider": "anthropic",
        "model": "claude-sonnet-4-20250514"
      },
      "remote_url": "https://bucket.s3.amazonaws.com/sync/a1/a1b2c3d4...jpg"
    }
    // ...
  ],
  "total": 142,
  "limit": 20,
  "offset": 0
}
```

Note: responses return `EventWithRelated` — the create event joined with
its enrichment data and resolved URLs. Consumers never need to manually
correlate create and enrich events.

### `GET /api/events/:id`

Get a single event by ID (with related events joined).

### `POST /api/events`

Create a new event (used by web app / mobile to add notes, bookmarks, etc.)

### `POST /api/blobs`

Upload a binary blob (photo, video, audio). Multipart form data.
Triggers enrichment if `auto_enrich` is enabled.

### `GET /api/resolve/:content_hash`

Resolve a content hash to paths.

### `POST /api/enrich/:event_id`

Manually trigger enrichment for a specific event.

### `GET /api/stats`

Index statistics.

```jsonc
{
  "total_events": 4521,
  "enriched_events": 3100,
  "pending_enrichment": 100,
  "by_content_type": {
    "photo": 3200,
    "note": 800,
    "bookmark": 400,
    "document": 100,
    "quote": 21
  },
  "by_type": {
    "create": 2500,
    "enrich": 3100,
    "sync": 2000,
    "update": 15,
    "delete": 6
  },
  "storage": {
    "local_blobs_bytes": 5368709120,
    "events_db_bytes": 2097152
  },
  "device_id": "pixel-7a"
}
```

---

## 6. Renderer Interface

Renderers are pure functions: `(query_result, template, resolve_fn) → output`.

```
trait Renderer {
    /// Render a set of events into an output format.
    fn render(
        events: Vec<EventWithRelated>,
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

Note: renderers receive `EventWithRelated`, which includes enrichment data.
Templates can use enrichment descriptions as alt text, captions, or
narrative content in blog posts.

---

## 7. Multi-Device Access (v1)

v1 uses a single shared Supabase Postgres database. All devices write to
and read from the same instance — no sync protocol needed.

Every event carries a `device_id` field for provenance. You always know
where content originated.

### v1 Model: Shared Postgres

```
Phone:    → writes to Supabase Postgres  (device_id: "pixel-7a")
Laptop:   → writes to Supabase Postgres  (device_id: "thinkpad-x1")
WhatsApp: → queries Supabase Postgres    (via Edge Function)
```

Cross-device queries are just regular `SELECT` statements with optional
`WHERE device_id = ?` filtering.

### Future: Local-First with SQLite (backlog)

The original per-device SQLite design is preserved in the event model.
If we move to local-first in a future version, each device would maintain
its own `events.db` with `ATTACH DATABASE` for cross-device reads, and
S3 database export for sharing snapshots. The append-only event model
and `device_id` provenance make this transition tractable.

---

## 8. Directory Layout

### v1: Supabase-hosted

```
supabase/
├── config.toml                          # Supabase project config
├── migrations/
│   └── 20260305000000_initial_schema.sql  # Postgres schema
└── functions/
    └── whatsapp/
        └── index.ts                     # Edge Function entry point
```

Configuration is via environment variables (see architecture.md).

### Future: Local CLI layout (backlog)

```
~/.sitemgr/
├── config.toml          # Configuration (device_id, storage, enrichment, watchers)
├── events.db            # SQLite event store (WAL mode)
├── blobs/               # Local blob cache (content-addressed)
├── templates/           # HTML templates for renderers
└── daemon.pid           # PID file when daemon is running
```
