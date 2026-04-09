-- Spec 21: drop watched_keys table.
--
-- watched_keys was a denormalized cache of "which S3 keys have we already
-- processed." That information is now derived directly from S3 (source of
-- truth for remote state) and the events table (source of truth for what
-- sitemgr recorded). The table is no longer read or written by any code
-- path — the rewritten scanBucket in lib/media/bucket-service.ts compares
-- S3 listings against events instead.
--
-- Ordering: all code that references watched_keys is removed in the same
-- PR. Pre-1.0 — no data preservation.

DROP POLICY IF EXISTS "Users can view own watched keys" ON watched_keys;
DROP POLICY IF EXISTS "Users can manage own watched keys" ON watched_keys;
DROP POLICY IF EXISTS "Webhook service account can access all watched_keys" ON watched_keys;

DROP INDEX IF EXISTS idx_watched_keys_user_id;
DROP INDEX IF EXISTS idx_watched_keys_bucket;

DROP TABLE IF EXISTS watched_keys CASCADE;
