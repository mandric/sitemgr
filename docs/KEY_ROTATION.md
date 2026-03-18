# Key Rotation Runbook

Operational procedure for rotating AES-GCM encryption keys used to protect S3 credentials stored in `bucket_configs`.

## Prerequisites

- **`ENCRYPTION_KEY_CURRENT`** must be set in Vercel Production (this is the active key)
- Access to Vercel CLI (`vercel`) authenticated to the project
- Access to Supabase SQL editor or `psql` for verification queries

### Key Requirements

Keys can be any string. The encryption module derives a 256-bit AES key by hashing the input with SHA-256. There are no strict length or character requirements, but for security:

- Use at least 32 characters of random alphanumeric text
- Generate with: `openssl rand -base64 32`
- Keys are stored **only** in Vercel environment variables, never in GitHub

### Environment Variable Locations

| Variable | Location | Purpose |
|----------|----------|---------|
| `ENCRYPTION_KEY_CURRENT` | Vercel Production | Active key for new encryptions |
| `ENCRYPTION_KEY_PREVIOUS` | Vercel Production | Old key for decryption during rotation |
| `ENCRYPTION_KEY_NEXT` | Vercel Production | Staged future key before promotion |

## Step-by-Step Rotation

### Step 1: Generate and Stage the New Key

```bash
# Generate a new key
NEW_KEY=$(openssl rand -base64 32)
echo "New key: $NEW_KEY"
# Save this value — you'll need it in Step 3

# Add as NEXT in Vercel (does NOT affect production yet)
vercel env add ENCRYPTION_KEY_NEXT production
# Paste the new key value when prompted
```

At this point:
- New encryptions still use `ENCRYPTION_KEY_CURRENT`
- `ENCRYPTION_KEY_NEXT` is available but unused

### Step 2: Validate the New Key Locally

Run the encryption test suite with the new key stubbed as CURRENT:

```bash
cd web

# In a test file or REPL, verify the key works:
# vi.stubEnv("ENCRYPTION_KEY_CURRENT", "<your-new-key-value>");
# Then run:
npm test
```

All encryption tests should pass. If any fail, the key is invalid — go back to Step 1.

### Step 3: Promote NEXT to CURRENT

This is the critical step. Do these in order:

```bash
# 3a. Save the current CURRENT key as PREVIOUS
# First, retrieve the current value:
vercel env ls  # Confirm ENCRYPTION_KEY_CURRENT exists

# Add it as PREVIOUS (paste the OLD current key value)
vercel env add ENCRYPTION_KEY_PREVIOUS production

# 3b. Replace CURRENT with the NEXT value
vercel env rm ENCRYPTION_KEY_CURRENT production
vercel env add ENCRYPTION_KEY_CURRENT production
# Paste the NEW key (the one you generated in Step 1)

# 3c. Remove NEXT (it's now CURRENT)
vercel env rm ENCRYPTION_KEY_NEXT production
```

### Step 4: Deploy and Monitor Lazy Migration

```bash
# Trigger a new deployment (or wait for the next push)
vercel --prod

# Monitor application logs for lazy migration messages
vercel logs --follow
```

**What to look for in logs:**

- `[Lazy Migration] ✅ Migrated "<bucket_name>" to encryption key vcurrent` — Record successfully re-encrypted
- `[Lazy Migration] ❌ Failed to migrate "<bucket_name>"` — Migration error (investigate)

Lazy migration happens automatically: each time a `bucket_configs` record is read via `getBucketConfig()`, if the ciphertext uses a non-current key label, it is decrypted and re-encrypted with the current key in the background.

## Monitoring Migration Progress

### Check Records by Encryption Version

```sql
-- Count records by encryption key version
SELECT encryption_key_version, count(*)
FROM bucket_configs
GROUP BY encryption_key_version
ORDER BY encryption_key_version;
```

- Records showing `current` are already on the new key
- Records showing `previous` or `NULL` still need migration
- Migration is complete when all records show `current`

### Force Migration of All Records

To trigger migration for records that haven't been accessed naturally:

```sql
-- List bucket configs that still use old encryption
SELECT id, bucket_name, encryption_key_version
FROM bucket_configs
WHERE encryption_key_version != 'current' OR encryption_key_version IS NULL;
```

Access each unmigrated bucket through the application (e.g., `list_buckets` or `test_bucket` actions) to trigger lazy migration.

### Verify a Specific Record

```sql
-- Check a specific record's encryption version
SELECT id, bucket_name, encryption_key_version,
       substring(secret_access_key, 1, 10) as ciphertext_prefix
FROM bucket_configs
WHERE bucket_name = '<your-bucket>';
```

The `ciphertext_prefix` should start with `current:` after migration.

## Rollback Procedure

If issues arise during or after rotation:

### Restore Previous Key as Current

```bash
# Swap back: make PREVIOUS the active key again
vercel env rm ENCRYPTION_KEY_CURRENT production
vercel env add ENCRYPTION_KEY_CURRENT production
# Paste the OLD key value (the one now stored as PREVIOUS)

# Keep PREVIOUS around until stable
vercel --prod
```

### Handle Migration Errors

If lazy migration produces errors for specific records:

1. Check the error in logs: `[Lazy Migration] ❌ Failed to migrate "<bucket>"`
2. The record's plaintext is still accessible (decryption uses the labeled key)
3. Manually re-encrypt by accessing the bucket through the application after fixing the key configuration

## Post-Rotation Cleanup

### When to Remove PREVIOUS

Remove `ENCRYPTION_KEY_PREVIOUS` only after confirming:

1. **All records migrated**: The verification query above shows zero non-current records
2. **No more migration log entries**: Application logs show no `[Lazy Migration]` messages for at least 24 hours
3. **Deployment stable**: No encryption-related errors in logs

### Cleanup Steps

```bash
# Final verification
vercel logs  # Check for any recent migration messages

# Remove the old key
vercel env rm ENCRYPTION_KEY_PREVIOUS production

# Deploy to pick up the change
vercel --prod
```

### Confirmation Checklist

- [ ] All `bucket_configs` records show `encryption_key_version = 'current'`
- [ ] No `[Lazy Migration]` log entries in the last 24 hours
- [ ] No decryption errors in application logs
- [ ] `ENCRYPTION_KEY_PREVIOUS` removed from Vercel
- [ ] Key rotation documented in ops log with date and reason
