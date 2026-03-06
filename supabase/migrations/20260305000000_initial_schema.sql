-- smgr initial schema: migrated from SQLite to Postgres
-- See design/supabase-deploy.md for rationale

-- Events: immutable append-only event log
CREATE TABLE events (
    id              TEXT PRIMARY KEY,
    timestamp       TIMESTAMPTZ NOT NULL,
    device_id       TEXT NOT NULL,
    type            TEXT NOT NULL,
    content_type    TEXT,
    content_hash    TEXT,
    local_path      TEXT,
    remote_path     TEXT,
    metadata        JSONB,
    parent_id       TEXT REFERENCES events(id)
);

CREATE INDEX idx_events_type ON events(type);
CREATE INDEX idx_events_content_type ON events(content_type);
CREATE INDEX idx_events_content_hash ON events(content_hash);
CREATE INDEX idx_events_timestamp ON events(timestamp);
CREATE INDEX idx_events_device_id ON events(device_id);
CREATE INDEX idx_events_remote_path ON events(remote_path);
CREATE INDEX idx_events_parent_id ON events(parent_id);

-- Immutable wrapper for array_to_string (needed for generated columns)
CREATE OR REPLACE FUNCTION immutable_array_to_string(arr TEXT[], sep TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
    SELECT array_to_string(arr, sep);
$$;

-- Enrichments: full-text search on LLM-generated descriptions
CREATE TABLE enrichments (
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

CREATE INDEX idx_enrichments_fts ON enrichments USING GIN(fts);

-- Watched keys: tracks S3 objects already processed
CREATE TABLE watched_keys (
    s3_key      TEXT PRIMARY KEY,
    first_seen  TIMESTAMPTZ NOT NULL,
    event_id    TEXT REFERENCES events(id),
    etag        TEXT,
    size_bytes  BIGINT
);

-- Conversations: per-phone-number chat history for the WhatsApp bot
CREATE TABLE conversations (
    phone_number TEXT PRIMARY KEY,
    history      JSONB NOT NULL DEFAULT '[]',
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Storage bucket for media files
INSERT INTO storage.buckets (id, name, public)
VALUES ('media', 'media', false)
ON CONFLICT DO NOTHING;
