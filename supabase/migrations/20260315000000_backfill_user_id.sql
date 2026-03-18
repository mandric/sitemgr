-- Phase 1: Backfill user_id on records that have phone_number but NULL user_id
-- Safe to run on empty database (no-op if no rows match)
-- Records with unmatched phone numbers (no user_profiles row) are left as-is

-- 1. Backfill bucket_configs: direct phone_number → user_profiles join
UPDATE bucket_configs bc
SET user_id = up.id
FROM user_profiles up
WHERE bc.phone_number = up.phone_number
  AND bc.user_id IS NULL;

-- 2. Backfill events via bucket_config_id → bucket_configs → user_profiles
UPDATE events e
SET user_id = bc.user_id
FROM bucket_configs bc
WHERE e.bucket_config_id = bc.id
  AND e.user_id IS NULL
  AND bc.user_id IS NOT NULL;

-- 2b. Backfill events via device_id pattern 'whatsapp:+NNNNN' → user_profiles
UPDATE events e
SET user_id = up.id
FROM user_profiles up
WHERE e.device_id LIKE 'whatsapp:%'
  AND substring(e.device_id FROM 10) = up.phone_number
  AND e.user_id IS NULL;

-- 3. Backfill enrichments via events join
UPDATE enrichments en
SET user_id = e.user_id
FROM events e
WHERE en.event_id = e.id
  AND en.user_id IS NULL
  AND e.user_id IS NOT NULL;

-- 4. Backfill watched_keys via events join (watched_keys.event_id → events.id)
UPDATE watched_keys wk
SET user_id = e.user_id
FROM events e
WHERE wk.event_id = e.id
  AND wk.user_id IS NULL
  AND e.user_id IS NOT NULL;

-- 5. Backfill conversations: direct phone_number → user_profiles join
UPDATE conversations c
SET user_id = up.id
FROM user_profiles up
WHERE c.phone_number = up.phone_number
  AND c.user_id IS NULL;
