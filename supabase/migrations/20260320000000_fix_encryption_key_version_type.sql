-- Fix encryption_key_version column type: INT -> TEXT
-- The application stores label strings ("current", "previous", "next")
-- but the column was created as INT, causing inserts to fail silently.

ALTER TABLE bucket_configs
  ALTER COLUMN encryption_key_version TYPE TEXT
  USING CASE
    WHEN encryption_key_version = 1 THEN 'current'
    ELSE encryption_key_version::TEXT
  END;

ALTER TABLE bucket_configs
  ALTER COLUMN encryption_key_version SET DEFAULT 'current';
