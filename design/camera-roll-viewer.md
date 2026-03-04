# Camera Roll Viewer — First OpenClaw Skill

The simplest end-to-end exercise of the sitemgr architecture: an agent
skill that reads a device's photo library and displays what's there.

No sync. No enrichment. Just capture → event store → query → display.

---

## Why This First

The full sitemgr pipeline is: capture → event → sync → enrich → index →
query → generate → publish. That's a lot of moving parts to validate at
once. The camera roll viewer strips it down to the essential read path:

1. **Capture** — scan a photos directory (or MediaStore on Android)
2. **Event store** — insert `create` events into SQLite
3. **Query** — list photos with filters (date, count)
4. **Display** — show results in the terminal or a simple HTML page

This validates the core data model (events, content hashing, SQLite
schema) without requiring S3, LLM API keys, or any external services.
It also establishes the pattern for how OpenClaw skills wrap CLI commands.

---

## What It Does

A user says to the agent:

```
"show me my camera roll"
"show me my recent photos"
"what photos did I take this week?"
"show the last 20 photos"
```

The agent translates this to CLI calls:

```bash
# Import photos from a directory (first time / catch-up)
smgr scan ~/Photos

# Query recent photos
smgr query --type photo --limit 20 --format json

# Query photos from this week
smgr query --type photo --since 2024-01-08 --format json
```

And displays the results — file names, timestamps, thumbnails (if the
terminal supports them), or an HTML gallery served locally.

---

## Components Exercised

```
┌──────────────┐     ┌─────────────┐     ┌──────────────┐     ┌──────────┐
│  Photo Dir   │────→│  smgr scan  │────→│  Event Store │────→│  smgr    │
│  (or Media-  │     │  (capture)  │     │  (SQLite)    │     │  query   │
│   Store)     │     └─────────────┘     └──────────────┘     └────┬─────┘
└──────────────┘                                                   │
                                                                   ▼
                                                          ┌──────────────┐
                                                          │   Display    │
                                                          │  (terminal / │
                                                          │   HTML)      │
                                                          └──────────────┘
```

| Component | What's exercised | What's skipped |
|-----------|-----------------|----------------|
| Capture | Directory scan, hash computation, EXIF extraction | Android MediaStore, FS watcher |
| Event store | SQLite WAL, event schema, ULID generation | Multi-device, cross-device queries |
| Query | Filter by content_type, date range, limit/offset | FTS5 (no enrichment text yet), tags |
| Display | JSON output, terminal listing | Renderers, publish pipeline |
| Agent skill | Natural language → CLI translation | Complex multi-step workflows |

---

## CLI Surface

### `smgr scan <directory>`

Scans a directory for media files and creates `create` events for any
files not already in the event store (matched by content hash).

```bash
$ smgr scan ~/Photos
Scanning /home/user/Photos...
Found 847 files, 12 new since last scan.
Created 12 events.
```

Behavior:
- Walks the directory recursively
- Filters by known media extensions (jpg, jpeg, png, webp, heic, mp4, etc.)
- Computes SHA-256 hash for each file
- Skips files whose hash already exists in the event store (idempotent)
- Extracts basic EXIF metadata (taken_at, dimensions, camera model, GPS)
- Inserts `create` events for new files
- Respects `.gitignore`-style exclusion patterns if present

This is a batch version of `smgr add` — it adds many files at once
without enriching them. Think of it as the import step.

### `smgr query --type photo`

Already defined in the interfaces doc. The camera roll viewer uses:

```bash
# Recent photos (default sort: newest first)
smgr query --type photo --limit 20

# Photos from a date range
smgr query --type photo --since 2024-01-01 --until 2024-01-31

# All photos (paginated)
smgr query --type photo --limit 50 --offset 0
smgr query --type photo --limit 50 --offset 50
```

### `smgr show <event_id>`

Already defined. Shows full event details including local path, hash,
and metadata.

### `smgr view` (new — optional)

Opens a simple local HTML gallery in the browser. Serves thumbnails
from local blob paths.

```bash
# View recent photos in browser
smgr view --type photo --limit 50

# Starts a local server on localhost:8374, opens browser
# Shows a grid of thumbnails with metadata overlay
# Ctrl-C to stop
```

This is a convenience command, not a core primitive. The real output
is always the JSON from `smgr query`.

---

## Agent Skill Registration

In OpenClaw, skills are registered as tool definitions that the agent
can invoke. The camera roll viewer skill wraps the `smgr` CLI:

```yaml
# openclaw skill definition
name: camera-roll
description: Browse and search your photo library
commands:
  - name: scan
    command: smgr scan {directory}
    description: Import photos from a directory into the event store
    parameters:
      - name: directory
        type: string
        required: true
        description: Path to the photos directory

  - name: list-photos
    command: smgr query --type photo {flags}
    description: List photos with optional filters
    parameters:
      - name: limit
        type: integer
        default: 20
      - name: since
        type: date
        description: Only photos after this date
      - name: until
        type: date
        description: Only photos before this date

  - name: show-photo
    command: smgr show {event_id}
    description: Show details for a specific photo event
    parameters:
      - name: event_id
        type: string
        required: true

  - name: view-gallery
    command: smgr view --type photo --limit {limit}
    description: Open a local photo gallery in the browser
    parameters:
      - name: limit
        type: integer
        default: 50
```

The agent sees these as tools. When a user says "show me my recent
photos," the agent calls `list-photos` with appropriate parameters,
reads the JSON response, and formats it for the user.

---

## Conversation Examples

### Basic browsing

```
User: show me my camera roll
Agent: [calls: smgr query --type photo --limit 20 --format json]
Agent: Here are your 20 most recent photos:

  1. IMG_20240115_143207.jpg — Jan 15, 2:32 PM — 4032×3024
  2. IMG_20240115_091422.jpg — Jan 15, 9:14 AM — 4032×3024
  3. Screenshot_20240114_223015.png — Jan 14, 10:30 PM — 1080×2400
  ...

  Want me to open a gallery view, or show details for any of these?
```

### Filtered query

```
User: what photos did I take last week?
Agent: [calls: smgr query --type photo --since 2024-01-08 --until 2024-01-15 --format json]
Agent: You took 23 photos last week (Jan 8–15):

  Monday (3): Two outdoor shots, one screenshot
  Tuesday (7): Mostly workshop photos
  Wednesday (0): None
  ...

  Want me to show them as a gallery?
```

### First-time setup

```
User: I want to browse my photos
Agent: I don't see any photos in your sitemgr database yet. Where are
       your photos stored?
User: ~/Pictures
Agent: [calls: smgr scan ~/Pictures]
Agent: Found 1,247 photos in ~/Pictures. Imported 1,247 new items.
       Want to see the most recent ones?
```

---

## What This Sets Up

Once the camera roll viewer works, adding enrichment is incremental:

1. `smgr scan ~/Photos` — already done, events exist
2. `smgr enrich --pending` — sends each photo to the LLM
3. `smgr query --search "bed frame"` — now FTS works over descriptions
4. The agent can answer "find that photo of the cracked bed frame"

The camera roll viewer validates the data model, the CLI contract, and
the agent skill pattern. Enrichment, sync, and publishing layer on top
without changing any of these foundations.

---

## Implementation Plan (Prototype)

The prototype is a Python script that exercises the core loop without
the full Rust CLI. It validates the data model and flow before
committing to the Rust implementation.

### What the prototype does

1. **Scan** a local photos directory
2. **Hash** each file (SHA-256)
3. **Extract** basic EXIF metadata (using Pillow)
4. **Insert** `create` events into a SQLite database
5. **Query** events with filters
6. **Display** results in the terminal (table format)

### What it skips

- Rust / clap CLI framework
- BYO provider interfaces
- ULID generation (uses UUID for now)
- Blob storage / sync
- Enrichment
- HTML rendering / gallery view

The prototype proves the event schema works, the content-addressing is
correct, and the scan → query flow is useful. The Rust implementation
follows the same structure.
