-- Add p_user_id parameter to RPC functions for tenant isolation
-- Restrict get_user_id_from_phone to service_role only

-- 1a. search_events: drop old overload first, then create new with p_user_id
DROP FUNCTION IF EXISTS search_events(TEXT, TEXT, TEXT, TEXT, INT);

CREATE OR REPLACE FUNCTION search_events(
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
    "type" TEXT,
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
        e.id, e."timestamp", e.device_id, e.type, e.content_type,
        e.content_hash, e.local_path, e.remote_path, e.metadata, e.parent_id,
        en.description, en.objects, en.context, en.tags
    FROM enrichments en
    JOIN events e ON e.id = en.event_id
    WHERE en.fts @@ plainto_tsquery('english', query_text)
      AND e.type = 'create'
      AND e.user_id = p_user_id
      AND (content_type_filter IS NULL OR e.content_type = content_type_filter)
      AND (since_filter IS NULL OR e."timestamp" >= since_filter::timestamptz)
      AND (until_filter IS NULL OR e."timestamp" <= until_filter::timestamptz)
    ORDER BY ts_rank(en.fts, plainto_tsquery('english', query_text)) DESC
    LIMIT result_limit;
$$;

-- 1b. stats_by_content_type: add p_user_id filter
DROP FUNCTION IF EXISTS stats_by_content_type();
CREATE FUNCTION stats_by_content_type(p_user_id UUID)
RETURNS TABLE(content_type TEXT, "count" BIGINT)
LANGUAGE sql STABLE
AS $$
    SELECT content_type, count(*)
    FROM events
    WHERE type = 'create' AND user_id = p_user_id
    GROUP BY content_type
    ORDER BY count DESC;
$$;

-- 1c. stats_by_event_type: add p_user_id filter
DROP FUNCTION IF EXISTS stats_by_event_type();
CREATE FUNCTION stats_by_event_type(p_user_id UUID)
RETURNS TABLE("type" TEXT, "count" BIGINT)
LANGUAGE sql STABLE
AS $$
    SELECT type, count(*)
    FROM events
    WHERE user_id = p_user_id
    GROUP BY type
    ORDER BY count DESC;
$$;

-- 1d. Restrict get_user_id_from_phone to service_role only
REVOKE EXECUTE ON FUNCTION get_user_id_from_phone(TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_user_id_from_phone(TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION get_user_id_from_phone(TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION get_user_id_from_phone(TEXT) TO service_role;
