-- Phase 3: Schema cleanup — enforce NOT NULL on user_id, migrate conversations PK,
-- drop phone_number from bucket_configs
-- WARNING: This migration drops columns and changes primary keys. Not easily reversible.

-- 0. Remove orphaned rows that couldn't be backfilled in Phase 1
-- (rows with no matching user_profiles entry for their phone_number)
DELETE FROM enrichments WHERE user_id IS NULL;
DELETE FROM watched_keys WHERE user_id IS NULL;
DELETE FROM events WHERE user_id IS NULL;
DELETE FROM bucket_configs WHERE user_id IS NULL;
DELETE FROM conversations WHERE user_id IS NULL;

-- 1. Make user_id NOT NULL on tables
ALTER TABLE events ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE enrichments ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE watched_keys ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE bucket_configs ALTER COLUMN user_id SET NOT NULL;

-- 2. Migrate conversations primary key from phone_number to user_id
ALTER TABLE conversations ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE conversations DROP CONSTRAINT conversations_pkey;
ALTER TABLE conversations ADD PRIMARY KEY (user_id);

-- 3. Drop phone_number from bucket_configs (no longer used for auth)
-- First drop dependent constraints and indexes
ALTER TABLE bucket_configs DROP CONSTRAINT IF EXISTS bucket_configs_auth_method_check;
DROP INDEX IF EXISTS idx_bucket_configs_phone_bucket;
DROP INDEX IF EXISTS idx_bucket_configs_phone;
ALTER TABLE bucket_configs DROP COLUMN phone_number;

-- 4. Update unique constraints on bucket_configs
-- Drop partial unique index (user_id IS NOT NULL no longer needed since user_id is NOT NULL)
DROP INDEX IF EXISTS idx_bucket_configs_user_bucket;
-- Create regular unique constraint
ALTER TABLE bucket_configs ADD CONSTRAINT bucket_configs_user_id_bucket_name_key
    UNIQUE (user_id, bucket_name);
