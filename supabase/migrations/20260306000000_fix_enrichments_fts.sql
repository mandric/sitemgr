-- Fix: array_to_string is not immutable, so wrap it for generated columns
-- This migration handles the case where the initial schema partially applied
-- (events table exists but enrichments table failed)

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
