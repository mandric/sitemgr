/**
 * Diagnostic script for bucket config issues
 * Tests both WhatsApp (phone_number) and Web (user_id) flows
 *
 * Run with: npx tsx scripts/diagnose-bucket-issue.ts
 */

import { createClient } from "@supabase/supabase-js";
import { encryptSecret, decryptSecret } from "../lib/crypto/encryption";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "http://127.0.0.1:54321";
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

async function diagnose() {
  console.log("🔍 Diagnosing bucket config issue...\n");

  if (!process.env.ENCRYPTION_KEY) {
    console.error("❌ ENCRYPTION_KEY not set");
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  console.log("📊 Environment:");
  console.log(`   Supabase URL: ${SUPABASE_URL}`);
  console.log(`   ENCRYPTION_KEY: ${process.env.ENCRYPTION_KEY ? "✅ Set" : "❌ Missing"}`);

  // Check existing bucket configs
  console.log("\n📊 Checking existing bucket configs...");
  const { data: allConfigs, error: listError } = await supabase
    .from("bucket_configs")
    .select("id, phone_number, user_id, bucket_name, endpoint_url");

  if (listError) {
    console.error("❌ Error listing configs:", listError);
  } else {
    console.log(`   Found ${allConfigs?.length || 0} bucket config(s)`);
    if (allConfigs && allConfigs.length > 0) {
      allConfigs.forEach((config, i) => {
        console.log(`   ${i + 1}. ${config.bucket_name}`);
        console.log(`      Auth: ${config.phone_number ? `phone=${config.phone_number}` : config.user_id ? `user_id=${config.user_id}` : "NONE!"}`);
        console.log(`      Endpoint: ${config.endpoint_url}`);
      });
    }
  }

  // Test 1: WhatsApp flow (phone_number)
  console.log("\n🧪 Test 1: WhatsApp Flow (phone_number)");
  const testPhone = "whatsapp:+1234567890";
  const whatsappBucket = `test-whatsapp-${Date.now()}`;

  try {
    const secret = "test-secret-whatsapp-123";
    const encrypted = await encryptSecret(secret);

    const { data: whatsappData, error: whatsappError } = await supabase
      .from("bucket_configs")
      .insert({
        phone_number: testPhone,
        bucket_name: whatsappBucket,
        endpoint_url: "https://s3.example.com",
        access_key_id: "AKID_WHATSAPP",
        secret_access_key: encrypted,
      })
      .select()
      .single();

    if (whatsappError) {
      console.error("   ❌ Insert failed:", whatsappError.message);
    } else {
      console.log(`   ✅ Inserted: ${whatsappData.id}`);

      // Try to read it back
      const { data: readBack, error: readError } = await supabase
        .from("bucket_configs")
        .select("*")
        .eq("phone_number", testPhone)
        .eq("bucket_name", whatsappBucket)
        .maybeSingle();

      if (readError || !readBack) {
        console.error("   ❌ Read back failed:", readError?.message || "No data");
      } else {
        console.log(`   ✅ Read back successful`);
        const decrypted = await decryptSecret(readBack.secret_access_key);
        console.log(`   ✅ Decryption: ${decrypted === secret ? "PASS" : "FAIL"}`);
      }

      // Cleanup
      await supabase.from("bucket_configs").delete().eq("id", whatsappData.id);
    }
  } catch (err) {
    console.error("   💥 Error:", err instanceof Error ? err.message : err);
  }

  // Test 2: Web UI flow (user_id)
  console.log("\n🧪 Test 2: Web UI Flow (user_id)");

  // First, create a test user
  console.log("   Creating test user...");
  const { data: authData, error: authError } = await supabase.auth.signUp({
    email: `test-${Date.now()}@example.com`,
    password: "test-password-123456",
  });

  if (authError || !authData.user) {
    console.error("   ❌ User creation failed:", authError?.message);
  } else {
    const userId = authData.user.id;
    console.log(`   ✅ Created user: ${userId}`);

    const webBucket = `test-web-${Date.now()}`;

    try {
      const secret = "test-secret-web-456";
      const encrypted = await encryptSecret(secret);

      const { data: webData, error: webError } = await supabase
        .from("bucket_configs")
        .insert({
          user_id: userId,
          bucket_name: webBucket,
          endpoint_url: "https://s3.example.com",
          access_key_id: "AKID_WEB",
          secret_access_key: encrypted,
        })
        .select()
        .single();

      if (webError) {
        console.error("   ❌ Insert failed:", webError.message);
      } else {
        console.log(`   ✅ Inserted: ${webData.id}`);

        // Try to read it back (as web UI would)
        const { data: readBack, error: readError } = await supabase
          .from("bucket_configs")
          .select("*")
          .eq("user_id", userId)
          .eq("bucket_name", webBucket)
          .maybeSingle();

        if (readError || !readBack) {
          console.error("   ❌ Read back failed:", readError?.message || "No data");
        } else {
          console.log(`   ✅ Read back successful`);
          const decrypted = await decryptSecret(readBack.secret_access_key);
          console.log(`   ✅ Decryption: ${decrypted === secret ? "PASS" : "FAIL"}`);
        }

        // Cleanup
        await supabase.from("bucket_configs").delete().eq("id", webData.id);
      }
    } catch (err) {
      console.error("   💥 Error:", err instanceof Error ? err.message : err);
    }

    // Cleanup user
    await supabase.auth.admin.deleteUser(userId);
  }

  console.log("\n✅ Diagnosis complete!");
  console.log("\n💡 What to check if you're having issues:");
  console.log("   1. ENCRYPTION_KEY must be the same in all environments");
  console.log("   2. Web UI queries by user_id (requires logged in user)");
  console.log("   3. WhatsApp queries by phone_number");
  console.log("   4. Check that migrations have run: supabase db push");
  console.log("   5. In production, check Vercel env vars match .env.production");
}

diagnose().catch(console.error);
