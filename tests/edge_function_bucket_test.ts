// Integration tests for bucket configuration database operations
// Run with: deno test --allow-env --allow-net tests/edge_function_bucket_test.ts

import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "http://localhost:54321";
const SUPABASE_SECRET_KEY = Deno.env.get("SUPABASE_SECRET_KEY")!;
const ENCRYPTION_KEY = Deno.env.get("ENCRYPTION_KEY") || "test-encryption-key-32-chars!!";
const TEST_PHONE = "whatsapp:+15555551234";

const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);

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

// Cleanup before tests
async function cleanup() {
  await supabase
    .from("bucket_configs")
    .delete()
    .eq("phone_number", TEST_PHONE);
}

Deno.test("Bucket Database - Add bucket config", async () => {
  await cleanup();

  const encryptedSecret = await encryptSecret("test-secret-key");

  const { data, error } = await supabase.from("bucket_configs").insert({
    phone_number: TEST_PHONE,
    bucket_name: "test-bucket",
    endpoint_url: "https://s3.us-east-1.amazonaws.com",
    access_key_id: "AKIATEST",
    secret_access_key: encryptedSecret,
    region: "us-east-1",
  }).select().single();

  assertEquals(error, null, "Should create bucket config without error");
  assertExists(data, "Should return bucket config");
  assertEquals(data.bucket_name, "test-bucket");
  assertEquals(data.endpoint_url, "https://s3.us-east-1.amazonaws.com");
  assertEquals(data.access_key_id, "AKIATEST");
  assertEquals(data.region, "us-east-1");

  // Verify secret is encrypted
  assertEquals(
    data.secret_access_key !== "test-secret-key",
    true,
    "Secret should be encrypted"
  );

  await cleanup();
});

Deno.test("Bucket Database - List buckets for user", async () => {
  await cleanup();

  const encryptedSecret = await encryptSecret("test-secret");

  // Add two buckets
  await supabase.from("bucket_configs").insert([
    {
      phone_number: TEST_PHONE,
      bucket_name: "bucket-1",
      endpoint_url: "https://s3.amazonaws.com",
      access_key_id: "KEY1",
      secret_access_key: encryptedSecret,
    },
    {
      phone_number: TEST_PHONE,
      bucket_name: "bucket-2",
      endpoint_url: "https://s3.eu-west-1.amazonaws.com",
      access_key_id: "KEY2",
      secret_access_key: encryptedSecret,
    },
  ]);

  // Query buckets
  const { data: buckets, error } = await supabase
    .from("bucket_configs")
    .select("*")
    .eq("phone_number", TEST_PHONE);

  assertEquals(error, null);
  assertExists(buckets);
  assertEquals(buckets.length, 2);
  assertEquals(buckets[0].bucket_name, "bucket-1");
  assertEquals(buckets[1].bucket_name, "bucket-2");

  await cleanup();
});

Deno.test("Bucket Database - Remove bucket", async () => {
  await cleanup();

  // Add bucket
  await supabase.from("bucket_configs").insert({
    phone_number: TEST_PHONE,
    bucket_name: "test-bucket-remove",
    endpoint_url: "https://s3.amazonaws.com",
    access_key_id: "AKIATEST",
    secret_access_key: await encryptSecret("secret"),
  });

  // Verify it exists
  const { data: before } = await supabase
    .from("bucket_configs")
    .select("*")
    .eq("phone_number", TEST_PHONE);
  assertEquals(before?.length, 1);

  // Remove it
  const { error } = await supabase
    .from("bucket_configs")
    .delete()
    .eq("phone_number", TEST_PHONE)
    .eq("bucket_name", "test-bucket-remove");

  assertEquals(error, null);

  // Verify it's gone
  const { data: after } = await supabase
    .from("bucket_configs")
    .select("*")
    .eq("phone_number", TEST_PHONE);
  assertEquals(after?.length || 0, 0);

  await cleanup();
});

Deno.test("Bucket Database - Duplicate bucket name rejected", async () => {
  await cleanup();

  const encryptedSecret = await encryptSecret("secret");

  // Add first bucket
  await supabase.from("bucket_configs").insert({
    phone_number: TEST_PHONE,
    bucket_name: "duplicate-test",
    endpoint_url: "https://s3.amazonaws.com",
    access_key_id: "KEY1",
    secret_access_key: encryptedSecret,
  });

  // Try to add duplicate
  const { error } = await supabase.from("bucket_configs").insert({
    phone_number: TEST_PHONE,
    bucket_name: "duplicate-test",
    endpoint_url: "https://s3.amazonaws.com",
    access_key_id: "KEY2",
    secret_access_key: encryptedSecret,
  });

  assertExists(error, "Should reject duplicate bucket name");
  assertEquals(error.code, "23505", "Should be unique constraint violation");

  await cleanup();
});

Deno.test("Bucket Database - Required fields enforced", async () => {
  await cleanup();

  // Try without endpoint_url
  const { error: error1 } = await supabase.from("bucket_configs").insert({
    phone_number: TEST_PHONE,
    bucket_name: "incomplete",
    access_key_id: "KEY",
    secret_access_key: "encrypted",
    // endpoint_url missing
  });

  assertExists(error1, "Should reject missing endpoint_url");

  // Try without access_key_id
  const { error: error2 } = await supabase.from("bucket_configs").insert({
    phone_number: TEST_PHONE,
    bucket_name: "incomplete-2",
    endpoint_url: "https://s3.amazonaws.com",
    secret_access_key: "encrypted",
    // access_key_id missing
  });

  assertExists(error2, "Should reject missing access_key_id");

  await cleanup();
});

Deno.test("Bucket Database - Encryption/decryption works", async () => {
  await cleanup();

  const plaintext = "my-secret-access-key-12345";
  const encrypted = await encryptSecret(plaintext);

  // Verify encrypted is different from plaintext
  assertEquals(encrypted !== plaintext, true);

  // Decrypt
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const keyData = encoder.encode(ENCRYPTION_KEY);

  const key = await crypto.subtle.importKey(
    "raw",
    await crypto.subtle.digest("SHA-256", keyData),
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );

  const combined = Uint8Array.from(atob(encrypted), (c) => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const encryptedData = combined.slice(12);

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    encryptedData,
  );

  const decryptedText = decoder.decode(decrypted);
  assertEquals(decryptedText, plaintext, "Decryption should recover original plaintext");
});
