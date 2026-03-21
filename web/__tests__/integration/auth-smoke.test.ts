/**
 * Auth smoke tests — validates that Supabase auth tokens work as expected.
 *
 * These are canary tests: if the JWT algorithm or key format changes upstream
 * (as happened with supabase/cli#4818), these fail first with clear messages
 * instead of cascading into confusing data-layer errors in other test files.
 *
 * Context: specs/11-service-role-key-audit/spec.md
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseConfig, getAdminClient, createTestUser } from "./setup";

describe("auth token smoke tests", () => {
  const cfg = getSupabaseConfig();

  describe("service role key", () => {
    let admin: SupabaseClient;

    beforeAll(() => {
      admin = getAdminClient();
    });

    afterAll(async () => {
      await admin.removeAllChannels();
    });

    it("can list users via auth.admin API", async () => {
      const { data, error } = await admin.auth.admin.listUsers();
      expect(error).toBeNull();
      expect(data.users).toBeDefined();
    });

    it("can create and delete a user via auth.admin API", async () => {
      const email = `auth-smoke-${Date.now()}@test.local`;
      const { data: created, error: createErr } =
        await admin.auth.admin.createUser({
          email,
          password: "test-password-123",
          email_confirm: true,
        });
      expect(createErr).toBeNull();
      expect(created.user).toBeDefined();
      expect(created.user!.email).toBe(email);

      const { error: deleteErr } = await admin.auth.admin.deleteUser(
        created.user!.id,
      );
      expect(deleteErr).toBeNull();
    });

    it("bypasses RLS on PostgREST queries", async () => {
      // Service role should be able to query any table without RLS restrictions
      const { error } = await admin.from("events").select("id").limit(1);
      expect(error).toBeNull();
    });
  });

  describe("anon key", () => {
    let anonClient: SupabaseClient;

    beforeAll(() => {
      anonClient = createClient(cfg.url, cfg.anonKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
    });

    afterAll(async () => {
      await anonClient.removeAllChannels();
    });

    it("is accepted by PostgREST", async () => {
      // Anon key should be a valid JWT that PostgREST accepts,
      // even though RLS will restrict what it can see
      const { error } = await anonClient.from("events").select("id").limit(1);
      expect(error).toBeNull();
    });

    it("can reach the auth endpoints", async () => {
      // Should get a proper auth error, not a JWT rejection
      const { error } = await anonClient.auth.signInWithPassword({
        email: "nonexistent@test.local",
        password: "wrong",
      });
      expect(error).toBeDefined();
      expect(error!.message).toMatch(/invalid/i);
    });
  });

  describe("user JWT", () => {
    let userClient: SupabaseClient;
    let userId: string;
    let admin: SupabaseClient;

    beforeAll(async () => {
      admin = getAdminClient();
      const user = await createTestUser(`auth-smoke-user-${Date.now()}@test.local`);
      userId = user.userId;
      userClient = user.client;
    });

    afterAll(async () => {
      await userClient.auth.signOut();
      await userClient.removeAllChannels();
      await admin.auth.admin.deleteUser(userId);
      await admin.removeAllChannels();
    });

    it("has a valid session after sign-in", async () => {
      const { data, error } = await userClient.auth.getSession();
      expect(error).toBeNull();
      expect(data.session).toBeDefined();
      expect(data.session!.access_token).toBeTruthy();
    });

    it("can query PostgREST with user JWT", async () => {
      const { error } = await userClient.from("events").select("id").limit(1);
      expect(error).toBeNull();
    });

    it("can access auth.getUser() to verify token", async () => {
      const { data, error } = await userClient.auth.getUser();
      expect(error).toBeNull();
      expect(data.user).toBeDefined();
      expect(data.user!.id).toBe(userId);
    });
  });
});
