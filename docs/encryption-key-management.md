# Encryption Key Management Guide

## Overview

This project uses AES-256-GCM encryption to protect S3 credentials stored in the database. The encryption key must be managed carefully to avoid data loss.

## The Problem

**Symptom**: "Failed to decrypt secret — the ENCRYPTION_KEY may have changed"

**Cause**: Data was encrypted with one key but you're trying to decrypt with a different key.

**Impact**: 
- ❌ Cannot read S3 bucket credentials
- ❌ Cannot access configured buckets
- ⚠️  Data is NOT lost, just inaccessible until key is fixed

## Prevention (Best Practices)

### 1. Use the Same Key Everywhere

```bash
# Generate a secure key ONCE
openssl rand -base64 32

# Store it securely (1Password, Vault, etc.)

# Set it in ALL environments
# .env.local (development)
ENCRYPTION_KEY=<your-key>

# .env.production (reference)
ENCRYPTION_KEY=<same-key>

# Vercel (production)
vercel env add ENCRYPTION_KEY production
# Paste the SAME key
```

### 2. Document Your Key Location

Keep a record of where the key is stored:
- Production: Vercel environment variables
- Staging: Vercel environment variables
- Local: `.env.local` (gitignored)
- Backup: 1Password vault / secret manager

### 3. Never Commit Keys to Git

✅ Keys are in `.env.local` and `.env.production` (both gitignored)
❌ Never put keys in `.env.example` or committed files

## Recovery Scenarios

### Scenario 1: Key Mismatch (You Have Both Keys)

**Best case**: You have both the old and new key.

```bash
# Use the migration script
cd web
OLD_ENCRYPTION_KEY=<old-key> \
NEW_ENCRYPTION_KEY=<new-key> \
npx tsx scripts/migrate-encryption-key.ts

# Dry run first to verify
# Then run with --live to apply changes
OLD_ENCRYPTION_KEY=<old-key> \
NEW_ENCRYPTION_KEY=<new-key> \
npx tsx scripts/migrate-encryption-key.ts --live
```

**The script will**:
1. Fetch all encrypted bucket configs
2. Decrypt each with OLD_KEY
3. Re-encrypt each with NEW_KEY
4. Update the database
5. Verify all records can be decrypted with NEW_KEY

### Scenario 2: Lost the Key (You Only Have New Key)

**Worst case**: You don't have the old key, data is unrecoverable.

**Options**:

#### Option A: Find the Old Key
- Check backup environment variables
- Check deployment logs (Vercel, GitHub Actions)
- Check team password managers
- Check local `.env.local` files on team machines

#### Option B: Re-configure Buckets
If you truly lost the key, users must re-add their buckets:

```bash
# 1. Clear all bucket configs (data loss!)
psql "<connection-string>" -c "DELETE FROM bucket_configs;"

# 2. Users must re-add their buckets via:
#    - Web UI: /buckets page
#    - WhatsApp: Send "add bucket" message
```

#### Option C: Manual Recovery (If You Have S3 Credentials Elsewhere)

```bash
# If you have the plaintext S3 credentials stored elsewhere,
# you can re-insert them with the new key:

cd web
node scripts/re-add-bucket-with-new-key.ts
```

### Scenario 3: Production vs Staging Key Mismatch

**Symptom**: Works in staging but not production (or vice versa).

**Fix**:

```bash
# 1. Check which key is correct
# If staging works, use staging key in production

# Get staging key
vercel env pull .env.staging --environment=preview

# Set it in production
grep ENCRYPTION_KEY .env.staging
vercel env add ENCRYPTION_KEY production
# Paste the staging key

# 2. Redeploy
vercel --prod
```

## Key Rotation (Planned Migration)

When you want to rotate keys for security reasons:

```bash
# Step 1: Generate new key
NEW_KEY=$(openssl rand -base64 32)
echo "New key: $NEW_KEY"

# Step 2: Run migration (dry-run first)
OLD_ENCRYPTION_KEY=$CURRENT_KEY \
NEW_ENCRYPTION_KEY=$NEW_KEY \
npx tsx scripts/migrate-encryption-key.ts

# Step 3: Verify success
# (Script will verify automatically)

# Step 4: Run migration for real
OLD_ENCRYPTION_KEY=$CURRENT_KEY \
NEW_ENCRYPTION_KEY=$NEW_KEY \
npx tsx scripts/migrate-encryption-key.ts --live

# Step 5: Update environment variables
vercel env add ENCRYPTION_KEY production
# Paste NEW_KEY

# Update .env.local
echo "ENCRYPTION_KEY=$NEW_KEY" >> .env.local

# Step 6: Deploy
vercel --prod

# Step 7: Monitor
# Check logs for decryption errors
vercel logs --prod
```

## Troubleshooting

### How to identify which key is correct?

```bash
# Try decrypting with different keys
cd web

# Test with current production key
ENCRYPTION_KEY=<prod-key> npx tsx scripts/test-decrypt.ts

# Test with staging key
ENCRYPTION_KEY=<staging-key> npx tsx scripts/test-decrypt.ts

# Test with old backup key
ENCRYPTION_KEY=<backup-key> npx tsx scripts/test-decrypt.ts

# Whichever works is your correct key!
```

### What if I have multiple keys and don't know which is right?

Create a test script:

```typescript
// scripts/find-correct-key.ts
import { createClient } from "@supabase/supabase-js";
import { decryptSecret } from "../lib/crypto/encryption";

const candidates = [
  "key1-from-production",
  "key2-from-staging",
  "key3-from-backup",
];

async function findKey() {
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  const { data } = await supabase
    .from("bucket_configs")
    .select("secret_access_key")
    .limit(1)
    .single();

  if (!data) {
    console.log("No bucket configs to test");
    return;
  }

  for (const key of candidates) {
    try {
      process.env.ENCRYPTION_KEY = key;
      await decryptSecret(data.secret_access_key);
      console.log(`✅ FOUND IT: ${key.substring(0, 20)}...`);
      return;
    } catch {
      console.log(`❌ Not this one: ${key.substring(0, 20)}...`);
    }
  }
  
  console.log("❌ None of the candidate keys work");
}

findKey();
```

## Architecture Notes

### Why This Approach?

- **At-rest encryption**: S3 credentials are sensitive (access to user media)
- **AES-256-GCM**: Industry standard, authenticated encryption
- **Single master key**: Simplicity (no key-per-user complexity)
- **Environment-based**: Key lives in env vars (not in database)

### Limitations

- **Single point of failure**: If you lose ENCRYPTION_KEY, data is unrecoverable
- **Key rotation requires downtime**: Must decrypt-all → re-encrypt-all
- **No versioning**: Can't have multiple key versions active

### Future Improvements

1. **Key versioning**: Store which key version encrypted each record
   ```sql
   ALTER TABLE bucket_configs ADD COLUMN encryption_key_version INT DEFAULT 1;
   ```

2. **Multiple active keys**: Support old + new during rotation
   ```typescript
   const KEYS = {
     v1: process.env.ENCRYPTION_KEY_V1,
     v2: process.env.ENCRYPTION_KEY_V2,
   };
   ```

3. **Per-user keys**: Derive encryption keys from user passwords (more complex)

4. **HSM / KMS integration**: Use AWS KMS or similar for key management

## Monitoring

Add alerts for decryption failures:

```typescript
// In getBucketConfig()
try {
  const decrypted = await decryptSecret(data.secret_access_key);
  return { ok: true, config: { ...data, secret_access_key: decrypted } };
} catch (err) {
  // Alert to monitoring system
  await sendAlert({
    severity: "high",
    message: "Decryption failure - possible key mismatch",
    context: { bucketId: data.id }
  });
  
  return { ok: false, error: err };
}
```

## References

- Migration script: `web/scripts/migrate-encryption-key.ts`
- Encryption implementation: `web/lib/crypto/encryption.ts`
- Database schema: `supabase/migrations/20260306000001_bucket_configs.sql`
