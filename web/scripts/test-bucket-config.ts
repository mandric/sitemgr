/**
 * Test script to verify bucket config creation and retrieval
 * Run with: npx tsx scripts/test-bucket-config.ts
 */

import { encryptSecret, decryptSecret } from "../lib/crypto/encryption";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "http://127.0.0.1:54321";
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

async function testBucketConfig() {
  console.log("🔧 Testing bucket config creation and retrieval...\n");

  // Check encryption key
  if (!process.env.ENCRYPTION_KEY) {
    console.error("❌ ENCRYPTION_KEY environment variable not set!");
    console.log("   Set it in .env.local or run: export ENCRYPTION_KEY=$(openssl rand -base64 32)");
    process.exit(1);
  }

  console.log("✅ ENCRYPTION_KEY is set");
  console.log(`✅ Supabase URL: ${SUPABASE_URL}`);

  // Create Supabase client
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  // Test phone number
  const testPhone = "whatsapp:+1234567890";
  const testBucketName = `test-bucket-${Date.now()}`;

  try {
    // Step 1: Encrypt a test secret
    console.log("\n📝 Step 1: Encrypting secret...");
    const plainSecret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    const encryptedSecret = await encryptSecret(plainSecret);
    console.log(`✅ Encrypted: ${encryptedSecret.substring(0, 30)}...`);

    // Step 2: Insert bucket config
    console.log("\n📝 Step 2: Inserting bucket config...");
    const { data: insertData, error: insertError } = await supabase
      .from("bucket_configs")
      .insert({
        phone_number: testPhone,
        bucket_name: testBucketName,
        endpoint_url: "https://s3.us-west-002.backblazeb2.com",
        region: "us-west-002",
        access_key_id: "AKIAIOSFODNN7EXAMPLE",
        secret_access_key: encryptedSecret,
      })
      .select()
      .single();

    if (insertError) {
      console.error("❌ Insert error:", insertError);
      throw insertError;
    }

    console.log(`✅ Inserted bucket config with ID: ${insertData.id}`);

    // Step 3: Retrieve bucket config
    console.log("\n📝 Step 3: Retrieving bucket config...");
    const { data: retrieveData, error: retrieveError } = await supabase
      .from("bucket_configs")
      .select("*")
      .eq("phone_number", testPhone)
      .eq("bucket_name", testBucketName)
      .maybeSingle();

    if (retrieveError) {
      console.error("❌ Retrieve error:", retrieveError);
      throw retrieveError;
    }

    if (!retrieveData) {
      console.error("❌ No data retrieved!");
      throw new Error("Bucket config not found");
    }

    console.log(`✅ Retrieved bucket config: ${retrieveData.bucket_name}`);
    console.log(`   Endpoint: ${retrieveData.endpoint_url}`);
    console.log(`   Encrypted secret (first 30 chars): ${retrieveData.secret_access_key.substring(0, 30)}...`);

    // Step 4: Decrypt the secret
    console.log("\n📝 Step 4: Decrypting secret...");
    const decryptedSecret = await decryptSecret(retrieveData.secret_access_key);
    console.log(`✅ Decrypted successfully`);

    // Step 5: Verify roundtrip
    console.log("\n📝 Step 5: Verifying roundtrip...");
    if (decryptedSecret === plainSecret) {
      console.log("✅ Roundtrip successful! Original secret matches decrypted secret.");
    } else {
      console.error("❌ Roundtrip failed! Secrets don't match.");
      console.error(`   Original:  ${plainSecret}`);
      console.error(`   Decrypted: ${decryptedSecret}`);
      throw new Error("Roundtrip verification failed");
    }

    // Step 6: Cleanup
    console.log("\n📝 Step 6: Cleaning up...");
    const { error: deleteError } = await supabase
      .from("bucket_configs")
      .delete()
      .eq("id", insertData.id);

    if (deleteError) {
      console.error("⚠️  Cleanup error:", deleteError);
    } else {
      console.log("✅ Cleaned up test data");
    }

    console.log("\n🎉 All tests passed!");
  } catch (error) {
    console.error("\n💥 Test failed:", error);
    process.exit(1);
  }
}

testBucketConfig();
