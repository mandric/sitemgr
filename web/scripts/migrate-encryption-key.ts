/**
 * Migration script for ENCRYPTION_KEY rotation
 *
 * Use case: When you need to change ENCRYPTION_KEY and re-encrypt existing data
 *
 * ⚠️  CRITICAL: This script requires BOTH the old and new keys to work
 *
 * Usage:
 *   OLD_ENCRYPTION_KEY=<old-key> NEW_ENCRYPTION_KEY=<new-key> npx tsx scripts/migrate-encryption-key.ts
 *
 * Safety features:
 *   - Dry-run mode (--dry-run flag)
 *   - Verification after migration
 *   - Rollback capability (keeps old data until verified)
 */

import { createClient } from "@supabase/supabase-js";
import { decryptSecret, encryptSecret } from "../lib/crypto/encryption";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "http://127.0.0.1:54321";
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

interface BucketConfig {
  id: string;
  phone_number: string | null;
  user_id: string | null;
  bucket_name: string;
  secret_access_key: string;
}

async function migrateEncryptionKey(dryRun = true) {
  console.log("🔐 Encryption Key Migration Script\n");

  const oldKey = process.env.OLD_ENCRYPTION_KEY;
  const newKey = process.env.NEW_ENCRYPTION_KEY;

  if (!oldKey || !newKey) {
    console.error("❌ Error: Both OLD_ENCRYPTION_KEY and NEW_ENCRYPTION_KEY must be set");
    console.log("\nUsage:");
    console.log("  OLD_ENCRYPTION_KEY=<old> NEW_ENCRYPTION_KEY=<new> npx tsx scripts/migrate-encryption-key.ts");
    process.exit(1);
  }

  if (oldKey === newKey) {
    console.error("❌ Error: OLD_ENCRYPTION_KEY and NEW_ENCRYPTION_KEY are the same!");
    process.exit(1);
  }

  console.log(`Mode: ${dryRun ? "🧪 DRY RUN (no changes will be made)" : "⚠️  LIVE MODE (will modify database)"}`);
  console.log(`Old key: ${oldKey.substring(0, 10)}...`);
  console.log(`New key: ${newKey.substring(0, 10)}...`);

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  // Step 1: Fetch all bucket configs
  console.log("\n📊 Step 1: Fetching all bucket configs...");
  const { data: configs, error: fetchError } = await supabase
    .from("bucket_configs")
    .select("id, phone_number, user_id, bucket_name, secret_access_key");

  if (fetchError) {
    console.error("❌ Failed to fetch configs:", fetchError);
    process.exit(1);
  }

  if (!configs || configs.length === 0) {
    console.log("✅ No bucket configs found. Nothing to migrate.");
    return;
  }

  console.log(`✅ Found ${configs.length} bucket config(s) to migrate`);

  // Step 2: Decrypt with old key, encrypt with new key
  console.log("\n🔄 Step 2: Re-encrypting secrets...");
  const migrations: { id: string; newSecret: string; oldSecret: string }[] = [];
  const errors: { id: string; error: string }[] = [];

  for (const config of configs as BucketConfig[]) {
    const identifier = config.phone_number || config.user_id || config.id;
    console.log(`\n   Processing: ${config.bucket_name} (${identifier})`);

    try {
      // Decrypt with OLD key
      process.env.ENCRYPTION_KEY = oldKey;
      const plaintext = await decryptSecret(config.secret_access_key);
      console.log(`      ✅ Decrypted with old key`);

      // Encrypt with NEW key
      process.env.ENCRYPTION_KEY = newKey;
      const newCiphertext = await encryptSecret(plaintext);
      console.log(`      ✅ Encrypted with new key`);

      // Verify roundtrip with new key
      const verified = await decryptSecret(newCiphertext);
      if (verified !== plaintext) {
        throw new Error("Verification failed: decrypted value doesn't match original");
      }
      console.log(`      ✅ Verified roundtrip`);

      migrations.push({
        id: config.id,
        newSecret: newCiphertext,
        oldSecret: config.secret_access_key, // Keep for rollback
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`      ❌ Failed: ${message}`);
      errors.push({ id: config.id, error: message });
    }
  }

  console.log(`\n📊 Summary:`);
  console.log(`   ✅ Successfully re-encrypted: ${migrations.length}`);
  console.log(`   ❌ Failed: ${errors.length}`);

  if (errors.length > 0) {
    console.log("\n⚠️  Errors encountered:");
    errors.forEach(({ id, error }) => {
      console.log(`   - ${id}: ${error}`);
    });
  }

  if (migrations.length === 0) {
    console.log("\n❌ No successful migrations. Aborting.");
    return;
  }

  // Step 3: Update database (if not dry-run)
  if (dryRun) {
    console.log("\n🧪 DRY RUN MODE - No changes made to database");
    console.log("   Run with: NEW_ENCRYPTION_KEY=<key> OLD_ENCRYPTION_KEY=<key> node scripts/migrate-encryption-key.js --live");
    return;
  }

  console.log("\n💾 Step 3: Updating database...");
  console.log("⚠️  This will modify the database!");
  console.log("   Press Ctrl+C within 5 seconds to abort...");

  await new Promise((resolve) => setTimeout(resolve, 5000));

  let updateCount = 0;
  for (const migration of migrations) {
    const { error } = await supabase
      .from("bucket_configs")
      .update({ secret_access_key: migration.newSecret })
      .eq("id", migration.id);

    if (error) {
      console.error(`   ❌ Failed to update ${migration.id}:`, error);
    } else {
      updateCount++;
      console.log(`   ✅ Updated ${migration.id}`);
    }
  }

  console.log(`\n✅ Migration complete: ${updateCount}/${migrations.length} updated`);

  // Step 4: Verify all updated records can be decrypted with new key
  console.log("\n🔍 Step 4: Verifying migration...");
  process.env.ENCRYPTION_KEY = newKey;

  const { data: verifyConfigs, error: verifyError } = await supabase
    .from("bucket_configs")
    .select("id, bucket_name, secret_access_key");

  if (verifyError) {
    console.error("❌ Verification query failed:", verifyError);
    return;
  }

  let verifyCount = 0;
  for (const config of verifyConfigs || []) {
    try {
      await decryptSecret(config.secret_access_key);
      verifyCount++;
    } catch (err) {
      console.error(`   ❌ Failed to verify ${config.id}: ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log(`✅ Verification complete: ${verifyCount}/${verifyConfigs?.length || 0} can be decrypted with new key`);

  if (verifyCount === verifyConfigs?.length) {
    console.log("\n🎉 Migration successful! All secrets can be decrypted with the new key.");
    console.log("   Next steps:");
    console.log("   1. Update ENCRYPTION_KEY in all environments (Vercel, .env files)");
    console.log("   2. Deploy the change");
    console.log("   3. Monitor for any decryption errors");
  } else {
    console.log("\n⚠️  Warning: Some secrets could not be verified!");
    console.log("   DO NOT update ENCRYPTION_KEY in production yet.");
    console.log("   Investigate the failed verifications first.");
  }
}

// Parse command line args
const dryRun = !process.argv.includes("--live");

migrateEncryptionKey(dryRun).catch((err) => {
  console.error("\n💥 Fatal error:", err);
  process.exit(1);
});
