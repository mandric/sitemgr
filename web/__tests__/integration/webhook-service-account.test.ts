/**
 * Integration tests for the webhook service account RLS boundaries.
 *
 * Requires `supabase start` with the webhook_service_account migration applied.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  getSupabaseConfig,
  getAdminClient,
  createTestUser,
  seedUserData,
  cleanupUserData,
} from "./setup";

const WEBHOOK_UUID = "00000000-0000-0000-0000-000000000001";
const WEBHOOK_EMAIL = "webhook@sitemgr.internal";
const WEBHOOK_PASSWORD = "unused-password-webhook-uses-service-token";

let webhookClient: SupabaseClient;
let regularClient: SupabaseClient;
let anonClient: SupabaseClient;
let testUserId: string;
let admin: SupabaseClient;

beforeAll(async () => {
  const config = getSupabaseConfig();
  admin = getAdminClient();

  // Create a regular test user and seed data
  const { userId, client: userClient } = await createTestUser();
  testUserId = userId;
  regularClient = userClient;
  await seedUserData(admin, testUserId);

  // Create anon client
  anonClient = createClient(config.url, config.anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Sign in as the webhook service account
  webhookClient = createClient(config.url, config.anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await webhookClient.auth.signInWithPassword({
    email: WEBHOOK_EMAIL,
    password: WEBHOOK_PASSWORD,
  });
  if (error) {
    throw new Error(`Webhook sign-in failed: ${error.message}`);
  }
});

afterAll(async () => {
  if (testUserId) {
    await cleanupUserData(admin, testUserId);
  }
});

describe("webhook service account existence", () => {
  it("webhook service account user exists in auth.users", async () => {
    const { data } = await admin.auth.admin.getUserById(WEBHOOK_UUID);
    expect(data.user).toBeDefined();
    expect(data.user?.email).toBe(WEBHOOK_EMAIL);
  });

  it("webhook service account can sign in with signInWithPassword", async () => {
    const config = getSupabaseConfig();
    const tempClient = createClient(config.url, config.anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { error } = await tempClient.auth.signInWithPassword({
      email: WEBHOOK_EMAIL,
      password: WEBHOOK_PASSWORD,
    });
    expect(error).toBeNull();
  });
});

describe("webhook service account cross-user access", () => {
  it("can read events belonging to another user", async () => {
    const { data, error } = await webhookClient
      .from("events")
      .select("id")
      .eq("user_id", testUserId);
    expect(error).toBeNull();
    expect(data!.length).toBeGreaterThan(0);
  });

  it("can read enrichments belonging to another user", async () => {
    const { data, error } = await webhookClient
      .from("enrichments")
      .select("event_id")
      .eq("user_id", testUserId);
    expect(error).toBeNull();
    expect(data!.length).toBeGreaterThan(0);
  });

  it("can read conversations belonging to another user", async () => {
    const { data, error } = await webhookClient
      .from("conversations")
      .select("user_id")
      .eq("user_id", testUserId);
    expect(error).toBeNull();
    expect(data!.length).toBeGreaterThan(0);
  });

  it("can read bucket_configs belonging to another user", async () => {
    const { data, error } = await webhookClient
      .from("bucket_configs")
      .select("id")
      .eq("user_id", testUserId);
    expect(error).toBeNull();
    expect(data!.length).toBeGreaterThan(0);
  });

  it("can call get_user_id_from_phone RPC", async () => {
    // The test user has a phone number from seedUserData
    const prefix = testUserId.slice(0, 8);
    const { data, error } = await webhookClient.rpc("get_user_id_from_phone", {
      p_phone_number: `+1555${prefix}`,
    });
    expect(error).toBeNull();
    expect(data).toBe(testUserId);
  });
});

describe("regular user RLS still enforced", () => {
  it("regular user CANNOT read events belonging to another user", async () => {
    // Create a second user to verify isolation
    const { userId: otherUserId, client: otherClient } = await createTestUser();
    await seedUserData(admin, otherUserId);

    try {
      // regularClient should not see otherUser's events
      const { data } = await regularClient
        .from("events")
        .select("id")
        .eq("user_id", otherUserId);
      expect(data ?? []).toHaveLength(0);
    } finally {
      await cleanupUserData(admin, otherUserId);
    }
  });
});

describe("anon client RLS enforced", () => {
  it("anon client CANNOT read any events", async () => {
    const { data } = await anonClient
      .from("events")
      .select("id")
      .eq("user_id", testUserId);
    expect(data ?? []).toHaveLength(0);
  });
});
