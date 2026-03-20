import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  getSupabaseConfig,
  getAdminClient,
  createTestUser,
  cleanupUserData,
} from "./setup";

let admin: SupabaseClient;
let aliceId: string;
let aliceClient: SupabaseClient;
let bobId: string;
let bobClient: SupabaseClient;

beforeAll(async () => {
  admin = getAdminClient();

  const alice = await createTestUser("alice-mc@test.local");
  aliceId = alice.userId;
  aliceClient = alice.client;

  const bob = await createTestUser("bob-mc@test.local");
  bobId = bob.userId;
  bobClient = bob.client;
}, 30_000);

afterAll(async () => {
  await cleanupUserData(admin, aliceId);
  await cleanupUserData(admin, bobId);
  await aliceClient.auth.signOut();
  await bobClient.auth.signOut();
  await Promise.all([
    admin.removeAllChannels(),
    aliceClient.removeAllChannels(),
    bobClient.removeAllChannels(),
  ]);
});

describe("model_configs CRUD via service role", () => {
  let insertedId: string;

  it("should insert a row with all required fields", async () => {
    const { data, error } = await admin
      .from("model_configs")
      .insert({
        user_id: aliceId,
        provider: "ollama",
        model: "moondream:1.8b",
      })
      .select("id")
      .single();
    expect(error).toBeNull();
    expect(data).not.toBeNull();
    insertedId = data!.id;
  });

  it("should accept NULL for nullable fields (base_url, api_key_encrypted)", async () => {
    const { data, error } = await admin
      .from("model_configs")
      .insert({
        user_id: aliceId,
        provider: "custom-null-test",
        model: "test-model",
        base_url: null,
        api_key_encrypted: null,
      })
      .select("id")
      .single();
    expect(error).toBeNull();
    expect(data).not.toBeNull();

    // cleanup
    await admin.from("model_configs").delete().eq("id", data!.id);
  });

  afterAll(async () => {
    if (insertedId) {
      await admin.from("model_configs").delete().eq("id", insertedId);
    }
  });
});

describe("model_configs unique index", () => {
  it("should prevent two active configs for same user+provider", async () => {
    const { data: first } = await admin
      .from("model_configs")
      .insert({
        user_id: aliceId,
        provider: "anthropic",
        model: "claude-haiku",
        is_active: true,
      })
      .select("id")
      .single();

    const { error } = await admin.from("model_configs").insert({
      user_id: aliceId,
      provider: "anthropic",
      model: "claude-sonnet",
      is_active: true,
    });
    expect(error).not.toBeNull();
    expect(error!.code).toBe("23505"); // unique_violation

    // cleanup
    await admin.from("model_configs").delete().eq("id", first!.id);
  });

  it("should allow inactive + active config for same user+provider", async () => {
    const { data: inactive } = await admin
      .from("model_configs")
      .insert({
        user_id: aliceId,
        provider: "openai",
        model: "gpt-4o",
        is_active: false,
      })
      .select("id")
      .single();

    const { data: active, error } = await admin
      .from("model_configs")
      .insert({
        user_id: aliceId,
        provider: "openai",
        model: "gpt-4o-mini",
        is_active: true,
      })
      .select("id")
      .single();
    expect(error).toBeNull();
    expect(active).not.toBeNull();

    // cleanup
    await admin.from("model_configs").delete().eq("id", inactive!.id);
    await admin.from("model_configs").delete().eq("id", active!.id);
  });

  it("should allow two inactive configs for same user+provider", async () => {
    const { data: first } = await admin
      .from("model_configs")
      .insert({
        user_id: aliceId,
        provider: "test-provider",
        model: "model-a",
        is_active: false,
      })
      .select("id")
      .single();

    const { data: second, error } = await admin
      .from("model_configs")
      .insert({
        user_id: aliceId,
        provider: "test-provider",
        model: "model-b",
        is_active: false,
      })
      .select("id")
      .single();
    expect(error).toBeNull();

    // cleanup
    await admin.from("model_configs").delete().eq("id", first!.id);
    await admin.from("model_configs").delete().eq("id", second!.id);
  });
});

describe("model_configs ON DELETE CASCADE", () => {
  it("should remove config when auth user is deleted", async () => {
    const disposable = await createTestUser();
    const disposableId = disposable.userId;

    const { data: config } = await admin
      .from("model_configs")
      .insert({
        user_id: disposableId,
        provider: "anthropic",
        model: "claude-haiku",
      })
      .select("id")
      .single();
    expect(config).not.toBeNull();

    await admin.auth.admin.deleteUser(disposableId);

    const { data: remaining } = await admin
      .from("model_configs")
      .select("id")
      .eq("id", config!.id);
    expect(remaining).toHaveLength(0);
  });
});

describe("model_configs RLS", () => {
  let aliceConfigId: string;

  beforeAll(async () => {
    const { data } = await admin
      .from("model_configs")
      .insert({
        user_id: aliceId,
        provider: "rls-test",
        model: "test-model",
      })
      .select("id")
      .single();
    aliceConfigId = data!.id;
  });

  afterAll(async () => {
    await admin.from("model_configs").delete().eq("id", aliceConfigId);
  });

  it("should allow Alice to read her own config", async () => {
    const { data, error } = await aliceClient
      .from("model_configs")
      .select("*");
    expect(error).toBeNull();
    expect(data!.length).toBeGreaterThanOrEqual(1);
    expect(data!.every((c: { user_id: string }) => c.user_id === aliceId)).toBe(
      true,
    );
  });

  it("should prevent Bob from reading Alice's config", async () => {
    const { data, error } = await bobClient
      .from("model_configs")
      .select("*");
    expect(error).toBeNull();
    expect(
      data!.every((c: { user_id: string }) => c.user_id === bobId),
    ).toBe(true);
  });

  it("should prevent Alice from inserting a config for Bob", async () => {
    const { error } = await aliceClient.from("model_configs").insert({
      user_id: bobId,
      provider: "stolen",
      model: "stolen-model",
    });
    expect(error).not.toBeNull();
  });

  it("should allow Alice to insert her own config", async () => {
    const { data, error } = await aliceClient
      .from("model_configs")
      .insert({
        user_id: aliceId,
        provider: "alice-self-insert",
        model: "my-model",
      })
      .select("id")
      .single();
    expect(error).toBeNull();
    expect(data).not.toBeNull();

    // cleanup
    await admin.from("model_configs").delete().eq("id", data!.id);
  });

  it("should allow Alice to update her own config", async () => {
    const { data, error } = await aliceClient
      .from("model_configs")
      .update({ model: "updated-model" })
      .eq("id", aliceConfigId)
      .select("model")
      .single();
    expect(error).toBeNull();
    expect(data!.model).toBe("updated-model");
  });

  it("should prevent Bob from updating Alice's config", async () => {
    const { data } = await bobClient
      .from("model_configs")
      .update({ model: "hacked" })
      .eq("id", aliceConfigId)
      .select();
    // RLS silently filters — Bob's update matches zero rows
    expect(data ?? []).toHaveLength(0);

    // Verify Alice's config is unchanged
    const { data: original } = await admin
      .from("model_configs")
      .select("model")
      .eq("id", aliceConfigId)
      .single();
    expect(original!.model).toBe("updated-model");
  });

  it("should prevent Bob from deleting Alice's config", async () => {
    await bobClient
      .from("model_configs")
      .delete()
      .eq("id", aliceConfigId);

    const { data } = await admin
      .from("model_configs")
      .select("id")
      .eq("id", aliceConfigId)
      .single();
    expect(data).not.toBeNull();
  });

  it("should block anonymous access", async () => {
    const config = getSupabaseConfig();
    const anonClient = createClient(config.url, config.anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data, error } = await anonClient
      .from("model_configs")
      .select("*");
    if (error) return; // permission denied is acceptable
    expect(data).toHaveLength(0);

    await anonClient.removeAllChannels();
  });

  it("should allow service role to read all configs", async () => {
    const { data, error } = await admin
      .from("model_configs")
      .select("*");
    expect(error).toBeNull();
    expect(data!.length).toBeGreaterThanOrEqual(1);
  });
});
