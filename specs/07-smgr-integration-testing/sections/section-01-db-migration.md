# Section 01: Database Migration — model_configs Table

## Overview

Create a Supabase migration that adds a `model_configs` table, allowing users to configure their own enrichment model (e.g., local Ollama, OpenAI-compatible endpoints) instead of the hardcoded Anthropic Claude Haiku. Update the integration test cleanup function to include the new table.

## Context

The smgr CLI currently hardcodes Anthropic Claude Haiku for image enrichment. The `model_configs` table stores per-user model configuration: which provider, what endpoint, which model name, and an encrypted API key. A partial unique index enforces that each user has at most one active config per provider.

This section has no code dependencies on other sections — it can be implemented in parallel.

**Existing codebase patterns to match:**
- Migrations use `TO authenticated` and `(SELECT auth.uid())` (initPlan caching) for RLS policies — see `supabase/migrations/20260315000001_simplify_rls.sql`
- The cleanup function in `web/__tests__/integration/setup.ts` deletes in FK-dependency order and logs warnings instead of throwing on cleanup errors

## What to Create

### Migration file: `supabase/migrations/YYYYMMDDHHMMSS_create_model_configs.sql`

Use the current timestamp for `YYYYMMDDHHMMSS` (format: `YYYYMMDDHHmmss`). The last migration is `20260320000000`, so the timestamp must be greater than that.

```sql
-- Model configurations: per-user enrichment model settings
-- Allows users to configure their own model provider instead of hardcoded Anthropic

CREATE TABLE model_configs (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    provider          text NOT NULL DEFAULT 'anthropic',
    base_url          text,
    model             text NOT NULL,
    api_key_encrypted text,
    is_active         boolean NOT NULL DEFAULT true,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Partial unique index: one active config per user per provider.
-- Inactive configs (is_active = false) are not constrained, allowing
-- historical records or soft-deleted configs to coexist.
CREATE UNIQUE INDEX model_configs_user_provider_active
    ON model_configs (user_id, provider)
    WHERE is_active = true;

-- Row Level Security
ALTER TABLE model_configs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own model configs"
ON model_configs FOR SELECT
TO authenticated
USING ((SELECT auth.uid()) = user_id);

CREATE POLICY "Users can insert own model configs"
ON model_configs FOR INSERT
TO authenticated
WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE POLICY "Users can update own model configs"
ON model_configs FOR UPDATE
TO authenticated
USING ((SELECT auth.uid()) = user_id);

CREATE POLICY "Users can delete own model configs"
ON model_configs FOR DELETE
TO authenticated
USING ((SELECT auth.uid()) = user_id);
```

Key decisions:
- **`ON DELETE CASCADE` on `user_id`** — when an auth user is deleted, their model configs are automatically removed. This matches the referential integrity pattern used by other tables.
- **No `service_role` policy** — the service role bypasses RLS entirely in Supabase (it uses the `postgres` role), so an explicit policy is unnecessary. The existing tables in this codebase do not have service role policies either. See `20260315000001_simplify_rls.sql` for confirmation.
- **`TO authenticated`** — blocks anonymous access. Matches the pattern in `20260315000001_simplify_rls.sql`.
- **`(SELECT auth.uid())`** — uses a subquery instead of a bare function call so Postgres can cache the result via initPlan optimization. Same pattern as all other RLS policies in this codebase.
- **Separate policies per operation** (SELECT, INSERT, UPDATE, DELETE) rather than a single `FOR ALL` — this matches the bucket_configs pattern and gives finer-grained control if policy logic diverges later (e.g., adding admin read access without write).
- **`api_key_encrypted` is nullable** — some providers (like local Ollama) don't require an API key.
- **`base_url` is nullable** — providers with well-known endpoints (e.g., Anthropic, OpenAI) don't need a custom URL. Local/self-hosted providers will set this.
- **No explicit index on `user_id`** — the partial unique index on `(user_id, provider) WHERE is_active = true` covers the primary query pattern (looking up a user's active config for a given provider). A standalone `user_id` index would be redundant for this access pattern.

## What to Modify

### `web/__tests__/integration/setup.ts`

Add `model_configs` to the `cleanupUserData()` function's table list. Insert it **before** the `events` entry. No other tables have foreign keys pointing to `model_configs`, so it can be deleted at any point before the auth user deletion, but placing it early (before `events`) groups it with the other leaf tables.

**Current code (lines 261-268):**

```typescript
  const tables = [
    { name: "enrichments", column: "user_id" },
    { name: "watched_keys", column: "user_id" },
    { name: "events", column: "user_id" },
    { name: "bucket_configs", column: "user_id" },
    { name: "conversations", column: "user_id" },
    { name: "user_profiles", column: "id" },
  ];
```

**Change to:**

```typescript
  const tables = [
    { name: "enrichments", column: "user_id" },
    { name: "watched_keys", column: "user_id" },
    { name: "model_configs", column: "user_id" },
    { name: "events", column: "user_id" },
    { name: "bucket_configs", column: "user_id" },
    { name: "conversations", column: "user_id" },
    { name: "user_profiles", column: "id" },
  ];
```

That is the only change to this file. Do not modify `cleanupTestData()` (the older function on lines 63-76) — it is a legacy function that will be removed separately.

## Tests to Write First (TDD)

Write these tests in a new file: `web/__tests__/integration/model-configs.test.ts`

Follow the patterns in `web/__tests__/integration/tenant-isolation.test.ts` and `web/__tests__/integration/schema-contract.test.ts` for setup/teardown and assertion style.

```typescript
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
});

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

describe("model_configs table existence", () => {
  it("should exist in the database", async () => {
    const { data, error } = await admin.rpc("schema_info");
    expect(error).toBeNull();
    const tableNames = data.tables.map(
      (t: { table_name: string }) => t.table_name,
    );
    expect(tableNames).toContain("model_configs");
  });
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
    // Insert first active config
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

    // Attempt second active config with same user+provider
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
    // Create a disposable user
    const disposable = await createTestUser();
    const disposableId = disposable.userId;

    // Insert a config for that user
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

    // Delete the auth user
    await admin.auth.admin.deleteUser(disposableId);

    // Config should be gone
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
    // Insert a config for Alice via admin (bypasses RLS)
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
    expect(data!.every((c) => c.user_id === aliceId)).toBe(true);
  });

  it("should prevent Bob from reading Alice's config", async () => {
    const { data, error } = await bobClient
      .from("model_configs")
      .select("*");
    expect(error).toBeNull();
    // Bob should see zero rows (or only his own — never Alice's)
    expect(data!.every((c) => c.user_id === bobId)).toBe(true);
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

    // Verify Alice's config still exists
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
```

### Running the tests

```bash
# Requires local Supabase running
supabase start

# Apply the migration
supabase db reset
# OR: supabase migration up (if supported by your Supabase CLI version)

# Run just the model-configs tests
npx vitest run web/__tests__/integration/model-configs.test.ts
```

## Files to Create/Modify

| File | Action |
|------|--------|
| `supabase/migrations/YYYYMMDDHHMMSS_create_model_configs.sql` | CREATE — new migration file |
| `web/__tests__/integration/setup.ts` | MODIFY — add `model_configs` to `cleanupUserData()` table list |
| `web/__tests__/integration/model-configs.test.ts` | CREATE — integration tests for the new table |

## Acceptance Criteria

1. `supabase db reset` completes without errors (migration applies cleanly)
2. `model_configs` table exists with all columns: `id`, `user_id`, `provider`, `base_url`, `model`, `api_key_encrypted`, `is_active`, `created_at`, `updated_at`
3. `user_id` is NOT NULL and references `auth.users(id)` with CASCADE delete
4. `provider` defaults to `'anthropic'` and is NOT NULL
5. `is_active` defaults to `true` and is NOT NULL
6. The partial unique index `model_configs_user_provider_active` prevents duplicate active configs per user+provider
7. The partial unique index allows multiple inactive configs for the same user+provider
8. RLS is enabled — authenticated users can only access their own rows
9. Anonymous users cannot read or write `model_configs`
10. Service role can read/write all rows (bypasses RLS)
11. `cleanupUserData()` in `setup.ts` deletes `model_configs` rows during test teardown
12. All tests in `model-configs.test.ts` pass against a local Supabase instance
