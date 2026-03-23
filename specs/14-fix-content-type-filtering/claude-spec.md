# Synthesized Specification — Fix Content Type Filtering

## Problem Statement

Three functions in `web/lib/media/db.ts` have inconsistent or broken content_type filtering, identified during code review of PR #47. The root cause is a mismatch between what the original spec proposed (MIME type filtering with `.like("content_type", "image/%")`) and what production code actually stores (simple labels: `"photo"`, `"video"`, `"audio"`, `"file"` via `CONTENT_TYPE_MAP`).

Additionally, several integration test fixtures insert events with MIME types (`"image/jpeg"`, `"video/mp4"`) instead of the simple labels that production `detectContentType()` produces, causing test/production divergence.

## Decision: Keep Simple Labels

Production code uses `detectContentType()` → `CONTENT_TYPE_MAP` to store simple labels. This is intentional and correct. The PR #47 planning docs that called for `.like("content_type", "image/%")` had the wrong approach. All fixes will use `.eq("content_type", "photo")` rather than MIME type patterns.

## Bug Fixes Required

### Bug 1: `getEnrichStatus()` — Missing content_type filter (db.ts ~line 263)

**Problem:** The PR removed `.eq("content_type", "photo")` but did not replace it. The events query now counts ALL `type = "create"` events (video, audio, documents), inflating both `total_media` and `pending` counts.

**Fix:** Add `.eq("content_type", "photo")` to the events query. Enrichment is scoped to photos only.

### Bug 2: `getStats()` — `contentTypeCounts["photo"]` lookup (db.ts ~line 244)

**Problem per original spec:** Claims `contentTypeCounts["photo"]` always returns `undefined`.

**Research finding:** This is actually **correct for production data** — production stores `"photo"`, so `contentTypeCounts["photo"]` will find the right key. The bug only manifests in tests that seed data with `"image/jpeg"` instead of `"photo"`.

**Fix:** Keep `contentTypeCounts["photo"]` as-is. Fix test fixtures instead.

### Bug 3 (Not a bug): `getPendingEnrichments()` — `.eq("content_type", "photo")` (db.ts ~line 405)

**Research finding:** This filter is **already correct** for production data. No code change needed. The original spec identified this as wrong because it assumed MIME types, but production stores `"photo"`.

## Test Fixture Fixes Required

### `seedUserData()` in `web/__tests__/integration/setup.ts` (~line 176)
- Change `content_type: "image/jpeg"` → `content_type: "photo"`

### `media-lifecycle.test.ts` in `web/__tests__/integration/`
- Line ~124: Change `content_type: "image/jpeg"` → `content_type: "photo"`
- Line ~176: Change `content_type: "image/jpeg"` → `content_type: "photo"`
- Line ~189: Change `content_type: "video/mp4"` → `content_type: "video"`

### `smgr-cli.test.ts` in `web/__tests__/integration/`
- Lines ~234, ~347: Already use `content_type: "photo"` — no change needed

## Scope

| Item | Action |
|------|--------|
| `getEnrichStatus()` in db.ts | Add `.eq("content_type", "photo")` filter |
| `getStats()` in db.ts | No change — already correct for production data |
| `getPendingEnrichments()` in db.ts | No change — already correct |
| `seedUserData()` in setup.ts | Fix content_type to use simple labels |
| media-lifecycle.test.ts fixtures | Fix content_type to use simple labels |
| smgr-cli.test.ts fixtures | Already correct, verify only |
| `detectContentType()` / `CONTENT_TYPE_MAP` | No change |
| Database schema/migrations | No change |

## Verification

1. Run integration tests locally — `media-lifecycle.test.ts` and `smgr-cli.test.ts` should pass
2. Push to branch, monitor CI as backup
3. Confirm `getEnrichStatus()`, `getStats()`, `getPendingEnrichments()` all consistently work with `"photo"` label

## Risk

Low. One query filter addition and test fixture string changes. No schema changes, no migrations, no new dependencies.
