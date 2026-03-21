# Code Review: section-06-smgr-e2e

## Issues Found

### 1. "already exists" message string is unstable — use statusCode (confidence: 90) — Auto-fixed

`!bucketErr.message.includes("already exists")` is fragile — the message text varies across
Supabase Storage releases. A storage server update can silently break this guard, causing
`beforeAll` to throw on every run after the first.

The `StorageApiError` object has a structured `statusCode` field (e.g. `'409'`) sourced
directly from the HTTP response, which is stable.

**Fix:** `bucketErr.statusCode !== "409"` — standard HTTP 409 Conflict for duplicate bucket.
