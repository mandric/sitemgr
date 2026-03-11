/**
 * Diagnose production encryption state
 *
 * This script checks:
 * 1. How many bucket configs exist
 * 2. Which encryption keys can decrypt them
 * 3. What action to take
 *
 * Usage:
 *   ENCRYPTION_KEY=<key1> \
 *   ENCRYPTION_KEY_CANDIDATE_2=<key2> \
 *   ENCRYPTION_KEY_CANDIDATE_3=<key3> \
 *   PRODUCTION_DB_URL=<postgres-url> \
 *   npx tsx scripts/diagnose-production-encryption.ts
 */

import { createClient } from "@supabase/supabase-js";
import { decryptSecret } from "../lib/crypto/encryption";

const PRODUCTION_DB_URL = process.env.PRODUCTION_DB_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const PRODUCTION_DB_KEY = process.env.PRODUCTION_DB_KEY || process.env.SUPABASE_SECRET_KEY;

async function diagnose() {
  console.log("🔍 Production Encryption Diagnosis\n");

  if (!PRODUCTION_DB_URL || !PRODUCTION_DB_KEY) {
    console.error("❌ Missing PRODUCTION_DB_URL or PRODUCTION_DB_KEY");
    console.log("\nSet environment variables:");
    console.log("  PRODUCTION_DB_URL or NEXT_PUBLIC_SUPABASE_URL");
    console.log("  PRODUCTION_DB_KEY or SUPABASE_SECRET_KEY");
    process.exit(1);
  }

  // Collect all candidate keys to try
  const candidateKeys = [
    { name: "ENCRYPTION_KEY (current)", value: process.env.ENCRYPTION_KEY },
    { name: "ENCRYPTION_KEY_V1", value: process.env.ENCRYPTION_KEY_V1 },
    { name: "ENCRYPTION_KEY_V2", value: process.env.ENCRYPTION_KEY_V2 },
    { name: "CANDIDATE_2", value: process.env.ENCRYPTION_KEY_CANDIDATE_2 },
    { name: "CANDIDATE_3", value: process.env.ENCRYPTION_KEY_CANDIDATE_3 },
  ].filter(k => k.value); // Only keys that are set

  if (candidateKeys.length === 0) {
    console.error("❌ No encryption keys provided to test");
    console.log("\nSet at least one:");
    console.log("  ENCRYPTION_KEY");
    console.log("  ENCRYPTION_KEY_V1");
    console.log("  ENCRYPTION_KEY_V2");
    process.exit(1);
  }

  console.log(`🔑 Testing ${candidateKeys.length} candidate key(s):`);
  candidateKeys.forEach((k, i) => {
    console.log(`   ${i + 1}. ${k.name}: ${k.value?.substring(0, 20)}...`);
  });

  // Fetch bucket configs from production
  const supabase = createClient(PRODUCTION_DB_URL, PRODUCTION_DB_KEY);

  console.log("\n📊 Fetching bucket configs from production...");
  const { data: configs, error } = await supabase
    .from("bucket_configs")
    .select("id, phone_number, user_id, bucket_name, secret_access_key");

  if (error) {
    console.error("❌ Database error:", error);
    process.exit(1);
  }

  if (!configs || configs.length === 0) {
    console.log("✅ No bucket configs found in production.");
    console.log("   You can use any key - no existing data to worry about!");
    process.exit(0);
  }

  console.log(`   Found ${configs.length} bucket config(s)\n`);

  // Test each config against each key
  const results: {
    configId: string;
    bucketName: string;
    workingKeys: string[];
    encrypted: string;
  }[] = [];

  for (const config of configs) {
    const identifier = config.phone_number || config.user_id || config.id;
    console.log(`Testing "${config.bucket_name}" (${identifier}):`);

    const workingKeys: string[] = [];

    for (const { name, value } of candidateKeys) {
      if (!value) continue;

      try {
        process.env.ENCRYPTION_KEY = value;
        await decryptSecret(config.secret_access_key);
        workingKeys.push(name);
        console.log(`   ✅ ${name} - CAN decrypt`);
      } catch {
        console.log(`   ❌ ${name} - CANNOT decrypt`);
      }
    }

    results.push({
      configId: config.id,
      bucketName: config.bucket_name,
      workingKeys,
      encrypted: config.secret_access_key.substring(0, 30) + "...",
    });

    console.log();
  }

  // Analyze results
  console.log("═".repeat(60));
  console.log("📊 Analysis\n");

  const allDecryptable = results.filter(r => r.workingKeys.length > 0);
  const noneDecryptable = results.filter(r => r.workingKeys.length === 0);
  const multipleKeys = results.filter(r => r.workingKeys.length > 1);

  console.log(`Total configs: ${results.length}`);
  console.log(`Can decrypt: ${allDecryptable.length}`);
  console.log(`CANNOT decrypt: ${noneDecryptable.length}`);
  console.log(`Multiple keys work: ${multipleKeys.length}`);

  if (noneDecryptable.length > 0) {
    console.log("\n❌ UNRECOVERABLE DATA:");
    noneDecryptable.forEach(r => {
      console.log(`   • ${r.bucketName} (${r.configId})`);
    });
    console.log("\n⚠️  These configs are encrypted with a key you don't have.");
    console.log("   Options:");
    console.log("   1. Try more candidate keys (OLD_KEY, BACKUP_KEY, etc.)");
    console.log("   2. Delete these configs (data loss)");
    console.log("   3. Ask users to re-add these buckets");
  }

  if (allDecryptable.length > 0) {
    console.log("\n✅ RECOVERABLE DATA:");

    // Find the key that works for ALL decryptable configs
    const keyThatWorksForAll = candidateKeys.find(({ name }) =>
      allDecryptable.every(r => r.workingKeys.includes(name))
    );

    if (keyThatWorksForAll) {
      console.log(`\n🎯 KEY THAT WORKS FOR ALL: ${keyThatWorksForAll.name}`);
      console.log(`   Value: ${keyThatWorksForAll.value?.substring(0, 30)}...`);
      console.log("\n💡 RECOMMENDED ACTION:");
      console.log(`   1. Set ENCRYPTION_KEY_V1=${keyThatWorksForAll.name} in Vercel`);
      console.log(`   2. Set ENCRYPTION_KEY_V2=<new-key> in Vercel (or same key)`);
      console.log(`   3. Set ENCRYPTION_KEY=<same-as-V2> in Vercel`);
      console.log(`   4. Deploy - lazy migration will handle the rest`);
    } else {
      console.log("\n⚠️  Different configs need different keys:");
      allDecryptable.forEach(r => {
        console.log(`   • ${r.bucketName}: ${r.workingKeys.join(", ")}`);
      });
      console.log("\n💡 RECOMMENDED ACTION:");
      console.log("   Run migration script to re-encrypt ALL with one key");
    }
  }

  if (noneDecryptable.length > 0) {
    console.log("\n💡 FOR UNRECOVERABLE DATA:");
    console.log("   Option A: Delete and notify users");
    console.log("   DELETE FROM bucket_configs WHERE id IN (...)");
    console.log("\n   Option B: Try to find the old key");
    console.log("   - Check .env.local backups");
    console.log("   - Check GitHub Actions history");
    console.log("   - Check Vercel deployment logs");
    console.log("   - Ask team members for their .env files");
  }

  console.log("\n" + "═".repeat(60));

  // Exit with error code if data is unrecoverable
  process.exit(noneDecryptable.length > 0 ? 1 : 0);
}

diagnose().catch((err) => {
  console.error("\n💥 Error:", err);
  process.exit(1);
});
