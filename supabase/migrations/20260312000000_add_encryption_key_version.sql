-- Add encryption key version tracking to bucket_configs
-- This enables zero-downtime key rotation

-- Add version column (default 1 for existing data)
ALTER TABLE bucket_configs ADD COLUMN IF NOT EXISTS encryption_key_version INT DEFAULT 1;

-- Index for finding configs that need migration
CREATE INDEX IF NOT EXISTS idx_bucket_configs_key_version ON bucket_configs(encryption_key_version);

-- Add updated_at trigger to track when keys are rotated
CREATE OR REPLACE FUNCTION update_bucket_config_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS bucket_configs_updated_at ON bucket_configs;
CREATE TRIGGER bucket_configs_updated_at
  BEFORE UPDATE ON bucket_configs
  FOR EACH ROW
  EXECUTE FUNCTION update_bucket_config_timestamp();

-- Add comment explaining the versioning system
COMMENT ON COLUMN bucket_configs.encryption_key_version IS
  'Version of encryption key used. Enables zero-downtime key rotation by supporting multiple keys simultaneously.';
