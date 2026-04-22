# 24-import-plan-confirm — Spec

## Overview

Two-phase import: plan then execute. Before importing objects from an S3 bucket, show the user what will happen and let them confirm. Expose import as an agent tool so the chat interface can trigger imports with built-in confirmation.

## Problem

`sitemgr import <bucket>` currently scans the bucket and writes events in one shot. For a bucket with 500k objects this means a long wait with no preview, no ability to scope down, and no confirmation before committing hundreds of thousands of database rows. The agent chat has no import capability at all.

## Current Behavior

- CLI: `sitemgr import <bucket>` → scan → insert → done (single API call)
- CLI: `sitemgr import <bucket> --dry-run` → scan → print counts → done (separate invocation, user must remember the flag)
- API: `POST /api/buckets/{id}/import` with `dry_run: true|false`
- Agent: no import tool
- `listS3Objects()` loads all objects into memory (capped at 1M via MAX_PAGES)
- `scanBucket()` loads all events into memory for diffing

## Design

### Two-Phase Import

**Phase 1 — Plan:** Scan the bucket, compute the diff, and persist the plan as an event (`op: "import:plan"`). The plan event includes enough information for the user to decide whether to proceed, scope down with `--prefix`, or abort.

**Phase 2 — Execute:** User confirms by referencing the plan event's ID. The execute phase reads the plan event, verifies it's recent enough (10-minute window), and imports the untracked objects. If the plan has expired, the user re-plans.

### Plans as Events

Import plans are stored as events in the existing `events` table. This gives us:
- **Persistence** — plans survive server restarts, agent context compaction
- **Audit trail** — when was each bucket scanned, what was found, was it executed
- **No new table** — no migration, no in-memory cache with TTL
- **Consistency** — same append-only log pattern used throughout the system

A plan event:
```
id:              <uuid>
timestamp:       <now>
device_id:       "api" | "cli"
op:              "import:plan"
content_type:    null
content_hash:    null
local_path:      null
remote_path:     null
bucket_config_id: <bucket uuid>
user_id:         <user uuid>
metadata: {
  source:              "import-plan",
  prefix:              "photos/2024/",
  total_objects:       142308,
  synced:              130000,
  untracked:           12308,
  modified:            0,
  untracked_by_type:   { "photo": 11200, "video": 980, "document": 128 },
  untracked_total_bytes: 51781427200,
  truncated:           false,
  warning:             null,
  expires_at:          "2026-04-09T12:10:00Z"
}
```

When import executes, the resulting `s3:put` events use `parent_id` pointing to the plan event — linking the plan to its execution.

An expired plan is just an old event — no cleanup needed. The `expires_at` is in metadata, checked at execute time.

### API Changes

**New endpoint:** `POST /api/buckets/{id}/import/plan`

Request body:
```json
{ "prefix": "photos/2024/" }
```

Response: the plan event (standard event shape with metadata containing the summary).

**Modify existing:** `POST /api/buckets/{id}/import`

Add optional `plan_id` field. If provided, looks up the plan event, verifies it's not expired, and re-scans with the same prefix. If expired or not found, returns an error (user must re-plan).

```json
{
  "plan_id": "abc-123",
  "prefix": "photos/2024/",
  "batch_size": 500,
  "concurrency": 3
}
```

The `dry_run` flag is **removed** — its purpose is replaced by the plan endpoint.

### CLI Changes

**Default behavior becomes two-phase:**

```
$ sitemgr import my-bucket

Scanning "my-bucket"...

Import plan for "my-bucket":
  Total objects: 142,308
  Already tracked: 130,000
  New (untracked): 12,308
    photo: 11,200
    video: 980
    document: 128
  Modified (skipped): 0
  Size: 48.2 GB

Proceed with import? [y/N] _
```

User types `y` → execute. User types `n` or Ctrl-C → abort.

**Flags:**
- `--yes` / `-y` — skip confirmation (for scripts/CI)
- `--prefix P` — scope to prefix (unchanged)
- `--plan-only` — print plan and exit (replaces `--dry-run`)
- `--concurrency N` / `--batch-size N` — unchanged
- `--format json` — print plan as JSON and exit (non-interactive, implies `--plan-only` unless combined with `--yes`)

**Deprecate `--dry-run`:** Keep it working as an alias for `--plan-only` but don't document it.

### Agent Tool

New tool: `import_bucket`

```typescript
{
  name: "import_bucket",
  description:
    "Import untracked S3 objects into the user's media library. " +
    "Always starts with a plan showing what will be imported. " +
    "The user must confirm before the actual import executes. " +
    "Use this when the user asks to import, ingest, or add objects from their bucket.",
  input_schema: {
    type: "object",
    properties: {
      bucket: {
        type: "string",
        description: "Bucket name to import from.",
      },
      prefix: {
        type: "string",
        description: "Optional key prefix to scope the import.",
      },
      confirm_plan_id: {
        type: "string",
        description:
          "If provided, executes a previously generated plan. " +
          "Omit this on first call to get the plan. " +
          "Include it after the user confirms to execute.",
      },
    },
    required: ["bucket"],
  },
}
```

**Agent flow:**
1. User: "import my photos bucket"
2. Agent calls `import_bucket({ bucket: "my-photos" })` — no `confirm_plan_id`
3. Tool returns the plan summary as JSON
4. Agent presents: "I found 12,308 new objects (11,200 photos, 980 videos, 128 documents, ~48 GB). Want me to go ahead?"
5. User: "yes"
6. Agent calls `import_bucket({ bucket: "my-photos", confirm_plan_id: "abc-123" })`
7. Tool returns import result
8. Agent presents: "Done — imported 12,308 objects. They're now available for search and enrichment."

This is a natural two-turn tool-use pattern. The agent never auto-executes — it always presents the plan and waits for user confirmation.

### Scale Handling

**Current hard limit:** 1M objects (MAX_PAGES = 1000, 1000 keys/page). This is a sensible safety cap but should be surfaced, not hidden.

**Plan-phase behavior when truncated:**
- `listS3Objects()` already throws at MAX_PAGES. Change it to return a `truncated: boolean` flag instead of throwing.
- The plan surfaces the truncation: `warning: "Listing stopped at 1,000,000 objects. Use --prefix to scope the import to a subset."`
- The user can then re-run with `--prefix photos/2024/` to work through the bucket in chunks.

**Memory considerations:**
- 1M `ScanObjectEntry` objects (~200 bytes each) ≈ 200 MB. Acceptable for a server-side operation.
- The event-side query is already paginated (SCAN_EVENTS_PAGE_SIZE = 1000).
- No change to the fundamental approach — streaming the S3 listing would add complexity without clear benefit at the 1M scale. If buckets larger than 1M become common, a future spec can introduce cursor-based pagination with server-side state.

**Execution-phase behavior at scale:**
- Batching already works well (500 rows/batch, concurrency 3).
- For 1M objects: ~2000 batches, ~667 concurrent rounds. This is fine — each batch is a single Supabase insert.

### Progress Output

For large imports, users need feedback during execution. Both CLI and API support progress reporting.

**CLI progress (stderr):**
```
Importing 12,308 objects...
  [=====>                    ] 2,500 / 12,308  (20%)
  [===========>              ] 6,000 / 12,308  (49%)
  [=========================>] 12,308 / 12,308 (100%)

Done — imported 12,308 objects (3 errors).
```

Progress writes to stderr so stdout remains clean for `--format json`. The progress bar updates after each batch completes (500 objects default).

**API progress:** The `POST /api/buckets/{id}/import` response includes the final counts as today. Real-time progress for the API is out of scope — the CLI gets progress because it controls the execution loop directly (it could call a streaming endpoint in the future, but for now the CLI calls the library function directly rather than going through the API for the execute phase).

**Agent progress:** The agent tool returns the final result. For long imports, the agent can tell the user "This may take a moment — importing 12,308 objects..." before calling the tool. Real-time streaming progress to the agent is out of scope.

## Scope

### In Scope
- `POST /api/buckets/{id}/import/plan` endpoint (persists plan as event)
- Modify `POST /api/buckets/{id}/import` to accept optional `plan_id`
- Plan events (`op: "import:plan"`) with summary metadata
- Imported events link to plan via `parent_id`
- CLI two-phase flow with confirmation prompt
- CLI progress bar (stderr) during execution
- `--yes`, `--plan-only` flags; deprecate `--dry-run`
- `import_bucket` agent tool with plan/confirm pattern
- `listS3Objects` returns `truncated` flag instead of throwing at MAX_PAGES

### Out of Scope
- Streaming/cursor-based S3 listing (future spec if needed)
- Importing modified objects (existing design decision — sync handles these)
- Real-time progress streaming via API or agent (CLI progress only in this spec)
- Plan cleanup/garbage collection (old plan events are harmless)

## Dependencies

**Depends on:**
- 23-bucket-import (current `importBucket`, `scanBucket` functions)
- 22-web-agent-tool-use (agent tool infrastructure)

**Modifies:**
- `web/lib/media/bucket-service.ts` — new `planImport()` function, modify `importBucket` signature
- `web/lib/media/s3.ts` — `listS3Objects` truncation handling
- `web/app/api/buckets/[id]/import/route.ts` — accept `plan_id`
- `web/app/api/buckets/[id]/import/plan/route.ts` — new endpoint
- `web/bin/sitemgr.ts` — two-phase CLI flow
- `web/lib/agent/tools.ts` — new `import_bucket` tool

## Key Decisions
- **Plans are events.** Stored in the existing `events` table with `op: "import:plan"`. No new table, no migration, no in-memory cache. Plans persist across server restarts and agent context compaction. Old plans are just old events — no cleanup needed.
- **Plan expiry is 10 minutes** (checked via `metadata.expires_at`). Long enough for a human to read and decide, short enough that the bucket state hasn't drifted much.
- **Imported events link to plan via `parent_id`.** This creates an audit chain: plan event → imported s3:put events.
- The agent tool uses a single tool name with an optional `confirm_plan_id` parameter rather than two separate tools. This keeps the tool list small and the flow is clear: no plan_id = plan, with plan_id = execute.
- `--dry-run` is kept as a hidden alias for backwards compatibility but `--plan-only` is the documented flag going forward.
- Content type breakdown uses the existing `detectContentType()` function, which works from file extensions. No new detection logic needed.
- CLI progress writes to stderr so `--format json` stdout remains clean.
