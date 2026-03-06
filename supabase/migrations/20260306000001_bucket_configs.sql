-- Bucket configurations: store S3 credentials per user
-- Users can configure multiple buckets

-- Bucket configs table
-- Note: secret_access_key is encrypted by the Edge Function before storage
CREATE TABLE bucket_configs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone_number    TEXT NOT NULL,
    bucket_name     TEXT NOT NULL,
    endpoint_url    TEXT NOT NULL, -- S3 endpoint (AWS, Backblaze, Cloudflare R2, etc.)
    region          TEXT, -- Optional, some providers don't use regions
    access_key_id   TEXT NOT NULL,
    secret_access_key TEXT NOT NULL, -- Encrypted (AES-GCM) by Edge Function
    last_synced_key TEXT, -- Cursor for incremental scanning
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(phone_number, bucket_name) -- Can't add same bucket twice
);

CREATE INDEX idx_bucket_configs_phone ON bucket_configs(phone_number);

-- Update watched_keys to track which bucket config it came from
ALTER TABLE watched_keys ADD COLUMN IF NOT EXISTS bucket_config_id UUID REFERENCES bucket_configs(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_watched_keys_bucket ON watched_keys(bucket_config_id);

-- Update events to track bucket source
ALTER TABLE events ADD COLUMN IF NOT EXISTS bucket_config_id UUID REFERENCES bucket_configs(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_events_bucket ON events(bucket_config_id);
