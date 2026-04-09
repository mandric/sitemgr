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

**Phase 1 — Plan:** Scan the bucket, compute the diff, and return a summary (the "import plan"). No database writes. The plan includes enough information for the user to decide whether to proceed, scope down with `--prefix`, or abort.

**Phase 2 — Execute:** User confirms, the plan is executed. The plan carries an opaque token so the server can skip re-scanning if the plan is still fresh (optimization, not required — falling back to re-scan is fine).

### Import Plan Shape

```typescript
type ImportPlan = {
  plan_id: string;               // opaque token (e.g. UUID)
  bucket: string;                // bucket name
  prefix: string;                // prefix filter used (empty string if none)
  created_at: string;            // ISO 8601 timestamp
  expires_at: string;            // plan validity window (e.g. 10 minutes)

  // Counts
  total_objects: number;         // total S3 objects found
  synced: number;                // already tracked, hash matches
  untracked: number;             // new objects to import
  modified: number;              // ETag changed (skipped by import)

  // Breakdown by content type (derived from file extension)
  untracked_by_type: Record<string, number>;  // e.g. { "photo": 312, "video": 18, "document": 5 }

  // Size
  untracked_total_bytes: number; // sum of untracked object sizes

  // Scale warning (if applicable)
  warning?: string;              // e.g. "Listing was truncated at 1M objects. Use --prefix to scope."
  truncated: boolean;            // true if MAX_PAGES was hit
};
```

### API Changes

**New endpoint:** `POST /api/buckets/{id}/import/plan`

Request body:
```json
{ "prefix": "photos/2024/" }
```

Response:
```json
{
  "data": { /* ImportPlan */ }
}
```

**Modify existing:** `POST /api/buckets/{id}/import`

Add optional `plan_id` field. If provided and the plan is still cached/valid, skip re-scan. If expired or missing, re-scan (the existing behavior).

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

## Scope

### In Scope
- `POST /api/buckets/{id}/import/plan` endpoint
- Modify `POST /api/buckets/{id}/import` to accept optional `plan_id`
- `ImportPlan` type with content type breakdown and size totals
- CLI two-phase flow with confirmation prompt
- `--yes`, `--plan-only` flags; deprecate `--dry-run`
- `import_bucket` agent tool with plan/confirm pattern
- `listS3Objects` returns `truncated` flag instead of throwing at MAX_PAGES
- Plan caching (in-memory, short TTL) so execute phase can skip re-scan

### Out of Scope
- Streaming/cursor-based S3 listing (future spec if needed)
- Importing modified objects (existing design decision — sync handles these)
- Progress reporting during execution (nice-to-have, not this spec)
- Persistent plan storage (in-memory with TTL is sufficient)

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
- Plan caching is in-memory (Map with TTL), not database. Plans are ephemeral — if the server restarts, the user just re-plans. This avoids a migration.
- Plan expiry is 10 minutes. Long enough for a human to read and decide, short enough that the bucket state hasn't drifted much.
- The agent tool uses a single tool name with an optional `confirm_plan_id` parameter rather than two separate tools. This keeps the tool list small and the flow is clear: no plan_id = plan, with plan_id = execute.
- `--dry-run` is kept as a hidden alias for backwards compatibility but `--plan-only` is the documented flag going forward.
- Content type breakdown uses the existing `detectContentType()` function, which works from file extensions. No new detection logic needed.
