-- Add user_id column to bucket_configs for web authentication
-- This allows both WhatsApp (phone_number) and web (user_id) authentication

-- Add user_id column (nullable initially for existing rows)
ALTER TABLE bucket_configs ADD COLUMN user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

-- Create index for user_id lookups
CREATE INDEX idx_bucket_configs_user_id ON bucket_configs(user_id);

-- Make phone_number nullable since web users won't have a phone number
ALTER TABLE bucket_configs ALTER COLUMN phone_number DROP NOT NULL;

-- Update unique constraint to handle both auth methods
-- Drop old constraint
ALTER TABLE bucket_configs DROP CONSTRAINT IF EXISTS bucket_configs_phone_number_bucket_name_key;

-- Add new constraints: either phone_number+bucket or user_id+bucket must be unique
-- We can't enforce this with a single constraint, so we'll use partial unique indexes
CREATE UNIQUE INDEX idx_bucket_configs_phone_bucket ON bucket_configs(phone_number, bucket_name)
    WHERE phone_number IS NOT NULL;
CREATE UNIQUE INDEX idx_bucket_configs_user_bucket ON bucket_configs(user_id, bucket_name)
    WHERE user_id IS NOT NULL;

-- Add check constraint to ensure at least one auth method is present
ALTER TABLE bucket_configs ADD CONSTRAINT bucket_configs_auth_method_check
    CHECK (phone_number IS NOT NULL OR user_id IS NOT NULL);
