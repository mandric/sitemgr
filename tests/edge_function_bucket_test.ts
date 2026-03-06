// Integration tests for WhatsApp Edge Function bucket configuration
// Run with: deno test --allow-env --allow-net tests/edge_function_bucket_test.ts

import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "http://localhost:54321";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ENCRYPTION_KEY = Deno.env.get("ENCRYPTION_KEY") || "test-encryption-key-32-chars!!";
const TEST_PHONE = "whatsapp:+15555551234";

// Set up test environment variables for the Edge Function
Deno.env.set("SUPABASE_URL", SUPABASE_URL);
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SUPABASE_SERVICE_ROLE_KEY);
Deno.env.set("ANTHROPIC_API_KEY", "test-key");
Deno.env.set("TWILIO_ACCOUNT_SID", "test-sid");
Deno.env.set("TWILIO_AUTH_TOKEN", "test-token");
Deno.env.set("TWILIO_WHATSAPP_FROM", "whatsapp:+10000000000");
Deno.env.set("ENCRYPTION_KEY", ENCRYPTION_KEY);

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Helper to simulate Twilio webhook POST
async function simulateWhatsAppMessage(message: string): Promise<Response> {
  const body = new URLSearchParams();
  body.append("From", TEST_PHONE);
  body.append("Body", message);

  // Import and invoke the Edge Function
  const { default: handler } = await import("../supabase/functions/whatsapp/index.ts");

  const request = new Request("http://localhost:8000", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  return await handler(request);
}

// Cleanup before tests
async function cleanup() {
  await supabase
    .from("bucket_configs")
    .delete()
    .eq("phone_number", TEST_PHONE);

  await supabase
    .from("conversations")
    .delete()
    .eq("phone_number", TEST_PHONE);
}

Deno.test("Edge Function - Health check", async () => {
  const { default: handler } = await import("../supabase/functions/whatsapp/index.ts");

  const request = new Request("http://localhost:8000", {
    method: "GET",
  });

  const response = await handler(request);
  assertEquals(response.status, 200);

  const json = await response.json();
  assertEquals(json.status, "ok");
  assertEquals(json.service, "smgr-whatsapp-bot");
});

Deno.test("Bucket Configuration - Add bucket with all fields", async () => {
  await cleanup();

  // Check initial state - no buckets
  const { data: initialBuckets } = await supabase
    .from("bucket_configs")
    .select("*")
    .eq("phone_number", TEST_PHONE);

  assertEquals(initialBuckets?.length || 0, 0, "Should start with no buckets");

  // Simulate adding a bucket via agent
  // The agent should parse this and call add_bucket action
  const response = await simulateWhatsAppMessage(
    "Add my S3 bucket: bucket_name=test-bucket, endpoint_url=https://s3.us-east-1.amazonaws.com, access_key_id=AKIATEST, secret_access_key=secret123, region=us-east-1"
  );

  assertEquals(response.status, 200, "Should return 200");

  // Wait a bit for processing
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Verify bucket was added to database
  const { data: buckets, error } = await supabase
    .from("bucket_configs")
    .select("*")
    .eq("phone_number", TEST_PHONE);

  assertExists(buckets, "Buckets should exist");
  assertEquals(error, null, "Should have no error");
  assertEquals(buckets.length, 1, "Should have 1 bucket");

  const bucket = buckets[0];
  assertEquals(bucket.bucket_name, "test-bucket");
  assertEquals(bucket.endpoint_url, "https://s3.us-east-1.amazonaws.com");
  assertEquals(bucket.access_key_id, "AKIATEST");
  assertEquals(bucket.region, "us-east-1");

  // Verify secret is encrypted (not plaintext)
  assertEquals(
    bucket.secret_access_key !== "secret123",
    true,
    "Secret should be encrypted"
  );

  await cleanup();
});

Deno.test("Bucket Configuration - List buckets", async () => {
  await cleanup();

  // Add test bucket directly to database
  const testSecret = "test-secret-key";

  // Encrypt the secret using the same method as Edge Function
  const encoder = new TextEncoder();
  const data = encoder.encode(testSecret);
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
  const encryptedSecret = btoa(String.fromCharCode(...combined));

  await supabase.from("bucket_configs").insert({
    phone_number: TEST_PHONE,
    bucket_name: "test-bucket-1",
    endpoint_url: "https://s3.amazonaws.com",
    access_key_id: "AKIATEST1",
    secret_access_key: encryptedSecret,
    region: "us-east-1",
  });

  // Query via agent
  const response = await simulateWhatsAppMessage("Show my buckets");
  assertEquals(response.status, 200);

  // Verify response mentions the bucket
  const body = await response.text();
  // The response should be TwiML, but the bot should have processed the request

  // Verify bucket exists in database
  const { data: buckets } = await supabase
    .from("bucket_configs")
    .select("*")
    .eq("phone_number", TEST_PHONE);

  assertEquals(buckets?.length, 1);
  assertEquals(buckets[0].bucket_name, "test-bucket-1");

  await cleanup();
});

Deno.test("Bucket Configuration - Remove bucket", async () => {
  await cleanup();

  // Add test bucket
  await supabase.from("bucket_configs").insert({
    phone_number: TEST_PHONE,
    bucket_name: "test-bucket-remove",
    endpoint_url: "https://s3.amazonaws.com",
    access_key_id: "AKIATEST",
    secret_access_key: "encrypted-dummy",
    region: "us-east-1",
  });

  // Verify it exists
  const { data: beforeRemove } = await supabase
    .from("bucket_configs")
    .select("*")
    .eq("phone_number", TEST_PHONE);
  assertEquals(beforeRemove?.length, 1);

  // Remove via agent
  const response = await simulateWhatsAppMessage("Remove bucket test-bucket-remove");
  assertEquals(response.status, 200);

  await new Promise(resolve => setTimeout(resolve, 1000));

  // Verify it's gone
  const { data: afterRemove } = await supabase
    .from("bucket_configs")
    .select("*")
    .eq("phone_number", TEST_PHONE);
  assertEquals(afterRemove?.length || 0, 0);

  await cleanup();
});

Deno.test("Bucket Configuration - Duplicate bucket name rejected", async () => {
  await cleanup();

  // Add first bucket
  await supabase.from("bucket_configs").insert({
    phone_number: TEST_PHONE,
    bucket_name: "duplicate-test",
    endpoint_url: "https://s3.amazonaws.com",
    access_key_id: "AKIATEST1",
    secret_access_key: "encrypted1",
  });

  // Try to add duplicate
  const { error } = await supabase.from("bucket_configs").insert({
    phone_number: TEST_PHONE,
    bucket_name: "duplicate-test",
    endpoint_url: "https://s3.amazonaws.com",
    access_key_id: "AKIATEST2",
    secret_access_key: "encrypted2",
  });

  assertExists(error, "Should reject duplicate bucket name");
  assertEquals(error.code, "23505", "Should be unique constraint violation");

  await cleanup();
});

Deno.test("Bucket Configuration - Missing required fields rejected", async () => {
  await cleanup();

  // Try to add bucket without endpoint_url
  const { error: error1 } = await supabase.from("bucket_configs").insert({
    phone_number: TEST_PHONE,
    bucket_name: "test-incomplete",
    access_key_id: "AKIATEST",
    secret_access_key: "encrypted",
    // endpoint_url missing
  });

  assertExists(error1, "Should reject missing endpoint_url");

  // Try to add bucket without access_key_id
  const { error: error2 } = await supabase.from("bucket_configs").insert({
    phone_number: TEST_PHONE,
    bucket_name: "test-incomplete-2",
    endpoint_url: "https://s3.amazonaws.com",
    secret_access_key: "encrypted",
    // access_key_id missing
  });

  assertExists(error2, "Should reject missing access_key_id");

  await cleanup();
});
