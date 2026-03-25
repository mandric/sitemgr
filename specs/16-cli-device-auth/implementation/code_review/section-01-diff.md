diff --git a/supabase/migrations/20260325000000_device_codes.sql b/supabase/migrations/20260325000000_device_codes.sql
new file mode 100644
index 0000000..132cb5f
--- /dev/null
+++ b/supabase/migrations/20260325000000_device_codes.sql
@@ -0,0 +1,69 @@
+-- Device code authorization flow table.
+-- Tracks pending/approved/expired device authorization requests
+-- for the CLI device code auth flow (RFC 8628-inspired).
+--
+-- RLS: anon can INSERT only. All reads go through get_device_code_status() RPC.
+-- Service role bypasses RLS for updates (approve endpoint).
+
+CREATE TABLE device_codes (
+  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
+  device_code text NOT NULL UNIQUE,
+  user_code text NOT NULL,
+  status text NOT NULL DEFAULT 'pending'
+    CHECK (status IN ('pending', 'approved', 'expired', 'denied', 'consumed')),
+  user_id uuid REFERENCES auth.users(id),
+  device_name text,
+  email text,
+  token_hash text,
+  client_ip inet,
+  expires_at timestamptz NOT NULL,
+  created_at timestamptz NOT NULL DEFAULT now(),
+  approved_at timestamptz,
+  last_polled_at timestamptz
+);
+
+-- Partial unique index: only one pending row per user_code at a time
+CREATE UNIQUE INDEX idx_device_codes_user_code_pending
+  ON device_codes (user_code) WHERE status = 'pending';
+
+-- Cleanup queries use expires_at
+CREATE INDEX idx_device_codes_expires_at
+  ON device_codes (expires_at);
+
+ALTER TABLE device_codes ENABLE ROW LEVEL SECURITY;
+
+-- Anon can insert (CLI initiates the flow before authentication)
+CREATE POLICY "Anon can initiate device code flow"
+  ON device_codes FOR INSERT
+  TO anon
+  WITH CHECK (true);
+
+-- No SELECT policy for anon. Reads go through the RPC function.
+-- Service role bypasses RLS for all operations (approve endpoint updates rows).
+
+CREATE OR REPLACE FUNCTION get_device_code_status(p_device_code text)
+RETURNS TABLE (
+  status text,
+  token_hash text,
+  email text,
+  expires_at timestamptz
+)
+LANGUAGE plpgsql
+SECURITY DEFINER
+SET search_path = public
+AS $$
+BEGIN
+  RETURN QUERY
+  SELECT
+    dc.status,
+    dc.token_hash,
+    dc.email,
+    dc.expires_at
+  FROM device_codes dc
+  WHERE dc.device_code = p_device_code;
+END;
+$$;
+
+-- Allow anon and authenticated to call the RPC function
+GRANT EXECUTE ON FUNCTION get_device_code_status(text) TO anon;
+GRANT EXECUTE ON FUNCTION get_device_code_status(text) TO authenticated;
diff --git a/web/__tests__/integration/device-codes-schema.test.ts b/web/__tests__/integration/device-codes-schema.test.ts
new file mode 100644
index 0000000..d6c7e16
--- /dev/null
+++ b/web/__tests__/integration/device-codes-schema.test.ts
@@ -0,0 +1,209 @@
+/**
+ * Schema and RLS tests for device_codes table.
+ * Requires `supabase start` running locally.
+ */
+import { describe, it, expect, beforeAll, afterAll } from "vitest";
+import { createClient, type SupabaseClient } from "@supabase/supabase-js";
+import { getAdminClient, getSupabaseConfig } from "./setup";
+
+interface SchemaInfo {
+  tables: Array<{ table_name: string; has_rls: boolean }>;
+  columns: Array<{
+    table_name: string;
+    column_name: string;
+    is_nullable: boolean;
+    data_type: string;
+  }>;
+  indexes: Array<{ index_name: string; table_name: string }>;
+  functions: Array<{
+    function_name: string;
+    argument_types: string;
+    return_type: string;
+  }>;
+  policies: Array<{
+    table_name: string;
+    policy_name: string;
+    command: string;
+    roles: string[];
+  }>;
+}
+
+let admin: SupabaseClient;
+let anonClient: SupabaseClient;
+let schema: SchemaInfo;
+const insertedDeviceCodes: string[] = [];
+
+beforeAll(async () => {
+  admin = getAdminClient();
+  const config = getSupabaseConfig();
+  anonClient = createClient(config.url, config.anonKey, {
+    auth: { autoRefreshToken: false, persistSession: false },
+  });
+
+  const { data, error } = await admin.rpc("schema_info");
+  if (error) {
+    throw new Error(
+      `schema_info() RPC failed — migration may not be applied: ${error.message}`,
+    );
+  }
+  schema = data as SchemaInfo;
+});
+
+afterAll(async () => {
+  // Clean up any inserted device_codes
+  for (const dc of insertedDeviceCodes) {
+    await admin.from("device_codes").delete().eq("device_code", dc);
+  }
+  await admin.removeAllChannels();
+});
+
+function columnsFor(table: string) {
+  return schema.columns.filter((c) => c.table_name === table);
+}
+
+function columnNames(table: string) {
+  return columnsFor(table).map((c) => c.column_name);
+}
+
+function uniqueDeviceCode() {
+  return `test-dc-${Date.now()}-${Math.random().toString(36).slice(2)}`;
+}
+
+function uniqueUserCode() {
+  return `TST-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
+}
+
+describe("device_codes schema validation", () => {
+  it("table exists with RLS enabled", () => {
+    const table = schema.tables.find((t) => t.table_name === "device_codes");
+    expect(table, "device_codes table should exist").toBeDefined();
+    expect(table!.has_rls, "device_codes should have RLS enabled").toBe(true);
+  });
+
+  it("has all expected columns", () => {
+    const cols = columnNames("device_codes");
+    for (const expected of [
+      "id",
+      "device_code",
+      "user_code",
+      "status",
+      "user_id",
+      "device_name",
+      "email",
+      "token_hash",
+      "client_ip",
+      "expires_at",
+      "created_at",
+      "approved_at",
+      "last_polled_at",
+    ]) {
+      expect(cols, `should have column ${expected}`).toContain(expected);
+    }
+  });
+
+  it("has partial unique index on user_code WHERE status = pending", () => {
+    const indexNames = schema.indexes.map((i) => i.index_name);
+    expect(indexNames).toContain("idx_device_codes_user_code_pending");
+  });
+
+  it("has unique index on device_code", () => {
+    const indexNames = schema.indexes.map((i) => i.index_name);
+    expect(indexNames).toContain("device_codes_device_code_key");
+  });
+
+  it("has index on expires_at", () => {
+    const indexNames = schema.indexes.map((i) => i.index_name);
+    expect(indexNames).toContain("idx_device_codes_expires_at");
+  });
+
+  it("get_device_code_status function exists with text argument", () => {
+    const fn = schema.functions.find(
+      (f) => f.function_name === "get_device_code_status",
+    );
+    expect(fn, "get_device_code_status should exist").toBeDefined();
+    expect(fn!.argument_types).toBe("text");
+  });
+});
+
+describe("get_device_code_status RPC behavior", () => {
+  const testDeviceCode = uniqueDeviceCode();
+  const testUserCode = uniqueUserCode();
+
+  beforeAll(async () => {
+    // Insert a test row via admin
+    const { error } = await admin.from("device_codes").insert({
+      device_code: testDeviceCode,
+      user_code: testUserCode,
+      status: "approved",
+      email: "test@example.com",
+      token_hash: "test-hash-abc",
+      expires_at: new Date(Date.now() + 600_000).toISOString(),
+    });
+    if (error) throw new Error(`Failed to insert test device_code: ${error.message}`);
+    insertedDeviceCodes.push(testDeviceCode);
+  });
+
+  it("returns status, token_hash, email, expires_at for matching device_code", async () => {
+    const { data, error } = await anonClient.rpc("get_device_code_status", {
+      p_device_code: testDeviceCode,
+    });
+    expect(error).toBeNull();
+    expect(data).toHaveLength(1);
+    expect(data[0].status).toBe("approved");
+    expect(data[0].token_hash).toBe("test-hash-abc");
+    expect(data[0].email).toBe("test@example.com");
+    expect(data[0].expires_at).toBeDefined();
+  });
+
+  it("returns empty for non-existent device_code", async () => {
+    const { data, error } = await anonClient.rpc("get_device_code_status", {
+      p_device_code: "nonexistent-code",
+    });
+    expect(error).toBeNull();
+    expect(data).toHaveLength(0);
+  });
+});
+
+describe("device_codes RLS policies", () => {
+  it("anon can INSERT into device_codes", async () => {
+    const dc = uniqueDeviceCode();
+    const { error } = await anonClient.from("device_codes").insert({
+      device_code: dc,
+      user_code: uniqueUserCode(),
+      expires_at: new Date(Date.now() + 600_000).toISOString(),
+    });
+    expect(error).toBeNull();
+    insertedDeviceCodes.push(dc);
+  });
+
+  it("anon CANNOT directly SELECT from device_codes", async () => {
+    const { data, error } = await anonClient
+      .from("device_codes")
+      .select("*");
+    // RLS blocks it — either empty results or error
+    if (error) {
+      expect(error).toBeDefined();
+    } else {
+      expect(data).toHaveLength(0);
+    }
+  });
+
+  it("service role can UPDATE device_codes", async () => {
+    const dc = uniqueDeviceCode();
+    // Insert first
+    const { error: insertErr } = await admin.from("device_codes").insert({
+      device_code: dc,
+      user_code: uniqueUserCode(),
+      expires_at: new Date(Date.now() + 600_000).toISOString(),
+    });
+    expect(insertErr).toBeNull();
+    insertedDeviceCodes.push(dc);
+
+    // Update via admin (service role)
+    const { error: updateErr } = await admin
+      .from("device_codes")
+      .update({ status: "approved", approved_at: new Date().toISOString() })
+      .eq("device_code", dc);
+    expect(updateErr).toBeNull();
+  });
+});
