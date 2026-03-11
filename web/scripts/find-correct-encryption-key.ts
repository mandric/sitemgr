/**
 * Script to test multiple encryption keys and find which one works
 *
 * Usage:
 *   # Edit the CANDIDATE_KEYS array below with your keys to test
 *   npx tsx scripts/find-correct-encryption-key.ts
 *
 * Or pass keys as arguments:
 *   npx tsx scripts/find-correct-encryption-key.ts "key1" "key2" "key3"
 */

import { createClient } from "@supabase/supabase-js";
import { decryptSecret } from "../lib/crypto/encryption";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "http://127.0.0.1:54321";
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

// Add your candidate keys here, or pass them as command-line arguments
const CANDIDATE_KEYS: string[] = [
  // Add keys to test, e.g.:
  // "key-from-production-backup",
  // "key-from-staging",
  // "key-from-.env.local",
];

async function findCorrectKey() {
  console.log("🔍 Finding the correct encryption key...\n");

  // Use command-line args if provided
  const keysToTest = process.argv.slice(2).length > 0
    ? process.argv.slice(2)
    : CANDIDATE_KEYS;

  if (keysToTest.length === 0) {
    console.error("❌ No keys to test!");
    console.log("\nUsage:");
    console.log("  1. Edit this script and add keys to CANDIDATE_KEYS array");
    console.log("  2. Or pass keys as arguments:");
    console.log("     npx tsx scripts/find-correct-encryption-key.ts \"key1\" \"key2\"");
    process.exit(1);
  }

  console.log(`Testing ${keysToTest.length} candidate key(s)...\n`);

  // Fetch a sample encrypted value
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  const { data: configs, error } = await supabase
    .from("bucket_configs")
    .select("id, bucket_name, secret_access_key")
    .limit(5);

  if (error) {
    console.error("❌ Database error:", error);
    process.exit(1);
  }

  if (!configs || configs.length === 0) {
    console.log("⚠️  No bucket configs found in database.");
    console.log("   Cannot test keys without encrypted data.");
    console.log("   Add a bucket config first, then run this script.");
    process.exit(0);
  }

  console.log(`Found ${configs.length} bucket config(s) to test against\n`);

  // Test each key
  const results: { key: string; successes: number; failures: number }[] = [];

  for (let i = 0; i < keysToTest.length; i++) {
    const key = keysToTest[i];
    const keyPreview = key.substring(0, 20) + "...";
    console.log(`Testing key ${i + 1}/${keysToTest.length}: ${keyPreview}`);

    let successes = 0;
    let failures = 0;

    for (const config of configs) {
      try {
        process.env.ENCRYPTION_KEY = key;
        await decryptSecret(config.secret_access_key);
        successes++;
      } catch {
        failures++;
      }
    }

    results.push({ key, successes, failures });

    if (successes === configs.length) {
      console.log(`   ✅ SUCCESS! This key decrypted ${successes}/${configs.length} configs`);
    } else if (successes > 0) {
      console.log(`   ⚠️  Partial: ${successes} successes, ${failures} failures`);
    } else {
      console.log(`   ❌ Failed: Could not decrypt any configs with this key`);
    }
    console.log();
  }

  // Summary
  console.log("━".repeat(60));
  console.log("📊 Summary\n");

  const winners = results.filter((r) => r.successes === configs.length);
  const partial = results.filter((r) => r.successes > 0 && r.successes < configs.length);
  const losers = results.filter((r) => r.successes === 0);

  if (winners.length > 0) {
    console.log("✅ Working key(s) (decrypt all configs):");
    winners.forEach((r) => {
      console.log(`   ${r.key.substring(0, 40)}...`);
    });
    console.log("\n🎉 Use this key in your ENCRYPTION_KEY environment variable!");

    if (winners.length > 1) {
      console.log("\n⚠️  Note: Multiple keys work. They might be the same or you have");
      console.log("   configs encrypted with different keys (key rotation in progress?)");
    }
  } else {
    console.log("❌ No key successfully decrypted all configs");
  }

  if (partial.length > 0) {
    console.log("\n⚠️  Partial success (some configs decrypted):");
    partial.forEach((r) => {
      console.log(`   ${r.key.substring(0, 40)}... (${r.successes}/${configs.length} configs)`);
    });
    console.log("\n   This suggests you have a mix of keys. Run the migration script:");
    console.log("   OLD_ENCRYPTION_KEY=<partial-key> NEW_ENCRYPTION_KEY=<new-key> \\");
    console.log("   npx tsx scripts/migrate-encryption-key.ts");
  }

  if (losers.length > 0 && winners.length === 0 && partial.length === 0) {
    console.log("❌ None of the candidate keys work");
    console.log("\n💡 Next steps:");
    console.log("   1. Check backup/staging environments for the key");
    console.log("   2. Check team password managers (1Password, etc.)");
    console.log("   3. Check deployment logs (Vercel, GitHub Actions)");
    console.log("   4. Check other developers' .env.local files");
    console.log("   5. As last resort, users must re-configure their buckets");
  }
}

findCorrectKey().catch((err) => {
  console.error("\n💥 Error:", err);
  process.exit(1);
});
