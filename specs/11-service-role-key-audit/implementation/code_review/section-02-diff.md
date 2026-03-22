diff --git a/web/__tests__/health-route.test.ts b/web/__tests__/health-route.test.ts
new file mode 100644
index 0000000..112b8b4
--- /dev/null
+++ b/web/__tests__/health-route.test.ts
@@ -0,0 +1,69 @@
+import { describe, it, expect, vi, beforeEach } from "vitest";
+
+vi.mock("@/lib/media/db", () => ({
+  getUserClient: vi.fn(),
+  getAdminClient: vi.fn(),
+}));
+
+import { getUserClient, getAdminClient } from "@/lib/media/db";
+import { GET } from "@/app/api/health/route";
+
+const mockGetUserClient = vi.mocked(getUserClient);
+const mockGetAdminClient = vi.mocked(getAdminClient);
+
+function makeMockClient(queryError: { message: string } | null = null) {
+  return {
+    from: vi.fn().mockReturnValue({
+      select: vi.fn().mockReturnValue({
+        limit: vi.fn().mockResolvedValue({ error: queryError }),
+      }),
+    }),
+  } as unknown as ReturnType<typeof getUserClient>;
+}
+
+describe("GET /api/health", () => {
+  beforeEach(() => {
+    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321");
+    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "test-anon-key");
+    vi.clearAllMocks();
+  });
+
+  it("creates a user client, not an admin client", async () => {
+    mockGetUserClient.mockReturnValue(makeMockClient());
+    await GET();
+    expect(mockGetUserClient).toHaveBeenCalledWith({
+      url: "http://localhost:54321",
+      anonKey: "test-anon-key",
+    });
+    expect(mockGetAdminClient).not.toHaveBeenCalled();
+  });
+
+  it("returns 200 with status 'ok' when DB is reachable", async () => {
+    mockGetUserClient.mockReturnValue(makeMockClient());
+    const response = await GET();
+    expect(response.status).toBe(200);
+    const body = await response.json();
+    expect(body.status).toBe("ok");
+  });
+
+  it("returns 503 when DB query fails", async () => {
+    mockGetUserClient.mockReturnValue(
+      makeMockClient({ message: "connection refused" }),
+    );
+    const response = await GET();
+    expect(response.status).toBe(503);
+    const body = await response.json();
+    expect(body.status).toBe("degraded");
+  });
+
+  it("does not reference SUPABASE_SERVICE_ROLE_KEY", async () => {
+    const fs = await import("fs");
+    const path = await import("path");
+    const source = fs.readFileSync(
+      path.resolve(__dirname, "../app/api/health/route.ts"),
+      "utf-8",
+    );
+    expect(source).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
+    expect(source).not.toContain("getAdminClient");
+  });
+});
diff --git a/web/app/api/health/route.ts b/web/app/api/health/route.ts
index 2d167ef..468ab3b 100644
--- a/web/app/api/health/route.ts
+++ b/web/app/api/health/route.ts
@@ -1,5 +1,5 @@
 import { NextResponse } from "next/server";
-import { getAdminClient } from "@/lib/media/db";
+import { getUserClient } from "@/lib/media/db";
 
 // TODO: Add Anthropic API connectivity check (e.g. list models)
 // TODO: Add Twilio API connectivity check (e.g. fetch account info)
@@ -9,9 +9,9 @@ export async function GET() {
 
   // Check Supabase DB connectivity
   try {
-    const supabase = getAdminClient({
+    const supabase = getUserClient({
       url: process.env.NEXT_PUBLIC_SUPABASE_URL!,
-      serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
+      anonKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
     });
     const { error } = await supabase
       .from("events")
