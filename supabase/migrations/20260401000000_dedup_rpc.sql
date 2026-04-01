-- Duplicate detection: find events sharing the same content_hash
-- Used by GET /api/dedup to report duplicate files within a bucket.
-- SECURITY INVOKER (default) — RLS on events table enforces tenant isolation.
-- Do NOT add SECURITY DEFINER.

CREATE OR REPLACE FUNCTION find_duplicate_groups(
    p_user_id UUID,
    p_bucket_config_id UUID DEFAULT NULL
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
      AND e.type = 'create'
      AND e.content_hash IS NOT NULL
      AND (p_bucket_config_id IS NULL OR e.bucket_config_id = p_bucket_config_id)
    GROUP BY e.content_hash
    HAVING count(*) > 1
    ORDER BY copies DESC;
$$;
