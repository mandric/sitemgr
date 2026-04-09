-- Spec 21: rename events.type → events.op, use namespaced op strings.
--
-- Before this migration, every row in `events` had type='create', an ambiguous
-- label. We rename the column to `op` and store a namespaced operation string
-- (`s3:put`) that describes what actually happened. The schema is extensible
-- to future operations (`s3:delete`, `enrich:complete`, etc.) but for now
-- `s3:put` is the only op.
--
-- Ordering: the spec-19 partial index `idx_events_dedup` has a WHERE clause
-- referencing `type`, which blocks renaming the column. It must be dropped
-- first. The four RPCs that reference `type` must also be dropped (not
-- CREATE OR REPLACE'd) because their RETURNS TABLE signatures include `type`.

DROP INDEX IF EXISTS idx_events_dedup;
DROP INDEX IF EXISTS idx_events_type;

DROP FUNCTION IF EXISTS search_events(UUID, TEXT, TEXT, TEXT, TEXT, INT);
DROP FUNCTION IF EXISTS stats_by_event_type(UUID);
DROP FUNCTION IF EXISTS stats_by_content_type(UUID);
DROP FUNCTION IF EXISTS find_duplicate_groups(UUID, UUID, INT, INT);

ALTER TABLE events RENAME COLUMN type TO op;
UPDATE events SET op = 's3:put' WHERE op = 'create';

CREATE INDEX idx_events_op ON events(op);
CREATE INDEX idx_events_dedup
    ON events(user_id, content_hash)
    WHERE op = 's3:put' AND content_hash IS NOT NULL;

CREATE FUNCTION search_events(
    p_user_id UUID,
    query_text TEXT,
    content_type_filter TEXT DEFAULT NULL,
    since_filter TEXT DEFAULT NULL,
    until_filter TEXT DEFAULT NULL,
    result_limit INT DEFAULT 20
)
RETURNS TABLE(
    id TEXT,
    "timestamp" TIMESTAMPTZ,
    device_id TEXT,
    "op" TEXT,
    content_type TEXT,
    content_hash TEXT,
    local_path TEXT,
    remote_path TEXT,
    metadata JSONB,
    parent_id TEXT,
    description TEXT,
    objects TEXT[],
    context TEXT,
    tags TEXT[]
)
LANGUAGE sql STABLE
AS $$
    SELECT
        e.id, e."timestamp", e.device_id, e.op, e.content_type,
        e.content_hash, e.local_path, e.remote_path, e.metadata, e.parent_id,
        en.description, en.objects, en.context, en.tags
    FROM enrichments en
    JOIN events e ON e.id = en.event_id
    WHERE en.fts @@ plainto_tsquery('english', query_text)
      AND e.op = 's3:put'
      AND e.user_id = p_user_id
      AND (content_type_filter IS NULL OR e.content_type = content_type_filter)
      AND (since_filter IS NULL OR e."timestamp" >= since_filter::timestamptz)
      AND (until_filter IS NULL OR e."timestamp" <= until_filter::timestamptz)
    ORDER BY ts_rank(en.fts, plainto_tsquery('english', query_text)) DESC
    LIMIT result_limit;
$$;

CREATE FUNCTION stats_by_content_type(p_user_id UUID)
RETURNS TABLE(content_type TEXT, "count" BIGINT)
LANGUAGE sql STABLE
AS $$
    SELECT content_type, count(*)
    FROM events
    WHERE op = 's3:put' AND user_id = p_user_id
    GROUP BY content_type
    ORDER BY count DESC;
$$;

CREATE FUNCTION stats_by_event_type(p_user_id UUID)
RETURNS TABLE("op" TEXT, "count" BIGINT)
LANGUAGE sql STABLE
AS $$
    SELECT op, count(*)
    FROM events
    WHERE user_id = p_user_id
    GROUP BY op
    ORDER BY count DESC;
$$;

CREATE FUNCTION find_duplicate_groups(
    p_user_id UUID,
    p_bucket_config_id UUID DEFAULT NULL,
    p_limit INT DEFAULT 100,
    p_offset INT DEFAULT 0
)
RETURNS TABLE(
    content_hash TEXT,
    copies BIGINT,
    event_ids TEXT[],
    paths TEXT[]
)
LANGUAGE sql STABLE
AS $$
    SELECT
        e.content_hash,
        count(*) AS copies,
        array_agg(e.id) AS event_ids,
        array_agg(e.remote_path) AS paths
    FROM events e
    WHERE e.user_id = p_user_id
      AND e.op = 's3:put'
      AND e.content_hash IS NOT NULL
      AND (p_bucket_config_id IS NULL OR e.bucket_config_id = p_bucket_config_id)
    GROUP BY e.content_hash
    HAVING count(*) > 1
    ORDER BY copies DESC
    LIMIT p_limit
    OFFSET p_offset;
$$;
