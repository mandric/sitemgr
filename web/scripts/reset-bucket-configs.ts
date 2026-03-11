/**
 * Nuclear option: Clear all bucket configs when encryption key is lost
 *
 * ⚠️  WARNING: This DELETES all bucket configurations!
 * Users will need to re-add their buckets manually.
 *
 * Only use this when:
 * 1. The encryption key is permanently lost
 * 2. You cannot recover the old key
 * 3. Users are willing to re-configure their buckets
 *
 * Usage:
 *   # Dry run first
 *   npx tsx scripts/reset-bucket-configs.ts
 *
 *   # Actually delete (requires --confirm flag)
 *   npx tsx scripts/reset-bucket-configs.ts --confirm
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "http://127.0.0.1:54321";
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

async function resetBucketConfigs(confirm = false) {
  console.log("🚨 BUCKET CONFIG RESET SCRIPT 🚨\n");

  if (!confirm) {
    console.log("⚠️  DRY RUN MODE - No changes will be made\n");
  } else {
    console.log("⚠️  LIVE MODE - This will DELETE data!\n");
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  // Step 1: Count existing configs
  console.log("📊 Step 1: Checking existing bucket configs...");
  const { data: configs, error: countError } = await supabase
    .from("bucket_configs")
    .select("id, phone_number, user_id, bucket_name");

  if (countError) {
    console.error("❌ Error:", countError);
    process.exit(1);
  }

  if (!configs || configs.length === 0) {
    console.log("✅ No bucket configs found. Nothing to delete.");
    return;
  }

  console.log(`Found ${configs.length} bucket config(s):\n`);
  configs.forEach((config, i) => {
    const identifier = config.phone_number || config.user_id || "unknown";
    console.log(`   ${i + 1}. ${config.bucket_name} (${identifier})`);
  });

  // Step 2: Show impact
  console.log("\n📊 Step 2: Checking impact...");

  // Check how many events reference these buckets
  const { data: events, error: eventsError } = await supabase
    .from("events")
    .select("id, bucket_config_id")
    .not("bucket_config_id", "is", null);

  if (!eventsError && events) {
    console.log(`   ⚠️  ${events.length} event(s) reference bucket configs`);
    console.log("      (These will lose their bucket_config_id reference)");
  }

  // Check watched_keys
  const { data: watchedKeys, error: keysError } = await supabase
    .from("watched_keys")
    .select("id, bucket_config_id")
    .not("bucket_config_id", "is", null);

  if (!keysError && watchedKeys) {
    console.log(`   ⚠️  ${watchedKeys.length} watched key(s) reference bucket configs`);
    console.log("      (These will be deleted due to CASCADE)");
  }

  // Step 3: Delete or show dry-run message
  if (!confirm) {
    console.log("\n🧪 DRY RUN - No changes made");
    console.log("\nTo actually delete these configs, run:");
    console.log("   npx tsx scripts/reset-bucket-configs.ts --confirm");
    console.log("\n⚠️  After deletion:");
    console.log("   1. Users must re-add buckets via Web UI (/buckets) or WhatsApp");
    console.log("   2. Events will keep their data but lose bucket_config_id reference");
    console.log("   3. Watched keys will be deleted (CASCADE)");
    return;
  }

  console.log("\n⚠️  You are about to DELETE all bucket configs!");
  console.log("Press Ctrl+C within 10 seconds to abort...");
  await new Promise((resolve) => setTimeout(resolve, 10000));

  console.log("\n💾 Step 3: Deleting bucket configs...");
  const { error: deleteError } = await supabase
    .from("bucket_configs")
    .delete()
    .neq("id", "00000000-0000-0000-0000-000000000000"); // Delete all

  if (deleteError) {
    console.error("❌ Delete failed:", deleteError);
    process.exit(1);
  }

  console.log("✅ Deleted all bucket configs");

  // Step 4: Verify
  const { data: remaining } = await supabase
    .from("bucket_configs")
    .select("id");

  console.log(`\n📊 Step 4: Verification`);
  console.log(`   Remaining configs: ${remaining?.length || 0}`);

  if ((remaining?.length || 0) === 0) {
    console.log("\n✅ Reset complete!");
    console.log("\n📝 Next steps:");
    console.log("   1. Generate a NEW encryption key:");
    console.log("      openssl rand -base64 32");
    console.log("   2. Set it in all environments:");
    console.log("      - .env.local");
    console.log("      - Vercel production env vars");
    console.log("   3. Notify users to re-configure their buckets");
    console.log("   4. Users can add buckets via:");
    console.log("      - Web UI: https://your-app.vercel.app/buckets");
    console.log("      - WhatsApp: Send 'add bucket' message");
  } else {
    console.log("\n⚠️  Warning: Some configs still remain!");
  }
}

const confirm = process.argv.includes("--confirm");
resetBucketConfigs(confirm).catch((err) => {
  console.error("\n💥 Error:", err);
  process.exit(1);
});
