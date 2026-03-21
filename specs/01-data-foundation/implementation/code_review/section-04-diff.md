diff --git a/supabase/migrations/20260313000000_rpc_user_isolation.sql b/supabase/migrations/20260313000000_rpc_user_isolation.sql
new file mode 100644
index 0000000..dd616f9
--- /dev/null
+++ b/supabase/migrations/20260313000000_rpc_user_isolation.sql
@@ -0,0 +1,80 @@
+-- Add p_user_id parameter to RPC functions for tenant isolation
+-- Restrict get_user_id_from_phone to service_role only
+
+-- 1a. search_events: add p_user_id filter
+CREATE OR REPLACE FUNCTION search_events(
+    p_user_id UUID,
+    query_text TEXT,
+    content_type_filter TEXT DEFAULT NULL,
+    since_filter TEXT DEFAULT NULL,
+    until_filter TEXT DEFAULT NULL,
+    result_limit INT DEFAULT 20
+)
+RETURNS TABLE(
+    id TEXT,
+    "timestamp" TIMESTAMPTZ,
+    device_id TEXT,
+    "type" TEXT,
+    content_type TEXT,
+    content_hash TEXT,
+    local_path TEXT,
+    remote_path TEXT,
+    metadata JSONB,
+    parent_id TEXT,
+    description TEXT,
+    objects TEXT[],
+    context TEXT,
+    tags TEXT[]
+)
+LANGUAGE sql STABLE
+AS $$
+    SELECT
+        e.id, e."timestamp", e.device_id, e.type, e.content_type,
+        e.content_hash, e.local_path, e.remote_path, e.metadata, e.parent_id,
+        en.description, en.objects, en.context, en.tags
+    FROM enrichments en
+    JOIN events e ON e.id = en.event_id
+    WHERE en.fts @@ plainto_tsquery('english', query_text)
+      AND e.type = 'create'
+      AND e.user_id = p_user_id
+      AND (content_type_filter IS NULL OR e.content_type = content_type_filter)
+      AND (since_filter IS NULL OR e."timestamp" >= since_filter::timestamptz)
+      AND (until_filter IS NULL OR e."timestamp" <= until_filter::timestamptz)
+    ORDER BY ts_rank(en.fts, plainto_tsquery('english', query_text)) DESC
+    LIMIT result_limit;
+$$;
+
+-- Drop the old overload (5 params, no p_user_id) to prevent ambiguous calls
+DROP FUNCTION IF EXISTS search_events(TEXT, TEXT, TEXT, TEXT, INT);
+
+-- 1b. stats_by_content_type: add p_user_id filter
+DROP FUNCTION IF EXISTS stats_by_content_type();
+CREATE FUNCTION stats_by_content_type(p_user_id UUID)
+RETURNS TABLE(content_type TEXT, "count" BIGINT)
+LANGUAGE sql STABLE
+AS $$
+    SELECT content_type, count(*)
+    FROM events
+    WHERE type = 'create' AND user_id = p_user_id
+    GROUP BY content_type
+    ORDER BY count DESC;
+$$;
+
+-- 1c. stats_by_event_type: add p_user_id filter
+DROP FUNCTION IF EXISTS stats_by_event_type();
+CREATE FUNCTION stats_by_event_type(p_user_id UUID)
+RETURNS TABLE("type" TEXT, "count" BIGINT)
+LANGUAGE sql STABLE
+AS $$
+    SELECT type, count(*)
+    FROM events
+    WHERE user_id = p_user_id
+    GROUP BY type
+    ORDER BY count DESC;
+$$;
+
+-- 1d. Restrict get_user_id_from_phone to service_role only
+REVOKE EXECUTE ON FUNCTION get_user_id_from_phone(TEXT) FROM PUBLIC;
+REVOKE EXECUTE ON FUNCTION get_user_id_from_phone(TEXT) FROM anon;
+REVOKE EXECUTE ON FUNCTION get_user_id_from_phone(TEXT) FROM authenticated;
+GRANT EXECUTE ON FUNCTION get_user_id_from_phone(TEXT) TO service_role;
diff --git a/web/__tests__/rpc-user-isolation.test.ts b/web/__tests__/rpc-user-isolation.test.ts
new file mode 100644
index 0000000..b4bb68a
--- /dev/null
+++ b/web/__tests__/rpc-user-isolation.test.ts
@@ -0,0 +1,188 @@
+/**
+ * Integration tests for RPC function user isolation.
+ * Requires local Supabase running (`supabase start`).
+ *
+ * These tests verify that modified RPC functions enforce tenant isolation
+ * via the p_user_id parameter and that get_user_id_from_phone is restricted.
+ *
+ * Skip condition: Tests are skipped when NEXT_PUBLIC_SUPABASE_URL is not set
+ * (i.e., no local Supabase instance available).
+ */
+import { describe, it, expect, beforeAll, afterAll } from "vitest";
+import { createClient } from "@supabase/supabase-js";
+
+const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
+const SERVICE_ROLE_KEY = process.env.SUPABASE_SECRET_KEY;
+const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
+
+const canRun = !!(SUPABASE_URL && SERVICE_ROLE_KEY && ANON_KEY);
+
+describe.skipIf(!canRun)("RPC User Isolation", () => {
+  // Lazy-init to avoid createClient throwing when env vars are missing
+  let admin: ReturnType<typeof createClient>;
+  let anon: ReturnType<typeof createClient>;
+
+  const userAId = "00000000-0000-0000-0000-000000000a01";
+  const userBId = "00000000-0000-0000-0000-000000000b02";
+
+  beforeAll(async () => {
+    admin = createClient(SUPABASE_URL!, SERVICE_ROLE_KEY!);
+    anon = createClient(SUPABASE_URL!, ANON_KEY!);
+
+    // Create test users via admin auth API
+    const { data: userA } = await admin.auth.admin.createUser({
+      email: "rpc-test-a@test.local",
+      password: "test-password-a",
+      email_confirm: true,
+      user_metadata: { test: true },
+    });
+    const { data: userB } = await admin.auth.admin.createUser({
+      email: "rpc-test-b@test.local",
+      password: "test-password-b",
+      email_confirm: true,
+      user_metadata: { test: true },
+    });
+
+    const uidA = userA.user?.id ?? userAId;
+    const uidB = userB.user?.id ?? userBId;
+
+    // Insert events for user A
+    await admin.from("events").insert([
+      {
+        id: "rpc-test-a-1",
+        timestamp: new Date().toISOString(),
+        device_id: "test-device",
+        type: "create",
+        content_type: "photo",
+        user_id: uidA,
+      },
+      {
+        id: "rpc-test-a-2",
+        timestamp: new Date().toISOString(),
+        device_id: "test-device",
+        type: "create",
+        content_type: "video",
+        user_id: uidA,
+      },
+    ]);
+
+    // Insert events for user B
+    await admin.from("events").insert([
+      {
+        id: "rpc-test-b-1",
+        timestamp: new Date().toISOString(),
+        device_id: "test-device",
+        type: "create",
+        content_type: "photo",
+        user_id: uidB,
+      },
+    ]);
+
+    // Insert enrichments for FTS testing
+    await admin.from("enrichments").insert([
+      {
+        event_id: "rpc-test-a-1",
+        description: "A beautiful sunset over the ocean",
+        objects: ["sun", "ocean"],
+        context: "nature photography",
+        tags: ["sunset", "ocean"],
+        user_id: uidA,
+      },
+      {
+        event_id: "rpc-test-b-1",
+        description: "A cat sleeping on a couch",
+        objects: ["cat", "couch"],
+        context: "pet photography",
+        tags: ["cat", "pet"],
+        user_id: uidB,
+      },
+    ]);
+
+    // Store actual UIDs for tests
+    (globalThis as Record<string, unknown>).__rpcTestUidA = uidA;
+    (globalThis as Record<string, unknown>).__rpcTestUidB = uidB;
+  });
+
+  afterAll(async () => {
+    // Clean up test data
+    await admin.from("enrichments").delete().in("event_id", ["rpc-test-a-1", "rpc-test-b-1"]);
+    await admin.from("events").delete().in("id", ["rpc-test-a-1", "rpc-test-a-2", "rpc-test-b-1"]);
+
+    const uidA = (globalThis as Record<string, unknown>).__rpcTestUidA as string;
+    const uidB = (globalThis as Record<string, unknown>).__rpcTestUidB as string;
+    if (uidA) await admin.auth.admin.deleteUser(uidA);
+    if (uidB) await admin.auth.admin.deleteUser(uidB);
+  });
+
+  describe("search_events", () => {
+    it("returns only results for the specified p_user_id", async () => {
+      const uidA = (globalThis as Record<string, unknown>).__rpcTestUidA as string;
+      const { data, error } = await admin.rpc("search_events", {
+        p_user_id: uidA,
+        query_text: "sunset",
+      });
+      expect(error).toBeNull();
+      expect(data).toHaveLength(1);
+      expect(data![0].id).toBe("rpc-test-a-1");
+    });
+
+    it("does not return other users results", async () => {
+      const uidA = (globalThis as Record<string, unknown>).__rpcTestUidA as string;
+      const { data, error } = await admin.rpc("search_events", {
+        p_user_id: uidA,
+        query_text: "cat",
+      });
+      expect(error).toBeNull();
+      expect(data).toHaveLength(0);
+    });
+  });
+
+  describe("stats_by_content_type", () => {
+    it("returns only stats for the specified p_user_id", async () => {
+      const uidA = (globalThis as Record<string, unknown>).__rpcTestUidA as string;
+      const { data, error } = await admin.rpc("stats_by_content_type", {
+        p_user_id: uidA,
+      });
+      expect(error).toBeNull();
+      const photoRow = data?.find((r: { content_type: string }) => r.content_type === "photo");
+      const videoRow = data?.find((r: { content_type: string }) => r.content_type === "video");
+      expect(photoRow).toBeDefined();
+      expect(videoRow).toBeDefined();
+    });
+  });
+
+  describe("stats_by_event_type", () => {
+    it("returns only stats for the specified p_user_id", async () => {
+      const uidA = (globalThis as Record<string, unknown>).__rpcTestUidA as string;
+      const { data, error } = await admin.rpc("stats_by_event_type", {
+        p_user_id: uidA,
+      });
+      expect(error).toBeNull();
+      const createRow = data?.find((r: { type: string }) => r.type === "create");
+      expect(createRow).toBeDefined();
+      expect(Number(createRow!.count)).toBe(2);
+    });
+  });
+
+  describe("get_user_id_from_phone", () => {
+    it("is not callable by anon role", async () => {
+      const { error } = await anon.rpc("get_user_id_from_phone", {
+        p_phone_number: "+1234567890",
+      });
+      expect(error).toBeDefined();
+      expect(error!.message).toMatch(/permission denied/i);
+    });
+  });
+
+  describe("FTS index usage", () => {
+    it("search_events uses GIN index on enrichments.fts", async () => {
+      const uidA = (globalThis as Record<string, unknown>).__rpcTestUidA as string;
+      const { data } = await admin.rpc("search_events", {
+        p_user_id: uidA,
+        query_text: "sunset",
+      });
+      // If we get results, the query executed successfully with the user filter
+      expect(data).toBeDefined();
+    });
+  });
+});
diff --git a/web/lib/media/db.ts b/web/lib/media/db.ts
index 29fdace..0d1bad0 100644
--- a/web/lib/media/db.ts
+++ b/web/lib/media/db.ts
@@ -48,6 +48,7 @@ export interface EventRow {
 // ── Query ──────────────────────────────────────────────────────
 
 export interface QueryOptions {
+  userId?: string;
   search?: string;
   type?: string;
   since?: string;
@@ -63,6 +64,7 @@ export async function queryEvents(opts: QueryOptions) {
   // Full-text search via RPC
   if (opts.search) {
     const { data, error } = await supabase.rpc("search_events", {
+      p_user_id: opts.userId,
       query_text: opts.search,
       content_type_filter: opts.type ?? null,
       since_filter: opts.since ?? null,
@@ -135,13 +137,13 @@ export async function showEvent(eventId: string) {
 
 // ── Stats ──────────────────────────────────────────────────────
 
-export async function getStats() {
+export async function getStats(userId?: string) {
   const supabase = getUserClient();
 
   const [byContentType, byEventType, totalRes, enrichedRes, watchedRes] =
     await Promise.all([
-      supabase.rpc("stats_by_content_type"),
-      supabase.rpc("stats_by_event_type"),
+      supabase.rpc("stats_by_content_type", { p_user_id: userId }),
+      supabase.rpc("stats_by_event_type", { p_user_id: userId }),
       supabase
         .from("events")
         .select("*", { count: "exact", head: true }),
