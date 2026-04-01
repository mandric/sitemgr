# Interview Transcript: Spec 19 — Duplicate Detection

## Q1: Hash normalization on uploads — etag only or keep sha256?

**Question:** For hash normalization on uploads: should we drop sha256 entirely and only store etag, or keep sha256 in metadata.sha256 as a backup?

**Answer:** Drop sha256 entirely. Pre-1.0, backwards compatibility is not a concern.

## Q2: Dedup query approach — RPC or client-side?

**Question:** Should the dedup query be a Supabase RPC function (SQL) or a client-side query built in db.ts?

**Answer:** RPC function (recommended). Better for complex aggregations, matches existing `getStats` pattern.

## Q3: Expected scale of duplicate groups

**Question:** What scale of duplicate groups should we expect?

**Answer:** Small (under 100 groups). No pagination needed.

## Q4: CLI output format

**Question:** How should `smgr dedup <bucket>` display results?

**Answer:** Table format. No JSON output needed for MVP.

## Q5: Include file sizes in dedup report?

**Question:** Should the dedup report include file sizes and total wasted bytes?

**Answer:** No, skip for MVP. Just show paths and counts.

## Q6: Migration scope

**Question:** For the migration: just the RPC function, or also add a dedicated etag column on events?

**Answer:** RPC only. No new columns — just change what value is written to existing `content_hash`.

## Additional context from earlier conversation

- Backwards compatibility is not an issue pre-1.0
- An index on `content_hash` already exists (`idx_events_content_hash`)
- The `metadata` column on `events` is our own JSONB field, not S3 object metadata
