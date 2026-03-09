// End-to-end test: Configure bucket → Scan → Enrich
// Tests the full pipeline with a real S3-compatible storage (local Supabase)
// Run with: deno test --allow-env --allow-net --allow-read tests/edge_function_scan_test.ts

import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "http://localhost:54321";
const SUPABASE_SECRET_KEY = Deno.env.get("SUPABASE_SECRET_KEY")!;
const STORAGE_S3_URL = Deno.env.get("STORAGE_S3_URL") || "http://localhost:54321/storage/v1/s3";
const AWS_ACCESS_KEY_ID = Deno.env.get("AWS_ACCESS_KEY_ID")!;
const AWS_SECRET_ACCESS_KEY = Deno.env.get("AWS_SECRET_ACCESS_KEY")!;
const ENCRYPTION_KEY = Deno.env.get("ENCRYPTION_KEY") || "test-encryption-key-32-chars!!";
const TEST_PHONE = "whatsapp:+15555559999";

const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);

// Set environment for Edge Function
Deno.env.set("SUPABASE_URL", SUPABASE_URL);
Deno.env.set("SUPABASE_SECRET_KEY", SUPABASE_SECRET_KEY);
Deno.env.set("ENCRYPTION_KEY", ENCRYPTION_KEY);
Deno.env.set("ANTHROPIC_API_KEY", "test-key");
Deno.env.set("TWILIO_ACCOUNT_SID", "test-sid");
Deno.env.set("TWILIO_AUTH_TOKEN", "test-token");
Deno.env.set("TWILIO_WHATSAPP_FROM", "whatsapp:+10000000000");

async function cleanup() {
  // Delete test bucket config
  await supabase
    .from("bucket_configs")
    .delete()
    .eq("phone_number", TEST_PHONE);

  // Delete test events
  await supabase
    .from("events")
    .delete()
    .like("id", "test-scan-%");

  // Delete test file from storage
  await supabase
    .storage
    .from("media")
    .remove(["test-scans/test_photo.jpg"]);
}

// Helper to encrypt secret (same as Edge Function)
async function encryptSecret(plaintext: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(plaintext);
  const keyData = encoder.encode(ENCRYPTION_KEY);

  const key = await crypto.subtle.importKey(
    "raw",
    await crypto.subtle.digest("SHA-256", keyData),
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    data,
  );

  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), iv.length);

  return btoa(String.fromCharCode(...combined));
}

Deno.test("End-to-end: Configure test bucket", async () => {
  await cleanup();

  // Add bucket config pointing to local Supabase S3
  const encryptedSecret = await encryptSecret(AWS_SECRET_ACCESS_KEY);

  const { data, error } = await supabase.from("bucket_configs").insert({
    phone_number: TEST_PHONE,
    bucket_name: "media",
    endpoint_url: STORAGE_S3_URL,
    region: "local",
    access_key_id: AWS_ACCESS_KEY_ID,
    secret_access_key: encryptedSecret,
  }).select().single();

  assertEquals(error, null, "Should create bucket config without error");
  assertExists(data, "Should return bucket config");
  assertEquals(data.bucket_name, "media");

  console.log("✓ Test bucket configured:", data.id);
});

Deno.test("End-to-end: Upload test file to S3", async () => {
  // Create minimal test JPEG (1x1 red pixel)
  const testImageBase64 = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AKwA//9k=";

  const imageData = Uint8Array.from(atob(testImageBase64), c => c.charCodeAt(0));

  // Upload to Supabase Storage
  const { data, error } = await supabase
    .storage
    .from("media")
    .upload("test-scans/test_photo.jpg", imageData, {
      contentType: "image/jpeg",
      upsert: true,
    });

  assertEquals(error, null, "Should upload without error");
  assertExists(data, "Should return upload data");

  console.log("✓ Test file uploaded:", data.path);
});

Deno.test("End-to-end: Verify file exists in storage", async () => {
  const { data: files, error } = await supabase
    .storage
    .from("media")
    .list("test-scans");

  assertEquals(error, null, "Should list files without error");
  assertExists(files, "Should return file list");
  assertEquals(files.length > 0, true, "Should have at least one file");

  const testFile = files.find(f => f.name === "test_photo.jpg");
  assertExists(testFile, "Should find test_photo.jpg");

  console.log("✓ File exists in storage:", testFile.name);
});

// Note: Actual bucket scanning would require implementing the scan functionality
// in the Edge Function. For now, this test verifies the infrastructure is ready.
Deno.test("End-to-end: Bucket config ready for scanning", async () => {
  const { data: config } = await supabase
    .from("bucket_configs")
    .select("*")
    .eq("phone_number", TEST_PHONE)
    .single();

  assertExists(config, "Bucket config should exist");
  assertEquals(config.bucket_name, "media");
  assertEquals(config.endpoint_url, STORAGE_S3_URL);

  console.log("✓ Bucket config ready for scanning");
  console.log("  - Bucket:", config.bucket_name);
  console.log("  - Endpoint:", config.endpoint_url);
  console.log("  - Region:", config.region);

  // Cleanup
  await cleanup();
});
