# Lazy Migration Deployment Guide

## What Was Implemented

✅ **Versioned encryption with automatic lazy migration** - Zero user impact key rotation.

### Key Features

1. **Multi-key support**: Can decrypt data encrypted with old (v1) or new (v2) keys
2. **Lazy migration**: Automatically re-encrypts data when accessed
3. **Zero downtime**: No scripts to run, happens transparently
4. **Zero user impact**: Users never know anything changed

## Files Changed

### Core Implementation
- `web/lib/crypto/encryption-versioned.ts` - Multi-version encryption support
- `web/lib/agent/core.ts` - Updated `getBucketConfig()` and `addBucket()` with lazy migration
- `web/components/buckets/actions.ts` - Updated web UI to use versioned encryption

### Database
- `supabase/migrations/20260312000000_add_encryption_key_version.sql` - Added `encryption_key_version` column

### Tests
- `web/__tests__/encryption-versioned.test.ts` - 18 new tests for versioned encryption
- `web/__tests__/s3-actions.test.ts` - Updated to use versioned encryption mocks
- `web/__tests__/encryption-lifecycle.test.ts` - Updated error message expectations

### Documentation & Scripts
- `docs/encryption-key-best-practices.md` - Best practices guide
- `docs/key-rotation-architecture-comparison.md` - Architecture comparison
- `docs/ENCRYPTION_KEY_RECOVERY.md` - Emergency recovery procedures
- `web/scripts/background-migrate-encryption-version.ts` - Optional cleanup script
- `web/scripts/find-correct-encryption-key.ts` - Key recovery helper
- `web/scripts/migrate-encryption-key.ts` - Manual migration (if needed)
- `web/scripts/reset-bucket-configs.ts` - Nuclear option (last resort)

## Deployment Steps

### Step 1: Prepare Environment Variables

Currently you have:
```bash
ENCRYPTION_KEY=<your-current-key>
```

For migration, you'll use:
```bash
ENCRYPTION_KEY_V1=<your-current-key>  # Old key (for backward compatibility)
ENCRYPTION_KEY_V2=<new-key-or-same>   # New key (for new encryptions)
ENCRYPTION_KEY=<same-as-v2>           # Fallback
```

**Option A: Keep same key (safest for first deployment)**
```bash
# In Vercel
ENCRYPTION_KEY_V1=<your-current-key>
ENCRYPTION_KEY_V2=<your-current-key>  # Same key!
ENCRYPTION_KEY=<your-current-key>
```

**Option B: Rotate to new key**
```bash
# Generate new key
NEW_KEY=$(openssl rand -base64 32)

# In Vercel
ENCRYPTION_KEY_V1=<your-current-key>  # Old
ENCRYPTION_KEY_V2=$NEW_KEY            # New
ENCRYPTION_KEY=$NEW_KEY
```

### Step 2: Apply Database Migration

```bash
# Local
cd /Users/mandric/dev/github.com/mandric/sitemgr
supabase db reset  # Already done locally

# Production (when ready to deploy)
supabase link --project-ref <your-project-ref>
supabase db push --linked
```

### Step 3: Deploy to Production

```bash
# Set environment variables in Vercel
vercel env add ENCRYPTION_KEY_V1 production
# Paste your current ENCRYPTION_KEY value

vercel env add ENCRYPTION_KEY_V2 production
# Paste same value (or new key if rotating)

vercel env add ENCRYPTION_KEY production
# Paste same as V2

# Deploy
git add .
git commit -m "Add lazy encryption key migration"
git push origin main

# Or deploy directly
vercel --prod
```

### Step 4: Monitor Migration Progress

```bash
# Check migration status (after deployment)
# Run locally against production DB
ENCRYPTION_KEY_V1=<old> ENCRYPTION_KEY_V2=<new> \
npx tsx web/scripts/background-migrate-encryption-version.ts --status

# Output will show:
# Total configs: 10
# Version distribution:
#   v1: 5 (50%)
#   v2: 5 (50%)
# Needing migration: 5
# Progress: 50% complete
```

### Step 5: Verify Lazy Migration Works

Test that configs are being migrated automatically:

1. **Access a bucket** (via web UI or WhatsApp)
2. **Check logs** - you should see:
   ```
   [Lazy Migration] ✅ Migrated "my-bucket" to encryption key v2
   ```
3. **Check database**:
   ```sql
   SELECT bucket_name, encryption_key_version 
   FROM bucket_configs 
   WHERE phone_number = 'whatsapp:+1234567890';
   ```
   The `encryption_key_version` should be `2` for accessed configs.

### Step 6: Optional Cleanup (After 1-2 Weeks)

After lazy migration has been active for a while, migrate remaining inactive configs:

```bash
# Run the cleanup script once
ENCRYPTION_KEY_V1=<old> ENCRYPTION_KEY_V2=<new> \
npx tsx web/scripts/background-migrate-encryption-version.ts --live
```

This will migrate any configs that haven't been accessed naturally.

### Step 7: Remove Old Key (Optional)

Once ALL configs are migrated to v2:

```bash
# Verify 100% migrated
npx tsx web/scripts/background-migrate-encryption-version.ts --status
# Should show: "All configs are on the current version!"

# Remove V1 key from Vercel
vercel env rm ENCRYPTION_KEY_V1 production

# Keep V2 and ENCRYPTION_KEY
```

## Rollback Plan

If something goes wrong:

### Immediate Rollback (< 1 hour after deploy)

```bash
# Revert the deployment
vercel rollback

# Or revert git commits
git revert HEAD
git push origin main
```

### Partial Rollback (Some configs migrated)

The code handles both v1 and v2, so you can:
1. Keep the code deployed
2. Fix the issue
3. Continue - lazy migration will resume automatically

## Testing Checklist

Before deploying to production:

- [x] All tests pass locally (70/70 ✅)
- [x] Database migration applied locally
- [x] Lazy migration works in local dev
- [ ] Environment variables set in Vercel
- [ ] Database migration applied in production
- [ ] Smoke test after deployment (add/test bucket)
- [ ] Monitor logs for migration activity
- [ ] Verify no errors in production

## How Lazy Migration Works

```typescript
// When a bucket config is accessed:
async function getBucketConfig(phoneNumber, bucketName) {
  const data = await fetchFromDatabase();
  
  // 1. Decrypt (works with old OR new key)
  const decrypted = await decryptSecretVersioned(data.secret_access_key);
  
  // 2. Check if needs migration
  if (needsMigration(data.secret_access_key)) {
    // 3. Re-encrypt with new version (in background)
    const newCiphertext = await encryptSecretVersioned(decrypted);
    
    // 4. Update database (fire-and-forget, non-blocking)
    updateInBackground(newCiphertext);
  }
  
  return decrypted;
}
```

**Key points**:
- Happens automatically during normal use
- Non-blocking (doesn't slow down requests)
- Frequently-used configs migrate first (optimal)
- Inactive configs can be cleaned up later with script

## Expected Timeline

- **Day 1**: Deploy code
- **Week 1**: ~80% of active configs migrated automatically
- **Week 2-4**: Remaining configs migrate as they're accessed
- **Week 4+**: Run cleanup script for stragglers (optional)
- **Week 5+**: Remove V1 key (optional)

## Monitoring Queries

```sql
-- Check migration progress
SELECT 
  encryption_key_version,
  COUNT(*) as count,
  ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER(), 1) as percentage
FROM bucket_configs
GROUP BY encryption_key_version
ORDER BY encryption_key_version;

-- Find configs still on v1
SELECT 
  id, 
  bucket_name, 
  phone_number, 
  user_id,
  encryption_key_version,
  updated_at
FROM bucket_configs
WHERE encryption_key_version < 2
ORDER BY updated_at DESC;

-- Check recent migrations
SELECT 
  bucket_name,
  encryption_key_version,
  updated_at
FROM bucket_configs
WHERE updated_at > NOW() - INTERVAL '1 hour'
ORDER BY updated_at DESC;
```

## Success Criteria

✅ All tests pass
✅ No errors in production logs
✅ Bucket operations work normally
✅ Configs are gradually migrating to v2
✅ Zero user complaints

## Support

If issues arise:
1. Check this document
2. Check `docs/ENCRYPTION_KEY_RECOVERY.md`
3. Check `docs/encryption-key-best-practices.md`
4. Review logs: `vercel logs --prod`

---

**Status**: ✅ Ready to deploy
**Tests**: ✅ 70/70 passing
**Risk**: 🟢 Low (backward compatible, well-tested)
