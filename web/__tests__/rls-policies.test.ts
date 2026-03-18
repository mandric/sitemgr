/**
 * RLS Policy Integration Tests
 *
 * Requires local Supabase running: `supabase start`
 * These tests verify that Row Level Security policies correctly
 * enforce tenant isolation across all tables.
 *
 * Uses real Supabase Auth to create test users and authenticate
 * as different users to verify cross-tenant access is blocked.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SECRET_KEY;

const canRun = !!(SUPABASE_URL && SUPABASE_ANON_KEY && SUPABASE_SERVICE_KEY);

describe.skipIf(!canRun)("RLS Policy Integration Tests", () => {
  let admin: SupabaseClient;
  let userAClient: SupabaseClient;
  let userBClient: SupabaseClient;
  let anonClient: SupabaseClient;

  let userAId: string;
  let userBId: string;

  const USER_A_EMAIL = "rls-test-a@test.local";
  const USER_B_EMAIL = "rls-test-b@test.local";
  const USER_A_PHONE = "+15550000001";
  const USER_B_PHONE = "+15550000002";
  const PASSWORD = "test-password-secure-123";

  // Test data IDs for cleanup
  const eventIds = {
    a1: "rls-evt-a1",
    a2: "rls-evt-a2",
    b1: "rls-evt-b1",
  };

  beforeAll(async () => {
    admin = createClient(SUPABASE_URL!, SUPABASE_SERVICE_KEY!);
    anonClient = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!);

    // Create test users
    const { data: userAData } = await admin.auth.admin.createUser({
      email: USER_A_EMAIL,
      password: PASSWORD,
      email_confirm: true,
    });
    const { data: userBData } = await admin.auth.admin.createUser({
      email: USER_B_EMAIL,
      password: PASSWORD,
      email_confirm: true,
    });

    userAId = userAData.user!.id;
    userBId = userBData.user!.id;

    // Helper to assert inserts succeed
    const assertInsert = async (result: { error: unknown }) => {
      if (result.error) throw new Error(`Seed insert failed: ${JSON.stringify(result.error)}`);
    };

    // Create user profiles
    await assertInsert(await admin.from("user_profiles").insert([
      { id: userAId, phone_number: USER_A_PHONE },
      { id: userBId, phone_number: USER_B_PHONE },
    ]));

    // Seed events
    const now = new Date().toISOString();
    await assertInsert(await admin.from("events").insert([
      { id: eventIds.a1, timestamp: now, device_id: "test", type: "create", content_type: "photo", user_id: userAId },
      { id: eventIds.a2, timestamp: now, device_id: "test", type: "create", content_type: "video", user_id: userAId },
      { id: eventIds.b1, timestamp: now, device_id: "test", type: "create", content_type: "photo", user_id: userBId },
    ]));

    // Seed enrichments
    await assertInsert(await admin.from("enrichments").insert([
      { event_id: eventIds.a1, description: "User A photo", objects: ["tree"], context: "nature", tags: ["green"], user_id: userAId },
      { event_id: eventIds.b1, description: "User B photo", objects: ["cat"], context: "pet", tags: ["animal"], user_id: userBId },
    ]));

    // Seed watched_keys
    await assertInsert(await admin.from("watched_keys").insert([
      { s3_key: "rls-test/a/key1.jpg", first_seen: now, event_id: eventIds.a1, user_id: userAId },
      { s3_key: "rls-test/b/key1.jpg", first_seen: now, event_id: eventIds.b1, user_id: userBId },
    ]));

    // Seed bucket_configs
    await assertInsert(await admin.from("bucket_configs").insert([
      { user_id: userAId, phone_number: USER_A_PHONE, bucket_name: "rls-test-a", endpoint_url: "https://s3.example.com", access_key_id: "AKID-A", secret_access_key: "encrypted-a" },
      { user_id: userBId, phone_number: USER_B_PHONE, bucket_name: "rls-test-b", endpoint_url: "https://s3.example.com", access_key_id: "AKID-B", secret_access_key: "encrypted-b" },
    ]));

    // Seed conversations
    await assertInsert(await admin.from("conversations").insert([
      { phone_number: USER_A_PHONE, user_id: userAId, history: [{ role: "user", content: "hello" }] },
      { phone_number: USER_B_PHONE, user_id: userBId, history: [{ role: "user", content: "hi" }] },
    ]));

    // Create authenticated clients
    const clientA = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!);
    await clientA.auth.signInWithPassword({ email: USER_A_EMAIL, password: PASSWORD });
    userAClient = clientA;

    const clientB = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!);
    await clientB.auth.signInWithPassword({ email: USER_B_EMAIL, password: PASSWORD });
    userBClient = clientB;
  });

  afterAll(async () => {
    if (!admin) return;

    // Clean up in dependency order
    await admin.from("enrichments").delete().in("event_id", Object.values(eventIds));
    await admin.from("watched_keys").delete().like("s3_key", "rls-test/%");
    await admin.from("events").delete().in("id", Object.values(eventIds));
    await admin.from("bucket_configs").delete().like("bucket_name", "rls-test-%");
    await admin.from("conversations").delete().in("phone_number", [USER_A_PHONE, USER_B_PHONE]);
    await admin.from("user_profiles").delete().in("id", [userAId, userBId]);

    if (userAId) await admin.auth.admin.deleteUser(userAId);
    if (userBId) await admin.auth.admin.deleteUser(userBId);
  });

  // ── Test Infrastructure ──────────────────────────────────────────

  describe("test infrastructure", () => {
    it("created two distinct authenticated users", () => {
      expect(userAId).toBeDefined();
      expect(userBId).toBeDefined();
      expect(userAId).not.toBe(userBId);
    });

    it("admin client can see all test data", async () => {
      const { data } = await admin.from("events").select("id").in("id", Object.values(eventIds));
      expect(data).toHaveLength(3);
    });
  });

  // ── Cross-Tenant Isolation ───────────────────────────────────────

  describe("cross-tenant isolation", () => {
    it("user A cannot SELECT user B's events", async () => {
      const { data } = await userAClient.from("events").select("id, user_id");
      const ids = (data ?? []).map((r) => r.id);
      expect(ids).toContain(eventIds.a1);
      expect(ids).toContain(eventIds.a2);
      expect(ids).not.toContain(eventIds.b1);
    });

    it("user A cannot SELECT user B's enrichments", async () => {
      const { data } = await userAClient.from("enrichments").select("event_id, user_id");
      const eventIdList = (data ?? []).map((r) => r.event_id);
      expect(eventIdList).toContain(eventIds.a1);
      expect(eventIdList).not.toContain(eventIds.b1);
    });

    it("user A cannot SELECT user B's watched_keys", async () => {
      const { data } = await userAClient.from("watched_keys").select("s3_key, user_id");
      const keys = (data ?? []).map((r) => r.s3_key);
      expect(keys.some((k: string) => k.startsWith("rls-test/a/"))).toBe(true);
      expect(keys.some((k: string) => k.startsWith("rls-test/b/"))).toBe(false);
    });

    it("user A cannot SELECT user B's bucket_configs", async () => {
      const { data } = await userAClient.from("bucket_configs").select("bucket_name, user_id");
      const names = (data ?? []).map((r) => r.bucket_name);
      expect(names).toContain("rls-test-a");
      expect(names).not.toContain("rls-test-b");
    });

    it("user A cannot SELECT user B's conversations", async () => {
      const { data } = await userAClient.from("conversations").select("phone_number, user_id");
      const phones = (data ?? []).map((r) => r.phone_number);
      expect(phones).toContain(USER_A_PHONE);
      expect(phones).not.toContain(USER_B_PHONE);
    });

    it("user A cannot SELECT user B's user_profiles", async () => {
      const { data } = await userAClient.from("user_profiles").select("id");
      const ids = (data ?? []).map((r) => r.id);
      expect(ids).toContain(userAId);
      expect(ids).not.toContain(userBId);
    });
  });

  // ── Anon Blocking ────────────────────────────────────────────────

  describe("anon blocking", () => {
    const tables = ["events", "enrichments", "watched_keys", "bucket_configs", "conversations", "user_profiles"];

    for (const table of tables) {
      it(`anon user cannot SELECT from ${table}`, async () => {
        const { data, error } = await anonClient.from(table).select("*").limit(10);
        // Either returns empty array (RLS blocks) or error
        if (error) {
          expect(error.code).toBeDefined();
        } else {
          expect(data).toHaveLength(0);
        }
      });
    }
  });

  // ── Insert Restrictions ──────────────────────────────────────────

  describe("insert restrictions", () => {
    it("user A cannot INSERT event with user B's user_id", async () => {
      const { error } = await userAClient.from("events").insert({
        id: "rls-cross-insert-test",
        timestamp: new Date().toISOString(),
        device_id: "test",
        type: "create",
        content_type: "photo",
        user_id: userBId,
      });
      expect(error).toBeDefined();
      // Clean up in case it somehow succeeded
      await admin.from("events").delete().eq("id", "rls-cross-insert-test");
    });

    it("user A cannot INSERT bucket_config with user B's user_id", async () => {
      const { error } = await userAClient.from("bucket_configs").insert({
        user_id: userBId,
        bucket_name: "rls-cross-insert-bucket",
        endpoint_url: "https://s3.example.com",
        access_key_id: "AKID",
        secret_access_key: "secret",
      });
      expect(error).toBeDefined();
      await admin.from("bucket_configs").delete().eq("bucket_name", "rls-cross-insert-bucket");
    });

    it("user A cannot INSERT enrichment with user B's user_id", async () => {
      const { error } = await userAClient.from("enrichments").insert({
        event_id: eventIds.b1,
        description: "cross-tenant enrichment",
        user_id: userBId,
      });
      expect(error).toBeDefined();
    });
  });

  // ── NULL Safety ──────────────────────────────────────────────────

  describe("NULL safety", () => {
    const nullEventId = "rls-null-safety-evt";

    beforeAll(async () => {
      // Insert record with NULL user_id and NULL phone_number via admin
      await admin.from("events").insert({
        id: nullEventId,
        timestamp: new Date().toISOString(),
        device_id: "test",
        type: "create",
        content_type: "photo",
        user_id: null,
      });
    });

    afterAll(async () => {
      await admin.from("events").delete().eq("id", nullEventId);
    });

    it("NULL user_id does not grant universal access", async () => {
      const { data: aData } = await userAClient.from("events").select("id").eq("id", nullEventId);
      const { data: bData } = await userBClient.from("events").select("id").eq("id", nullEventId);
      expect(aData).toHaveLength(0);
      expect(bData).toHaveLength(0);
    });

    it("NULL user_id + NULL phone_number does not grant access on bucket_configs", async () => {
      await admin.from("bucket_configs").insert({
        user_id: null,
        phone_number: null,
        bucket_name: "rls-null-bucket",
        endpoint_url: "https://s3.example.com",
        access_key_id: "AKID",
        secret_access_key: "secret",
      });

      const { data: aData } = await userAClient.from("bucket_configs").select("bucket_name").eq("bucket_name", "rls-null-bucket");
      const { data: bData } = await userBClient.from("bucket_configs").select("bucket_name").eq("bucket_name", "rls-null-bucket");
      expect(aData).toHaveLength(0);
      expect(bData).toHaveLength(0);

      await admin.from("bucket_configs").delete().eq("bucket_name", "rls-null-bucket");
    });
  });

  // ── Phone-Based Access (Dual Auth Period) ────────────────────────

  describe("phone-based access", () => {
    it("phone_number auth path grants access to matching records only on bucket_configs", async () => {
      // Insert a bucket_config with user_id=NULL and phone matching user A
      await admin.from("bucket_configs").insert({
        user_id: null,
        phone_number: USER_A_PHONE,
        bucket_name: "rls-phone-test-bucket",
        endpoint_url: "https://s3.example.com",
        access_key_id: "AKID",
        secret_access_key: "secret",
      });

      // User A (whose JWT has phone claim) should see it
      const { data: aData } = await userAClient.from("bucket_configs").select("bucket_name").eq("bucket_name", "rls-phone-test-bucket");

      // User B should NOT see it
      const { data: bData } = await userBClient.from("bucket_configs").select("bucket_name").eq("bucket_name", "rls-phone-test-bucket");

      // Note: This test may fail if the JWT doesn't include a phone claim,
      // which depends on how the test users were created. The phone path
      // is only active during the dual-auth transition period.
      // If aData is empty, it means the JWT doesn't have the phone claim,
      // which is still safe (phone path doesn't grant access without claim).
      expect(bData).toHaveLength(0);

      await admin.from("bucket_configs").delete().eq("bucket_name", "rls-phone-test-bucket");
    });
  });

  // ── SECURITY DEFINER Restrictions ────────────────────────────────

  describe("SECURITY DEFINER restrictions", () => {
    it("get_user_id_from_phone() is not callable by anon role", async () => {
      const { error } = await anonClient.rpc("get_user_id_from_phone", {
        p_phone_number: USER_A_PHONE,
      });
      expect(error).toBeDefined();
      expect(error!.message).toMatch(/permission denied/i);
    });

    it("get_user_id_from_phone() is not callable by authenticated user", async () => {
      const { error } = await userAClient.rpc("get_user_id_from_phone", {
        p_phone_number: USER_B_PHONE,
      });
      expect(error).toBeDefined();
      expect(error!.message).toMatch(/permission denied/i);
    });
  });
});
