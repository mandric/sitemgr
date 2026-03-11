/**
 * Background migration script for encryption key rotation
 *
 * This script gradually re-encrypts bucket configs from old key versions
 * to the current version, without blocking users or requiring downtime.
 *
 * Features:
 * - Runs in batches (gentle on database)
 * - Rate-limited (doesn't overwhelm system)
 * - Resumable (can stop and restart)
 * - Progress tracking
 *
 * Usage:
 *   # Dry run (see what would be migrated)
 *   ENCRYPTION_KEY_V1=<old> ENCRYPTION_KEY_V2=<new> \
 *   npx tsx scripts/background-migrate-encryption-version.ts
 *
 *   # Actually migrate
 *   ENCRYPTION_KEY_V1=<old> ENCRYPTION_KEY_V2=<new> \
 *   npx tsx scripts/background-migrate-encryption-version.ts --live
 *
 *   # Monitor progress
 *   ENCRYPTION_KEY_V1=<old> ENCRYPTION_KEY_V2=<new> \
 *   npx tsx scripts/background-migrate-encryption-version.ts --status
 */

import { createClient } from "@supabase/supabase-js";
import {
  decryptSecretVersioned,
  encryptSecretVersioned,
  getEncryptionVersion,
  needsMigration,
} from "../lib/crypto/encryption-versioned";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "http://127.0.0.1:54321";
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

const BATCH_SIZE = 10; // Process 10 configs at a time
const DELAY_MS = 1000; // Wait 1 second between batches

interface MigrationStats {
  total: number;
  migrated: number;
  failed: number;
  skipped: number;
  versionDistribution: Record<number, number>;
}

async function showStatus() {
  console.log("📊 Migration Status\n");

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  const { data: configs } = await supabase
    .from("bucket_configs")
    .select("id, encryption_key_version, secret_access_key");

  if (!configs || configs.length === 0) {
    console.log("No bucket configs found.");
    return;
  }

  const stats: MigrationStats = {
    total: configs.length,
    migrated: 0,
    failed: 0,
    skipped: 0,
    versionDistribution: {},
  };

  for (const config of configs) {
    const version = config.encryption_key_version || getEncryptionVersion(config.secret_access_key);
    stats.versionDistribution[version] = (stats.versionDistribution[version] || 0) + 1;
  }

  console.log(`Total configs: ${stats.total}`);
  console.log("\nVersion distribution:");
  Object.entries(stats.versionDistribution)
    .sort(([a], [b]) => parseInt(a) - parseInt(b))
    .forEach(([version, count]) => {
      const percentage = ((count / stats.total) * 100).toFixed(1);
      console.log(`  v${version}: ${count} (${percentage}%)`);
    });

  const needingMigration = configs.filter(c =>
    needsMigration(c.secret_access_key)
  ).length;

  console.log(`\nNeeding migration: ${needingMigration}`);

  if (needingMigration === 0) {
    console.log("✅ All configs are on the current version!");
  } else {
    console.log(`⏳ Progress: ${stats.total - needingMigration}/${stats.total} migrated`);
    const progress = ((stats.total - needingMigration) / stats.total * 100).toFixed(1);
    console.log(`   ${progress}% complete`);
  }
}

async function migrateInBackground(dryRun = true) {
  console.log("🔄 Background Encryption Key Migration\n");
  console.log(`Mode: ${dryRun ? "🧪 DRY RUN" : "⚠️  LIVE"}\n`);

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  let totalProcessed = 0;
  let totalMigrated = 0;
  let totalFailed = 0;
  let totalSkipped = 0;

  while (true) {
    // Fetch batch of configs needing migration
    const { data: configs, error } = await supabase
      .from("bucket_configs")
      .select("id, bucket_name, phone_number, user_id, secret_access_key, encryption_key_version")
      .limit(BATCH_SIZE);

    if (error) {
      console.error("❌ Error fetching configs:", error);
      break;
    }

    if (!configs || configs.length === 0) {
      break;
    }

    // Filter to only those needing migration
    const needingMigration = configs.filter(c => needsMigration(c.secret_access_key));

    if (needingMigration.length === 0) {
      console.log("✅ No more configs need migration");
      break;
    }

    console.log(`\nProcessing batch of ${needingMigration.length} config(s)...`);

    for (const config of needingMigration) {
      const identifier = config.phone_number || config.user_id || config.id;
      const currentVersion = getEncryptionVersion(config.secret_access_key);

      try {
        // Decrypt with old version
        const plaintext = await decryptSecretVersioned(config.secret_access_key);

        // Re-encrypt with new version
        const newCiphertext = await encryptSecretVersioned(plaintext);
        const newVersion = getEncryptionVersion(newCiphertext);

        if (dryRun) {
          console.log(`  [DRY RUN] Would migrate ${config.bucket_name} (${identifier}): v${currentVersion} → v${newVersion}`);
          totalMigrated++;
        } else {
          // Update in database
          const { error: updateError } = await supabase
            .from("bucket_configs")
            .update({
              secret_access_key: newCiphertext,
              encryption_key_version: newVersion,
            })
            .eq("id", config.id);

          if (updateError) {
            console.error(`  ❌ Failed to update ${config.bucket_name}:`, updateError.message);
            totalFailed++;
          } else {
            console.log(`  ✅ Migrated ${config.bucket_name} (${identifier}): v${currentVersion} → v${newVersion}`);
            totalMigrated++;
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`  ❌ Failed ${config.bucket_name} (${identifier}):`, message);
        totalFailed++;
      }

      totalProcessed++;
    }

    // Rate limiting
    if (!dryRun) {
      console.log(`  Waiting ${DELAY_MS}ms...`);
      await new Promise(resolve => setTimeout(resolve, DELAY_MS));
    }

    // Check if we've processed all
    if (needingMigration.length < BATCH_SIZE) {
      break;
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log("📊 Migration Summary\n");
  console.log(`Total processed: ${totalProcessed}`);
  console.log(`Successfully migrated: ${totalMigrated}`);
  console.log(`Failed: ${totalFailed}`);
  console.log(`Skipped: ${totalSkipped}`);

  if (dryRun) {
    console.log("\n🧪 DRY RUN - No changes made");
    console.log("\nTo perform migration, run:");
    console.log("  ENCRYPTION_KEY_V1=<old> ENCRYPTION_KEY_V2=<new> \\");
    console.log("  npx tsx scripts/background-migrate-encryption-version.ts --live");
  } else if (totalFailed === 0) {
    console.log("\n✅ Migration complete!");
    console.log("\nNext steps:");
    console.log("  1. Verify all configs can be decrypted");
    console.log("  2. Remove old encryption key environment variable (ENCRYPTION_KEY_V1)");
    console.log("  3. Monitor for any decryption errors");
  } else {
    console.log("\n⚠️  Migration completed with errors");
    console.log("  Investigate failed configs before removing old key");
  }
}

// Parse command line args
const mode = process.argv[2];

if (mode === "--status") {
  showStatus().catch(console.error);
} else {
  const dryRun = mode !== "--live";
  migrateInBackground(dryRun).catch(console.error);
}
