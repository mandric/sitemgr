-- Fix: array_to_string is not immutable, so wrap it for generated columns
-- Fix: quote reserved words (timestamp, type, count) in RETURNS TABLE
-- This migration handles the case where the initial schema partially applied

CREATE OR REPLACE FUNCTION immutable_array_to_string(arr TEXT[], sep TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
    SELECT array_to_string(arr, sep);
$$;

CREATE TABLE IF NOT EXISTS enrichments (
    event_id    TEXT PRIMARY KEY REFERENCES events(id),
    description TEXT,
    objects     TEXT[],
    context     TEXT,
    tags        TEXT[],
    fts         TSVECTOR GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce(description, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(context, '')), 'B') ||
        setweight(to_tsvector('english', coalesce(immutable_array_to_string(tags, ' '), '')), 'C') ||
        setweight(to_tsvector('english', coalesce(immutable_array_to_string(objects, ' '), '')), 'C')
    ) STORED
);

CREATE INDEX IF NOT EXISTS idx_enrichments_fts ON enrichments USING GIN(fts);

-- These may have been skipped if the initial migration failed partway through
CREATE TABLE IF NOT EXISTS watched_keys (
    s3_key      TEXT PRIMARY KEY,
    first_seen  TIMESTAMPTZ NOT NULL,
    event_id    TEXT REFERENCES events(id),
    etag        TEXT,
    size_bytes  BIGINT
);

CREATE TABLE IF NOT EXISTS conversations (
    phone_number TEXT PRIMARY KEY,
    history      JSONB NOT NULL DEFAULT '[]',
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO storage.buckets (id, name, public)
VALUES ('media', 'media', false)
ON CONFLICT DO NOTHING;

-- Re-create RPC functions with quoted reserved words
CREATE OR REPLACE FUNCTION stats_by_content_type()
RETURNS TABLE(content_type TEXT, "count" BIGINT)
LANGUAGE sql STABLE
AS $$
    SELECT content_type, count(*)
    FROM events
    WHERE type = 'create'
    GROUP BY content_type
    ORDER BY count DESC;
$$;

CREATE OR REPLACE FUNCTION stats_by_event_type()
RETURNS TABLE("type" TEXT, "count" BIGINT)
LANGUAGE sql STABLE
AS $$
    SELECT type, count(*)
    FROM events
    GROUP BY type
    ORDER BY count DESC;
$$;

CREATE OR REPLACE FUNCTION search_events(
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
      AND (content_type_filter IS NULL OR e.content_type = content_type_filter)
      AND (since_filter IS NULL OR e."timestamp" >= since_filter::timestamptz)
      AND (until_filter IS NULL OR e."timestamp" <= until_filter::timestamptz)
    ORDER BY ts_rank(en.fts, plainto_tsquery('english', query_text)) DESC
    LIMIT result_limit;
$$;
