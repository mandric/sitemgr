# Encryption Key Management - Best Practices

## The Problem with "Just Re-configure"

**Why it's bad**:
- ❌ **Poor user experience**: Users have to re-enter all their S3 credentials
- ❌ **Lost progress**: Watched keys (indexing state) are deleted
- ❌ **Trust erosion**: Users lose confidence in the service
- ❌ **Support burden**: Users will contact support confused about why their buckets disappeared
- ❌ **Churn risk**: Some users may not come back

**The real cost**:
```
10 users × 3 buckets each × 5 minutes to reconfigure = 2.5 hours of user time wasted
Plus: Support tickets, user frustration, potential churn
```

## Better Approaches (Ranked Best to Worst)

### ✅ Level 1: Prevention (Best)

**Never lose the key in the first place.**

#### Implementation:

1. **Treat ENCRYPTION_KEY like a root password**
   ```bash
   # Store in multiple secure locations
   - Production: Vercel env vars
   - Backup 1: 1Password/Vault (team shared)
   - Backup 2: Encrypted file in private repo
   - Backup 3: Printed and in safe (for critical systems)
   ```

2. **Document immediately when created**
   ```bash
   # When you first generate the key:
   KEY=$(openssl rand -base64 32)
   
   # IMMEDIATELY save it
   op item create --category=password \
     --title="sitemgr-encryption-key" \
     password="$KEY"
   
   # Then use it
   echo "ENCRYPTION_KEY=$KEY" >> .env.local
   vercel env add ENCRYPTION_KEY production
   ```

3. **Add to onboarding checklist**
   ```markdown
   ## New Team Member Setup
   - [ ] Get ENCRYPTION_KEY from 1Password vault
   - [ ] Add to local .env.local
   - [ ] Verify can decrypt existing configs
   ```

4. **Automated backup in CI/CD**
   ```yaml
   # .github/workflows/backup-secrets.yml
   name: Backup Critical Secrets
   on:
     schedule:
       - cron: '0 0 * * 0' # Weekly
   
   jobs:
     backup:
       runs-on: ubuntu-latest
       steps:
         - name: Backup to secure vault
           run: |
             # Export Vercel env vars to encrypted backup
             vercel env pull --token=${{ secrets.VERCEL_TOKEN }}
             gpg --encrypt --recipient team@example.com .env
             # Store in secure S3 bucket
   ```

### ✅ Level 2: Key Versioning (Ideal Production Solution)

**Support multiple keys simultaneously, gracefully migrate.**

#### Architecture:

```typescript
// lib/crypto/encryption.ts
interface EncryptionConfig {
  version: number;
  key: string;
}

const ENCRYPTION_KEYS: EncryptionConfig[] = [
  { version: 1, key: process.env.ENCRYPTION_KEY_V1! },
  { version: 2, key: process.env.ENCRYPTION_KEY_V2! },
].filter(k => k.key); // Only include keys that are set

const CURRENT_VERSION = 2; // Latest version for new encryptions

export async function encryptSecretVersioned(plaintext: string): Promise<string> {
  const currentKey = ENCRYPTION_KEYS.find(k => k.version === CURRENT_VERSION);
  if (!currentKey) throw new Error("Current encryption key not configured");
  
  process.env.ENCRYPTION_KEY = currentKey.key;
  const ciphertext = await encryptSecret(plaintext);
  
  // Prepend version: "v2:base64ciphertext"
  return `v${CURRENT_VERSION}:${ciphertext}`;
}

export async function decryptSecretVersioned(versionedCiphertext: string): Promise<string> {
  // Parse version
  const match = versionedCiphertext.match(/^v(\d+):(.+)$/);
  
  if (!match) {
    // Fallback: assume v1 (for existing data without version prefix)
    const v1Key = ENCRYPTION_KEYS.find(k => k.version === 1);
    if (!v1Key) throw new Error("V1 key not available for legacy data");
    process.env.ENCRYPTION_KEY = v1Key.key;
    return await decryptSecret(versionedCiphertext);
  }
  
  const version = parseInt(match[1], 10);
  const ciphertext = match[2];
  
  const keyConfig = ENCRYPTION_KEYS.find(k => k.version === version);
  if (!keyConfig) {
    throw new Error(`Encryption key version ${version} not available`);
  }
  
  process.env.ENCRYPTION_KEY = keyConfig.key;
  return await decryptSecret(ciphertext);
}
```

#### Database Migration:

```sql
-- Add version column
ALTER TABLE bucket_configs ADD COLUMN encryption_key_version INT DEFAULT 1;

-- Index for finding old versions to migrate
CREATE INDEX idx_bucket_configs_key_version ON bucket_configs(encryption_key_version);
```

#### Background Migration:

```typescript
// scripts/background-key-migration.ts
/**
 * Gradually re-encrypt configs with old key versions
 * Runs as a background job, doesn't block users
 */
async function migrateOldVersions() {
  const supabase = getSupabaseClient();
  
  while (true) {
    // Find configs with old version
    const { data: oldConfigs } = await supabase
      .from("bucket_configs")
      .select("*")
      .lt("encryption_key_version", CURRENT_VERSION)
      .limit(10); // Small batches
    
    if (!oldConfigs || oldConfigs.length === 0) {
      console.log("✅ All configs migrated to latest version");
      break;
    }
    
    for (const config of oldConfigs) {
      try {
        // Decrypt with old version
        const plaintext = await decryptSecretVersioned(config.secret_access_key);
        
        // Re-encrypt with new version
        const newCiphertext = await encryptSecretVersioned(plaintext);
        
        // Update
        await supabase
          .from("bucket_configs")
          .update({
            secret_access_key: newCiphertext,
            encryption_key_version: CURRENT_VERSION,
          })
          .eq("id", config.id);
        
        console.log(`✅ Migrated ${config.id} to v${CURRENT_VERSION}`);
      } catch (err) {
        console.error(`❌ Failed to migrate ${config.id}:`, err);
      }
    }
    
    // Rate limit
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}
```

**Benefits**:
- ✅ **Zero user impact**: Happens transparently in background
- ✅ **Gradual migration**: No downtime, no rush
- ✅ **Rollback safety**: Can keep old key active during migration
- ✅ **Future-proof**: Easy to rotate keys again

**When to use**: 
- Production systems with users
- When you need to rotate keys for security
- When you want zero-downtime key changes

### ✅ Level 3: Emergency Key Recovery (Better than Reset)

**If you suspect key mismatch but have access to production database.**

#### Option A: Extract and Try to Crack

```typescript
// scripts/try-common-key-patterns.ts
/**
 * If you know the key was generated a certain way,
 * try variations to find it
 */
async function tryKeyPatterns() {
  const supabase = getSupabaseClient();
  const { data } = await supabase
    .from("bucket_configs")
    .select("secret_access_key")
    .limit(1)
    .single();
  
  if (!data) return;
  
  // Common patterns if key was generated with openssl
  const patterns = [
    // Try environment variable names that might have been used
    process.env.ENCRYPTION_KEY,
    process.env.SECRET_KEY,
    process.env.MASTER_KEY,
    
    // Try with/without whitespace (common copy-paste issue)
    process.env.ENCRYPTION_KEY?.trim(),
    process.env.ENCRYPTION_KEY?.replace(/\s/g, ''),
    
    // Try base64 decode/encode variations (common mistake)
    Buffer.from(process.env.ENCRYPTION_KEY || '', 'base64').toString('utf-8'),
    
    // Try if key was accidentally double-encoded
    // ... etc
  ];
  
  for (const candidate of patterns) {
    if (!candidate) continue;
    try {
      process.env.ENCRYPTION_KEY = candidate;
      await decryptSecret(data.secret_access_key);
      console.log(`✅ FOUND IT: ${candidate.substring(0, 20)}...`);
      return candidate;
    } catch {
      // Keep trying
    }
  }
}
```

#### Option B: Check Git History

```bash
# Search git history for the key (in case it was accidentally committed)
git log -p -S "ENCRYPTION_KEY" --all

# Check if it was in env files that were later gitignored
git log -p --all -- .env .env.local .env.production

# Check GitHub Actions logs (might contain key in debug output)
gh run list --limit 50
gh run view <run-id> --log
```

#### Option C: Contact Previous Team Members

```bash
# They might have it in their .env.local
# Ask them to run:
grep ENCRYPTION_KEY ~/.env.local
# Or wherever they keep project env files
```

### ❌ Level 4: Reset (Last Resort Only)

**Only when all recovery attempts fail.**

#### User Communication Template:

```markdown
Subject: Important: S3 Bucket Re-configuration Required

Hi [User],

We encountered a critical security issue that required us to rotate our 
encryption keys to protect your data.

**What this means for you:**
You'll need to re-add your S3 bucket configurations. This is a one-time 
process that takes about 2 minutes per bucket.

**What's NOT affected:**
✅ Your actual files in S3 (untouched)
✅ Your account and settings
✅ Event history and enrichments

**What you need to do:**
1. Log in to https://your-app.vercel.app/buckets
2. Click "Add Bucket" for each of your S3 buckets
3. Enter your S3 credentials (you can find these in your S3 provider dashboard)

**Why this happened:**
We take security seriously. This was a proactive measure to ensure your 
S3 credentials remain protected.

**Compensation:**
As an apology for the inconvenience, we're extending your plan by 1 month 
free of charge.

Need help? Reply to this email or contact support@...

Thanks for your understanding,
[Your Team]
```

#### Gradual Rollout:

```typescript
// Don't reset everyone at once
// Reset in phases, helping users through it

// Phase 1: Internal users (test support process)
await resetBucketConfigsForUsers(['internal-user-1', 'internal-user-2']);

// Phase 2: Power users (those who can handle it)
await resetBucketConfigsForUsers(powerUsers);

// Phase 3: Everyone else
await resetBucketConfigsForUsers(allUsers);
```

## Recommended Implementation Priority

### Immediate (Do Today):

1. **Backup current key to 1Password/Vault**
   ```bash
   op item create --category=password \
     --title="sitemgr-encryption-key-backup" \
     password="$(grep ENCRYPTION_KEY .env.local | cut -d= -f2)"
   ```

2. **Document key location in RUNBOOK.md**

3. **Add key to GitHub Secrets (for disaster recovery)**
   ```bash
   gh secret set ENCRYPTION_KEY_BACKUP --body "$ENCRYPTION_KEY"
   ```

### Short-term (This Sprint):

1. **Implement key versioning**
   - Add `encryption_key_version` column
   - Update encrypt/decrypt functions
   - Support v1 (current) and v2 (future)

2. **Add monitoring for decryption failures**
   ```typescript
   Sentry.captureException(decryptionError, {
     tags: { 
       severity: 'critical',
       type: 'encryption_key_issue' 
     }
   });
   ```

### Long-term (Next Quarter):

1. **Automated key rotation**
   - Background migration job
   - Scheduled key rotations (every 90 days)
   - Audit log of key changes

2. **HSM/KMS integration** (for enterprise)
   - AWS KMS
   - HashiCorp Vault
   - Azure Key Vault

## Summary: Priority Order

1. 🥇 **Prevention**: Never lose the key (backup, document)
2. 🥈 **Recovery**: Use versioning + background migration
3. 🥉 **Last Resort**: Reset with excellent user communication

**Never start with #3.**

