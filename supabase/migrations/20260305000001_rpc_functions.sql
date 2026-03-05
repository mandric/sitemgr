-- RPC functions called by the Edge Function

-- Stats: count events by content_type
CREATE OR REPLACE FUNCTION stats_by_content_type()
RETURNS TABLE(content_type TEXT, count BIGINT)
LANGUAGE sql STABLE
AS $$
    SELECT content_type, count(*)
    FROM events
    WHERE type = 'create'
    GROUP BY content_type
    ORDER BY count DESC;
$$;

-- Stats: count events by event type
CREATE OR REPLACE FUNCTION stats_by_event_type()
RETURNS TABLE(type TEXT, count BIGINT)
LANGUAGE sql STABLE
AS $$
    SELECT type, count(*)
    FROM events
    GROUP BY type
    ORDER BY count DESC;
$$;

-- Full-text search across enrichments joined with events
CREATE OR REPLACE FUNCTION search_events(
    query_text TEXT,
    content_type_filter TEXT DEFAULT NULL,
    since_filter TEXT DEFAULT NULL,
    until_filter TEXT DEFAULT NULL,
    result_limit INT DEFAULT 20
)
RETURNS TABLE(
    id TEXT,
    timestamp TIMESTAMPTZ,
    device_id TEXT,
    type TEXT,
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
        e.id, e.timestamp, e.device_id, e.type, e.content_type,
        e.content_hash, e.local_path, e.remote_path, e.metadata, e.parent_id,
        en.description, en.objects, en.context, en.tags
    FROM enrichments en
    JOIN events e ON e.id = en.event_id
    WHERE en.fts @@ plainto_tsquery('english', query_text)
      AND e.type = 'create'
      AND (content_type_filter IS NULL OR e.content_type = content_type_filter)
      AND (since_filter IS NULL OR e.timestamp >= since_filter::timestamptz)
      AND (until_filter IS NULL OR e.timestamp <= until_filter::timestamptz)
    ORDER BY ts_rank(en.fts, plainto_tsquery('english', query_text)) DESC
    LIMIT result_limit;
$$;
