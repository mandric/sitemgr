# Key Rotation Architecture Comparison

## The Question

Is running a script the best practice for encryption key rotation? What are the alternatives?

## TL;DR

**Best practice depends on your scale and requirements:**

- **Small scale (<1000 configs)**: Script is fine ✅
- **Medium scale (1000-100k configs)**: Background job/worker ✅
- **Large scale (>100k configs)**: Lazy migration pattern ✅✅✅ (RECOMMENDED)
- **Enterprise**: Hardware Security Module (HSM) / KMS ✅✅✅

**For sitemgr**: **Lazy migration** is the best approach (see below).

---

## Option 1: Manual Script (Current Approach)

### How it Works

```bash
# Admin runs a script manually
npx tsx scripts/background-migrate-encryption-version.ts --live
```

### Pros ✅

- **Simple**: Easy to understand and debug
- **Controlled**: Admin decides when to run
- **Observable**: Can monitor progress in terminal
- **Testable**: Easy to test with dry-run
- **No infrastructure**: No background workers needed
- **Resumable**: Can stop and restart

### Cons ❌

- **Manual**: Someone must remember to run it
- **Single-threaded**: Can't parallelize easily
- **Blocking**: Ties up terminal session
- **Error-prone**: Human might forget or make mistakes
- **No scheduling**: Doesn't run automatically
- **Visibility**: Only admin running it sees progress

### When to Use

- One-time migrations
- Small datasets (<10k records)
- Emergency fixes
- Development/testing

### Code Example

```typescript
// scripts/migrate-encryption-key.ts
async function migrate() {
  while (hasMoreRecords()) {
    const batch = await fetchBatch();
    await processBatch(batch);
  }
}

migrate();
```

---

## Option 2: Background Worker/Job Queue

### How it Works

```typescript
// queue/encryption-migration.ts
export async function queueKeyMigration() {
  await jobQueue.add('migrate-encryption-keys', {
    priority: 'low',
    attempts: 3,
  });
}

// workers/encryption-migration-worker.ts
jobQueue.process('migrate-encryption-keys', async (job) => {
  await migrateInBatches(job.data);
});
```

### Pros ✅

- **Automatic**: Runs without human intervention
- **Resilient**: Auto-retry on failures
- **Parallel**: Can run multiple workers
- **Observable**: Dashboard shows progress
- **Scheduled**: Can run at off-peak hours
- **Non-blocking**: Doesn't tie up terminal

### Cons ❌

- **Infrastructure**: Requires job queue (Bull, BullMQ, etc.)
- **Complexity**: More moving parts to maintain
- **Cost**: Additional services to run
- **Debugging**: Harder to debug than script
- **Overhead**: Overkill for small datasets

### When to Use

- Large datasets (>100k records)
- Recurring migrations
- Production systems with job queue infrastructure already
- When you need parallelization

### Code Example

```typescript
// Using BullMQ
import { Queue, Worker } from 'bullmq';

const migrationQueue = new Queue('encryption-migration', {
  connection: redis,
});

// Queue the job
await migrationQueue.add('migrate', {
  batchSize: 100,
});

// Worker processes it
const worker = new Worker('encryption-migration', async (job) => {
  const { batchSize } = job.data;
  
  let offset = 0;
  while (true) {
    const configs = await fetchConfigs(offset, batchSize);
    if (configs.length === 0) break;
    
    await migrateConfigs(configs);
    await job.updateProgress(offset / totalCount * 100);
    offset += batchSize;
  }
});
```

---

## Option 3: Lazy Migration (RECOMMENDED for sitemgr) ✅✅✅

### How it Works

**Migrate on-demand when data is accessed, not in bulk.**

```typescript
// lib/agent/core.ts
async function getBucketConfig(phoneNumber: string, bucketName: string) {
  const { data } = await supabase
    .from("bucket_configs")
    .select("*")
    .eq("phone_number", phoneNumber)
    .eq("bucket_name", bucketName)
    .maybeSingle();

  if (!data) return { exists: false };

  try {
    // Decrypt (supports old and new keys)
    const decrypted = await decryptSecretVersioned(data.secret_access_key);
    
    // 🔑 KEY PART: Lazily re-encrypt if using old version
    if (needsMigration(data.secret_access_key)) {
      const newCiphertext = await encryptSecretVersioned(decrypted);
      
      // Update in background (non-blocking)
      supabase
        .from("bucket_configs")
        .update({
          secret_access_key: newCiphertext,
          encryption_key_version: getEncryptionVersion(newCiphertext),
        })
        .eq("id", data.id)
        .then(() => console.log(`Migrated ${bucketName} to latest key version`))
        .catch(err => console.error(`Migration failed for ${bucketName}:`, err));
    }
    
    return { exists: true, config: { ...data, secret_access_key: decrypted } };
  } catch (err) {
    return { exists: true, error: err };
  }
}
```

### Pros ✅✅✅

- **Zero infrastructure**: No job queue needed
- **Zero admin effort**: Happens automatically
- **Self-healing**: Gradually migrates over time
- **No downtime**: Migrations happen during normal use
- **Prioritizes active data**: Frequently used configs migrate first
- **Safe**: Old key stays active until all data migrated
- **Simple**: Just add a few lines to existing code

### Cons ❌

- **Eventual consistency**: Takes time (depends on usage)
- **Inactive data**: Rarely-used configs stay on old key longer
- **Hidden work**: Migration happens in production requests (small overhead)
- **Unpredictable**: Can't predict completion time

### When to Use ✅

- **Perfect for sitemgr**: Medium scale, cloud-based
- When you don't have job queue infrastructure
- When configs are accessed regularly
- When you want zero operational overhead

### Completion Strategy

**For inactive configs (optional cleanup)**:

```typescript
// scripts/migrate-inactive-configs.ts
// Run this ONCE after lazy migration has been active for a while

async function migrateRemainingOldConfigs() {
  const { data: oldConfigs } = await supabase
    .from("bucket_configs")
    .select("*")
    .lt("encryption_key_version", CURRENT_VERSION)
    .is("last_accessed_at", null) // Never accessed
    .limit(100);
  
  if (!oldConfigs?.length) {
    console.log("All configs migrated! Safe to remove old key.");
    return;
  }
  
  console.log(`Found ${oldConfigs.length} inactive configs, migrating...`);
  // Migrate these manually
}
```

---

## Option 4: Database Trigger (Automatic)

### How it Works

**Database automatically re-encrypts when row is updated.**

```sql
-- PostgreSQL function
CREATE OR REPLACE FUNCTION auto_migrate_encryption_key()
RETURNS TRIGGER AS $$
BEGIN
  -- If encryption_key_version is old, trigger migration
  IF NEW.encryption_key_version < 2 THEN
    -- Notify application to re-encrypt
    PERFORM pg_notify('encryption_migration_needed', NEW.id::text);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER encryption_migration_trigger
  AFTER UPDATE ON bucket_configs
  FOR EACH ROW
  EXECUTE FUNCTION auto_migrate_encryption_key();
```

### Pros ✅

- **Automatic**: Happens on any update
- **Centralized**: Logic in database, not application

### Cons ❌

- **Limited**: Can't decrypt/re-encrypt in SQL (need application)
- **Complex**: Requires NOTIFY/LISTEN architecture
- **Hard to debug**: Logic hidden in database
- **Tight coupling**: Database knows about application encryption

### When to Use

- Rarely. Only if you have strong PL/pgSQL expertise and need centralized control.

**Not recommended for sitemgr.**

---

## Option 5: Cloud Key Management Service (KMS)

### How it Works

**Use AWS KMS, Google Cloud KMS, or Azure Key Vault.**

```typescript
import { KMSClient, EncryptCommand, DecryptCommand } from "@aws-sdk/client-kms";

const kms = new KMSClient({ region: "us-east-1" });

export async function encryptWithKMS(plaintext: string): Promise<string> {
  const command = new EncryptCommand({
    KeyId: "arn:aws:kms:...",
    Plaintext: Buffer.from(plaintext),
  });
  
  const { CiphertextBlob } = await kms.send(command);
  return Buffer.from(CiphertextBlob!).toString("base64");
}

export async function decryptWithKMS(ciphertext: string): Promise<string> {
  const command = new DecryptCommand({
    CiphertextBlob: Buffer.from(ciphertext, "base64"),
  });
  
  const { Plaintext } = await kms.send(command);
  return Buffer.from(Plaintext!).toString("utf-8");
}
```

### Pros ✅✅✅

- **Professional**: Industry-standard solution
- **Key rotation built-in**: KMS handles key versioning automatically
- **Audit trail**: Every encrypt/decrypt logged
- **No key in env vars**: Keys never leave KMS
- **Compliance**: Meets SOC2, HIPAA, etc.
- **Hardware security**: Keys stored in HSM

### Cons ❌

- **Cost**: ~$1/month per key + $0.03 per 10k API calls
- **Latency**: Network call for every encrypt/decrypt (~50-100ms)
- **Complexity**: More setup, IAM permissions, etc.
- **Vendor lock-in**: AWS-specific (unless using envelope encryption)

### When to Use

- Enterprise customers requiring SOC2/HIPAA
- High security requirements
- When you're already on AWS/GCP/Azure
- >$100k ARR product

### Cost Estimate for sitemgr

```
Assumptions:
- 100 users × 3 buckets = 300 configs
- Each accessed 10 times/day = 3,000 decrypt calls/day
- 90,000 calls/month

Cost:
- Key storage: $1/month
- API calls: 90k / 10k × $0.03 = $0.27/month
- Total: ~$1.50/month

✅ Actually pretty cheap!
```

---

## Option 6: Hybrid Approach (Envelope Encryption)

### How it Works

**Combine KMS (for key encryption) with local encryption (for data).**

```typescript
// Use KMS to encrypt a data encryption key (DEK)
// Use DEK to encrypt actual data (fast, local)

// One-time: Generate and encrypt DEK
const dataKey = crypto.randomBytes(32);
const encryptedDEK = await encryptWithKMS(dataKey.toString('base64'));

// Store encrypted DEK in database
await supabase.from("encryption_keys").insert({
  version: 2,
  encrypted_key: encryptedDEK,
});

// To encrypt data: Use DEK (fast, local)
const encrypted = await encryptWithDEK(plaintext, dataKey);

// To decrypt: Decrypt DEK with KMS first, then decrypt data
const dek = await decryptWithKMS(encryptedDEK);
const plaintext = await decryptWithDEK(encrypted, dek);
```

### Pros ✅

- **Fast**: Only KMS call when fetching DEK (can cache)
- **Cheap**: Fewer KMS API calls
- **Secure**: Benefits of KMS without latency cost

### Cons ❌

- **Complex**: Two layers of encryption
- **Caching**: Need to cache DEK (security/performance tradeoff)

### When to Use

- High-throughput systems with KMS
- When latency matters

---

## Recommendation for sitemgr

### Winner: **Lazy Migration (Option 3)** ✅✅✅

**Why?**

1. **Zero infrastructure**: No job queues to run
2. **Zero admin work**: Self-healing
3. **Cloud-based fits model**: Configs accessed via API frequently enough
4. **Simple**: 10 lines of code added to existing function
5. **Safe**: Old key stays until all migrated

### Implementation

```typescript
// lib/agent/core.ts - Add to existing getBucketConfig()

async function getBucketConfig(phoneNumber: string, bucketName: string) {
  // ... existing code ...
  
  try {
    const decrypted = await decryptSecretVersioned(data.secret_access_key);
    
    // 🆕 ADD THIS: Lazy migration
    if (needsMigration(data.secret_access_key)) {
      const newCiphertext = await encryptSecretVersioned(decrypted);
      supabase.from("bucket_configs")
        .update({
          secret_access_key: newCiphertext,
          encryption_key_version: getEncryptionVersion(newCiphertext),
        })
        .eq("id", data.id)
        .then(() => console.log(`✅ Migrated ${bucketName}`))
        .catch(err => console.error(`Migration failed:`, err));
    }
    
    return { exists: true, config: { ...data, secret_access_key: decrypted } };
  } catch (err) {
    return { exists: true, error: err };
  }
}
```

### Future: Consider KMS (Option 5)

**When to add KMS:**
- Raising Series A+
- Enterprise customers asking for SOC2
- Storing more sensitive data
- ARR > $100k

**Cost is reasonable** (~$2/month), but adds complexity that's not needed yet.

---

## Comparison Table

| Approach | Complexity | Cost | User Impact | Best For |
|----------|------------|------|-------------|----------|
| Manual Script | Low | $0 | Zero | One-time, small scale |
| Background Job | High | $$ (infrastructure) | Zero | Large scale, existing queue |
| **Lazy Migration** | **Low** | **$0** | **Zero** | **Medium scale, cloud apps** ✅ |
| DB Trigger | High | $0 | Zero | Rare use cases |
| KMS | Medium | ~$2/mo | Zero | Enterprise, compliance |
| Envelope Encryption | High | ~$2/mo | Zero | High throughput + KMS |

---

## Action Items

### Immediate: Implement Lazy Migration

1. Add `encryption_key_version` column (migration provided)
2. Use `encryption-versioned.ts` in `getBucketConfig()`
3. Add lazy migration logic (10 lines)
4. Deploy

### Short-term: Keep Script for Cleanup

Keep the script for final cleanup of inactive configs after lazy migration has run for a while.

### Long-term: Consider KMS

When you hit enterprise scale or need compliance, migrate to KMS.

---

## Bottom Line

**Scripts are fine for one-off migrations, but lazy migration is better for ongoing key rotation in a cloud app like sitemgr.**

The best solution is often the simplest one that meets your requirements. Don't over-engineer.

