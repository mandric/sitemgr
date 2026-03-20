/**
 * Tenant isolation tests — validates multi-tenant data isolation via RLS.
 * Merges rls-policies, rpc-user-isolation, and rls-audit test coverage.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  getSupabaseConfig,
  getAdminClient,
  createTestUser,
  seedUserData,
  cleanupUserData,
  type SeedResult,
} from "./setup";

let admin: SupabaseClient;
let aliceClient: SupabaseClient;
let anonClient: SupabaseClient;
let aliceId: string;
let bobId: string;
let aliceSeed: SeedResult;
let bobSeed: SeedResult;

beforeAll(async () => {
  admin = getAdminClient();
  const config = getSupabaseConfig();

  const alice = await createTestUser("alice-iso@test.local");
  aliceId = alice.userId;
  aliceClient = alice.client;

  const bob = await createTestUser("bob-iso@test.local");
  bobId = bob.userId;

  aliceSeed = await seedUserData(admin, aliceId, { eventCount: 2 });
  bobSeed = await seedUserData(admin, bobId, { eventCount: 1 });

  anonClient = createClient(config.url, config.anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
});

afterAll(async () => {
  await cleanupUserData(admin, aliceId);
  await cleanupUserData(admin, bobId);
});

describe("when querying own data", () => {
  it("should only return Alice's events when Alice queries events", async () => {
    const { data } = await aliceClient.from("events").select("*");
    expect(data).toHaveLength(2);
    expect(data!.every((e) => e.user_id === aliceId)).toBe(true);
  });

  it("should only return Alice's enrichments when Alice queries enrichments", async () => {
    const { data } = await aliceClient.from("enrichments").select("*");
    expect(data).toHaveLength(2);
    expect(data!.every((e) => e.user_id === aliceId)).toBe(true);
  });

  it("should only return Alice's watched_keys when Alice queries watched_keys", async () => {
    const { data } = await aliceClient.from("watched_keys").select("*");
    expect(data).toHaveLength(2);
    expect(data!.every((e) => e.user_id === aliceId)).toBe(true);
  });

  it("should only return Alice's bucket_configs when Alice queries bucket_configs", async () => {
    const { data } = await aliceClient.from("bucket_configs").select("*");
    expect(data).toHaveLength(1);
    expect(data![0].user_id).toBe(aliceId);
  });

  it("should only return Alice's conversations when Alice queries conversations", async () => {
    const { data } = await aliceClient.from("conversations").select("*");
    expect(data).toHaveLength(1);
    expect(data![0].user_id).toBe(aliceId);
  });

  it("should only return Alice's user_profiles when Alice queries user_profiles", async () => {
    const { data } = await aliceClient.from("user_profiles").select("*");
    expect(data).toHaveLength(1);
    expect(data![0].id).toBe(aliceId);
  });
});

describe("when attempting cross-tenant writes", () => {
  it("should reject INSERT of event with another user's user_id", async () => {
    const { error } = await aliceClient.from("events").insert({
      id: "cross-tenant-evt-1",
      timestamp: new Date().toISOString(),
      device_id: "alice-device",
      type: "photo",
      user_id: bobId,
    });
    expect(error).not.toBeNull();
  });

  it("should reject INSERT of bucket_config with another user's user_id", async () => {
    const { error } = await aliceClient.from("bucket_configs").insert({
      user_id: bobId,
      bucket_name: "stolen-bucket",
      endpoint_url: "http://localhost",
      access_key_id: "x",
      secret_access_key: "x",
    });
    expect(error).not.toBeNull();
  });

  it("should reject INSERT of enrichment with another user's user_id", async () => {
    const { error } = await aliceClient.from("enrichments").insert({
      event_id: bobSeed.eventIds[0],
      user_id: bobId,
    });
    expect(error).not.toBeNull();
  });

  it("should not affect Bob's events when Alice attempts UPDATE", async () => {
    await aliceClient
      .from("events")
      .update({ type: "hacked" })
      .eq("user_id", bobId);

    const { data } = await admin
      .from("events")
      .select("type")
      .eq("id", bobSeed.eventIds[0])
      .single();
    expect(data!.type).toBe("photo");
  });

  it("should not affect Bob's bucket_configs when Alice attempts DELETE", async () => {
    await aliceClient
      .from("bucket_configs")
      .delete()
      .eq("user_id", bobId);

    const { data } = await admin
      .from("bucket_configs")
      .select("id")
      .eq("user_id", bobId);
    expect(data).toHaveLength(1);
  });
});

describe("when accessing as anonymous user", () => {
  const tables = [
    "events",
    "enrichments",
    "watched_keys",
    "bucket_configs",
    "conversations",
    "user_profiles",
  ];

  for (const table of tables) {
    it(`should return empty results when anon queries ${table}`, async () => {
      const { data, error } = await anonClient.from(table).select("*");
      if (error) return; // permission denied is acceptable
      expect(data).toHaveLength(0);
    });

    it(`should reject when anon tries to INSERT into ${table}`, async () => {
      const dummyRow: Record<string, unknown> = {
        events: {
          id: "anon-evt",
          timestamp: new Date().toISOString(),
          device_id: "x",
          type: "x",
          user_id: aliceId,
        },
        enrichments: { event_id: "anon-evt", user_id: aliceId },
        watched_keys: {
          s3_key: "anon-key",
          first_seen: new Date().toISOString(),
          user_id: aliceId,
        },
        bucket_configs: {
          user_id: aliceId,
          bucket_name: "anon",
          endpoint_url: "http://x",
          access_key_id: "x",
          secret_access_key: "x",
        },
        conversations: { user_id: aliceId, history: "[]" },
        user_profiles: { id: aliceId },
      }[table];

      const { error } = await anonClient.from(table).insert(dummyRow as Record<string, unknown>);
      expect(error).not.toBeNull();
    });
  }
});

describe("when calling RPC functions", () => {
  it("should return only Alice's events when Alice calls search_events", async () => {
    const { data } = await aliceClient.rpc("search_events", {
      p_user_id: aliceId,
      p_query: "Test enrichment",
    });
    if (data && data.length > 0) {
      expect(data.every((r: { user_id: string }) => r.user_id === aliceId)).toBe(true);
    }
  });

  it("should return empty when Alice calls search_events with Bob's user_id", async () => {
    const { data } = await aliceClient.rpc("search_events", {
      p_user_id: bobId,
      p_query: "Test enrichment",
    });
    expect(data ?? []).toHaveLength(0);
  });

  it("should return only Alice's stats when Alice calls stats_by_content_type", async () => {
    const { data, error } = await aliceClient.rpc("stats_by_content_type", {
      p_user_id: aliceId,
    });
    expect(error).toBeNull();
    if (data && data.length > 0) {
      const total = data.reduce(
        (sum: number, r: { count: number }) => sum + Number(r.count),
        0,
      );
      expect(total).toBe(2);
    }
  });

  it("should return only Alice's stats when Alice calls stats_by_event_type", async () => {
    const { data, error } = await aliceClient.rpc("stats_by_event_type", {
      p_user_id: aliceId,
    });
    expect(error).toBeNull();
    if (data && data.length > 0) {
      const total = data.reduce(
        (sum: number, r: { count: number }) => sum + Number(r.count),
        0,
      );
      expect(total).toBe(2);
    }
  });
});

describe("when calling admin-only functions", () => {
  it("should deny Alice access to get_user_id_from_phone", async () => {
    const { error } = await aliceClient.rpc("get_user_id_from_phone", {
      p_phone: "+1234567890",
    });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/permission denied/i);
  });

  it("should deny anonymous access to get_user_id_from_phone", async () => {
    const { error } = await anonClient.rpc("get_user_id_from_phone", {
      p_phone: "+1234567890",
    });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/permission denied/i);
  });

  it("should allow service_role access to get_user_id_from_phone", async () => {
    const { error } = await admin.rpc("get_user_id_from_phone", {
      p_phone: "+1234567890",
    });
    if (error) {
      expect(error.message).not.toMatch(/permission denied/i);
    }
  });
});

describe("when attempting to modify own events", () => {
  it("should reject UPDATE of own events", async () => {
    const { data } = await aliceClient
      .from("events")
      .update({ type: "modified" })
      .eq("id", aliceSeed.eventIds[0])
      .select();
    expect(data ?? []).toHaveLength(0);

    // Verify original still exists
    const { data: original } = await admin
      .from("events")
      .select("type")
      .eq("id", aliceSeed.eventIds[0])
      .single();
    expect(original!.type).toBe("photo");
  });

  it("should reject DELETE of own events", async () => {
    await aliceClient
      .from("events")
      .delete()
      .eq("id", aliceSeed.eventIds[0]);

    // Verify event still exists
    const { data } = await admin
      .from("events")
      .select("id")
      .eq("id", aliceSeed.eventIds[0])
      .single();
    expect(data).not.toBeNull();
  });
});
