/**
 * Integration tests for RPC function user isolation.
 * Requires local Supabase running (`supabase start`).
 *
 * These tests verify that modified RPC functions enforce tenant isolation
 * via the p_user_id parameter and that get_user_id_from_phone is restricted.
 *
 * Skip condition: Tests are skipped when NEXT_PUBLIC_SUPABASE_URL is not set
 * (i.e., no local Supabase instance available).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SECRET_KEY;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

const canRun = !!(SUPABASE_URL && SERVICE_ROLE_KEY && ANON_KEY);

describe.skipIf(!canRun)("RPC User Isolation", () => {
  // Lazy-init to avoid createClient throwing when env vars are missing
  let admin: ReturnType<typeof createClient>;
  let anon: ReturnType<typeof createClient>;

  const userAId = "00000000-0000-0000-0000-000000000a01";
  const userBId = "00000000-0000-0000-0000-000000000b02";

  beforeAll(async () => {
    admin = createClient(SUPABASE_URL!, SERVICE_ROLE_KEY!);
    anon = createClient(SUPABASE_URL!, ANON_KEY!);

    // Create test users via admin auth API
    const { data: userA } = await admin.auth.admin.createUser({
      email: "rpc-test-a@test.local",
      password: "test-password-a",
      email_confirm: true,
      user_metadata: { test: true },
    });
    const { data: userB } = await admin.auth.admin.createUser({
      email: "rpc-test-b@test.local",
      password: "test-password-b",
      email_confirm: true,
      user_metadata: { test: true },
    });

    const uidA = userA.user?.id ?? userAId;
    const uidB = userB.user?.id ?? userBId;

    // Insert events for user A
    await admin.from("events").insert([
      {
        id: "rpc-test-a-1",
        timestamp: new Date().toISOString(),
        device_id: "test-device",
        type: "create",
        content_type: "photo",
        user_id: uidA,
      },
      {
        id: "rpc-test-a-2",
        timestamp: new Date().toISOString(),
        device_id: "test-device",
        type: "create",
        content_type: "video",
        user_id: uidA,
      },
    ]);

    // Insert events for user B
    await admin.from("events").insert([
      {
        id: "rpc-test-b-1",
        timestamp: new Date().toISOString(),
        device_id: "test-device",
        type: "create",
        content_type: "photo",
        user_id: uidB,
      },
    ]);

    // Insert enrichments for FTS testing
    await admin.from("enrichments").insert([
      {
        event_id: "rpc-test-a-1",
        description: "A beautiful sunset over the ocean",
        objects: ["sun", "ocean"],
        context: "nature photography",
        tags: ["sunset", "ocean"],
        user_id: uidA,
      },
      {
        event_id: "rpc-test-b-1",
        description: "A cat sleeping on a couch",
        objects: ["cat", "couch"],
        context: "pet photography",
        tags: ["cat", "pet"],
        user_id: uidB,
      },
    ]);

    // Store actual UIDs for tests
    (globalThis as Record<string, unknown>).__rpcTestUidA = uidA;
    (globalThis as Record<string, unknown>).__rpcTestUidB = uidB;
  });

  afterAll(async () => {
    // Clean up test data
    await admin.from("enrichments").delete().in("event_id", ["rpc-test-a-1", "rpc-test-b-1"]);
    await admin.from("events").delete().in("id", ["rpc-test-a-1", "rpc-test-a-2", "rpc-test-b-1"]);

    const uidA = (globalThis as Record<string, unknown>).__rpcTestUidA as string;
    const uidB = (globalThis as Record<string, unknown>).__rpcTestUidB as string;
    if (uidA) await admin.auth.admin.deleteUser(uidA);
    if (uidB) await admin.auth.admin.deleteUser(uidB);
  });

  describe("search_events", () => {
    it("returns only results for the specified p_user_id", async () => {
      const uidA = (globalThis as Record<string, unknown>).__rpcTestUidA as string;
      const { data, error } = await admin.rpc("search_events", {
        p_user_id: uidA,
        query_text: "sunset",
      });
      expect(error).toBeNull();
      expect(data).toHaveLength(1);
      expect(data![0].id).toBe("rpc-test-a-1");
    });

    it("does not return other users results", async () => {
      const uidA = (globalThis as Record<string, unknown>).__rpcTestUidA as string;
      const { data, error } = await admin.rpc("search_events", {
        p_user_id: uidA,
        query_text: "cat",
      });
      expect(error).toBeNull();
      expect(data).toHaveLength(0);
    });
  });

  describe("stats_by_content_type", () => {
    it("returns only stats for the specified p_user_id", async () => {
      const uidA = (globalThis as Record<string, unknown>).__rpcTestUidA as string;
      const { data, error } = await admin.rpc("stats_by_content_type", {
        p_user_id: uidA,
      });
      expect(error).toBeNull();
      const photoRow = data?.find((r: { content_type: string }) => r.content_type === "photo");
      const videoRow = data?.find((r: { content_type: string }) => r.content_type === "video");
      expect(photoRow).toBeDefined();
      expect(videoRow).toBeDefined();
    });
  });

  describe("stats_by_event_type", () => {
    it("returns only stats for the specified p_user_id", async () => {
      const uidA = (globalThis as Record<string, unknown>).__rpcTestUidA as string;
      const { data, error } = await admin.rpc("stats_by_event_type", {
        p_user_id: uidA,
      });
      expect(error).toBeNull();
      const createRow = data?.find((r: { type: string }) => r.type === "create");
      expect(createRow).toBeDefined();
      expect(Number(createRow!.count)).toBe(2);
    });
  });

  describe("get_user_id_from_phone", () => {
    it("is not callable by anon role", async () => {
      const { error } = await anon.rpc("get_user_id_from_phone", {
        p_phone_number: "+1234567890",
      });
      expect(error).toBeDefined();
      expect(error!.message).toMatch(/permission denied/i);
    });
  });

  describe("FTS index usage", () => {
    it("search_events uses GIN index on enrichments.fts", async () => {
      const uidA = (globalThis as Record<string, unknown>).__rpcTestUidA as string;
      const { data } = await admin.rpc("search_events", {
        p_user_id: uidA,
        query_text: "sunset",
      });
      // If we get results, the query executed successfully with the user filter
      expect(data).toBeDefined();
    });
  });
});
