# ENCRYPTION_KEY Recovery Guide

## 🚨 Quick Start - I Have an Encryption Key Problem!

### Step 1: Identify Your Situation

**Which scenario matches yours?**

1. ✅ **I have both old and new keys** → [Scenario A: Key Migration](#scenario-a-key-migration-you-have-both-keys)
2. ⚠️ **I have multiple keys, don't know which is right** → [Scenario B: Find the Right Key](#scenario-b-find-the-correct-key)
3. ❌ **I lost the key completely** → [Scenario C: Key Lost Forever](#scenario-c-key-lost-forever-nuclear-option)

### Step 2: Choose Your Recovery Path

---

## Scenario A: Key Migration (You Have Both Keys)

**When**: You know both the old and new encryption keys.

**Result**: Re-encrypt all data with the new key, no data loss.

### Steps:

```bash
cd web

# 1. Dry run to verify (no changes made)
OLD_ENCRYPTION_KEY="<your-old-key>" \
NEW_ENCRYPTION_KEY="<your-new-key>" \
npx tsx scripts/migrate-encryption-key.ts

# 2. Review the output
# It should say "X successfully re-encrypted, 0 failed"

# 3. Run for real
OLD_ENCRYPTION_KEY="<your-old-key>" \
NEW_ENCRYPTION_KEY="<your-new-key>" \
npx tsx scripts/migrate-encryption-key.ts --live

# 4. Wait for completion and verification

# 5. Update all environment variables
vercel env add ENCRYPTION_KEY production
# Paste NEW_ENCRYPTION_KEY

# Update local
echo "ENCRYPTION_KEY=<your-new-key>" > .env.local

# 6. Deploy
vercel --prod
```

**What the script does**:
1. Fetches all bucket configs
2. Decrypts each with OLD_KEY
3. Re-encrypts each with NEW_KEY
4. Updates database
5. Verifies all records can be decrypted with NEW_KEY

**Time**: ~1 second per bucket config

**Risk**: Low (has rollback capability)

---

## Scenario B: Find the Correct Key

**When**: You have multiple possible keys but don't know which one is correct.

**Result**: Identify which key(s) can decrypt your data.

### Steps:

```bash
cd web

# Method 1: Pass keys as arguments
npx tsx scripts/find-correct-encryption-key.ts \
  "candidate-key-1" \
  "candidate-key-2" \
  "candidate-key-3"

# Method 2: Edit the script
# Open scripts/find-correct-encryption-key.ts
# Add your keys to the CANDIDATE_KEYS array
# Then run:
npx tsx scripts/find-correct-encryption-key.ts
```

**Where to find candidate keys**:
- [ ] Vercel production env vars: `vercel env pull`
- [ ] Vercel staging env vars: `vercel env pull --environment=preview`
- [ ] Local `.env.local` files (check all team members)
- [ ] GitHub Actions secrets (if you have access)
- [ ] Team password managers (1Password, LastPass, etc.)
- [ ] Backup `.env` files
- [ ] Deployment logs (might contain key fragments)
- [ ] Infrastructure-as-code repos (Terraform, etc.)

**Output**:
```
✅ Working key(s) (decrypt all configs):
   abc123def456...

Use this key in your ENCRYPTION_KEY environment variable!
```

**Next step**: Once you find the right key, update all environments to use it.

---

## Scenario C: Key Lost Forever (Nuclear Option)

**When**: You've exhausted all options and cannot recover the key.

**Result**: Delete all bucket configs. Users must re-add them.

### Impact Assessment

**What gets deleted**:
- ✅ All bucket configurations (credentials)
- ✅ Watched keys associated with buckets (CASCADE)

**What stays intact**:
- ✅ Events (but lose bucket_config_id reference)
- ✅ Enrichments
- ✅ User accounts
- ✅ Actual files in S3 (not affected)

**User impact**:
- ❌ Must re-configure all S3 buckets
- ⚠️ Lose indexing progress (watched_keys)
- ✅ Can re-index buckets after re-adding

### Steps:

```bash
cd web

# 1. Dry run to see impact
npx tsx scripts/reset-bucket-configs.ts

# Review the output:
# - How many configs will be deleted?
# - How many events reference them?
# - How many watched keys will be deleted?

# 2. Backup (optional but recommended)
pg_dump "<connection-string>" \
  --table=bucket_configs \
  > bucket_configs_backup.sql

# 3. Generate new encryption key
NEW_KEY=$(openssl rand -base64 32)
echo "Save this key: $NEW_KEY"

# 4. Run the reset (requires --confirm)
npx tsx scripts/reset-bucket-configs.ts --confirm

# 5. Update environment variables with NEW key
echo "ENCRYPTION_KEY=$NEW_KEY" > .env.local

vercel env add ENCRYPTION_KEY production
# Paste $NEW_KEY

# 6. Deploy
vercel --prod

# 7. Notify users
# Email/message all users that they need to re-add buckets
```

### User Re-configuration

**Web UI users**:
1. Go to https://your-app.vercel.app/buckets
2. Click "Add Bucket"
3. Enter S3 credentials
4. Click "Save"

**WhatsApp users**:
1. Send message: "add bucket"
2. Follow the prompts to configure S3 credentials

---

## Prevention for the Future

### 1. Document Key Location

Create a `RUNBOOK.md`:
```markdown
# Encryption Key Locations

- Production: Vercel env var `ENCRYPTION_KEY`
- Staging: Vercel env var `ENCRYPTION_KEY` (preview)
- Local: `.env.local` (gitignored)
- Backup: 1Password vault "Engineering" → "sitemgr-encryption-key"
- Rotation history: [link to key rotation log]
```

### 2. Backup Keys Securely

```bash
# Add to 1Password, Vault, etc.
op item create \
  --category=password \
  --title="sitemgr ENCRYPTION_KEY" \
  password="$ENCRYPTION_KEY"
```

### 3. Key Versioning (Future Enhancement)

Add a version column:
```sql
ALTER TABLE bucket_configs ADD COLUMN encryption_key_version INT DEFAULT 1;
```

Support multiple keys:
```typescript
const KEYS = {
  1: process.env.ENCRYPTION_KEY_V1,
  2: process.env.ENCRYPTION_KEY_V2,
};

// Decrypt with appropriate version
const key = KEYS[config.encryption_key_version];
```

### 4. Monitoring

Add Sentry/DataDog alerts:
```typescript
if (decryptionError) {
  Sentry.captureException(decryptionError, {
    tags: { type: 'encryption_key_mismatch' },
    extra: { bucketId: config.id }
  });
}
```

### 5. Regular Key Rotation

Schedule key rotations (e.g., every 90 days):
1. Generate new key
2. Run migration script
3. Update all environments
4. Verify
5. Document in rotation log

---

## Scripts Reference

| Script | Purpose | When to Use |
|--------|---------|-------------|
| `migrate-encryption-key.ts` | Re-encrypt data with new key | You have both old and new keys |
| `find-correct-encryption-key.ts` | Test multiple keys | You don't know which key is correct |
| `reset-bucket-configs.ts` | Delete all configs | Key is permanently lost |
| `diagnose-bucket-issue.ts` | General diagnostics | Troubleshooting any bucket issue |
| `test-bucket-config.ts` | Basic encrypt/decrypt test | Verify encryption is working |

---

## FAQ

### Can I recover the key from the database?

**No.** The database only stores encrypted data, not the encryption key. The key must be in environment variables.

### What if only some configs fail to decrypt?

This suggests you have configs encrypted with different keys (partial migration). Use `find-correct-encryption-key.ts` to identify which keys work for which configs, then run migration.

### Can I use a different key in different environments?

**Not recommended.** If you export/import data between environments, it won't work. Use the same key everywhere.

### How do I rotate keys without downtime?

1. Support multiple key versions (requires code changes)
2. Gradually re-encrypt in background
3. Once all data is re-encrypted with new key, remove old key

This is not currently implemented but can be added.

### What happens if I deploy with the wrong key?

Users will see "Failed to decrypt secret" errors when trying to use buckets. Fix by reverting to correct key and redeploying.

---

## Emergency Contacts

If you're stuck:
1. Check this guide
2. Run diagnostic scripts
3. Check team documentation
4. Review recent deployments for key changes
5. Contact the team member who last worked on encryption

---

## Lessons Learned (From Recent Issues)

### Issue: WhatsApp webhook crashing with "Cipher job failed"

**Root cause**: Bucket was encrypted with old Supabase Edge Function key, but Vercel API route used different key.

**Fix**: 
- Identified both keys
- Ran migration script to re-encrypt with new key
- Updated Vercel env vars
- Added graceful error handling in `getBucketConfig()`

**Prevention**: 
- Documented encryption key locations
- Added this recovery guide
- Created diagnostic scripts
- Added encryption lifecycle tests

**Commits**: 3131479, 2d62d23, 0e1d104

---

**Last updated**: 2026-03-11
