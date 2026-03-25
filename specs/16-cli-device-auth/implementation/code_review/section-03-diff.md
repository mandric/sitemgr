diff --git a/web/__tests__/device-initiate-route.test.ts b/web/__tests__/device-initiate-route.test.ts
new file mode 100644
index 0000000..f246953
--- /dev/null
+++ b/web/__tests__/device-initiate-route.test.ts
@@ -0,0 +1,178 @@
+import { describe, it, expect, vi, beforeEach } from "vitest";
+
+vi.mock("@/lib/auth/device-codes", () => ({
+  generateDeviceCode: vi.fn(),
+  generateUserCode: vi.fn(),
+}));
+
+vi.mock("@supabase/supabase-js", () => ({
+  createClient: vi.fn(),
+}));
+
+import { generateDeviceCode, generateUserCode } from "@/lib/auth/device-codes";
+import { createClient } from "@supabase/supabase-js";
+
+const mockGenerateDeviceCode = vi.mocked(generateDeviceCode);
+const mockGenerateUserCode = vi.mocked(generateUserCode);
+const mockCreateClient = vi.mocked(createClient);
+
+function makeRequest(body: Record<string, unknown> = {}) {
+  return new Request("http://localhost:3000/api/auth/device", {
+    method: "POST",
+    headers: { "content-type": "application/json" },
+    body: JSON.stringify(body),
+  });
+}
+
+function makeMockSupabase(insertResult: { error: unknown } | null = null) {
+  const deleteMock = vi.fn().mockReturnValue({
+    lt: vi.fn().mockResolvedValue({ error: null }),
+  });
+
+  const insertMock = vi.fn().mockResolvedValue(
+    insertResult ?? { error: null },
+  );
+
+  return {
+    from: vi.fn().mockReturnValue({
+      insert: insertMock,
+      delete: deleteMock,
+    }),
+    _insertMock: insertMock,
+    _deleteMock: deleteMock,
+  };
+}
+
+describe("POST /api/auth/device", () => {
+  beforeEach(() => {
+    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321");
+    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "test-anon-key");
+    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "http://localhost:3000");
+    vi.clearAllMocks();
+
+    mockGenerateDeviceCode.mockReturnValue(
+      "a".repeat(64),
+    );
+    mockGenerateUserCode.mockReturnValue("ABCD-EFGH");
+  });
+
+  async function setupAndCall(
+    body: Record<string, unknown> = {},
+    supabaseOverride?: ReturnType<typeof makeMockSupabase>,
+  ) {
+    const mockSupa = supabaseOverride ?? makeMockSupabase();
+    mockCreateClient.mockReturnValue(mockSupa as never);
+    const { POST } = await import("@/app/api/auth/device/route");
+    const response = await POST(makeRequest(body));
+    return { response, mockSupa };
+  }
+
+  it("returns 201 with correct response shape", async () => {
+    const { response } = await setupAndCall();
+    expect(response.status).toBe(201);
+    const body = await response.json();
+    expect(body.device_code).toBe("a".repeat(64));
+    expect(body.user_code).toBe("ABCD-EFGH");
+    expect(body.verification_url).toContain("ABCD-EFGH");
+    expect(body.interval).toBe(5);
+    expect(body.expires_at).toBeDefined();
+  });
+
+  it("device_code is the 64-char hex from generateDeviceCode", async () => {
+    const { response } = await setupAndCall();
+    const body = await response.json();
+    expect(body.device_code).toBe("a".repeat(64));
+    expect(body.device_code).toHaveLength(64);
+  });
+
+  it("user_code matches XXXX-XXXX format", async () => {
+    const { response } = await setupAndCall();
+    const body = await response.json();
+    expect(body.user_code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
+  });
+
+  it("verification_url contains user_code as query parameter", async () => {
+    const { response } = await setupAndCall();
+    const body = await response.json();
+    const url = new URL(body.verification_url);
+    expect(url.searchParams.get("code")).toBe("ABCD-EFGH");
+    expect(url.pathname).toBe("/auth/device");
+  });
+
+  it("expires_at is approximately 10 minutes in the future", async () => {
+    const now = Date.now();
+    const { response } = await setupAndCall();
+    const body = await response.json();
+    const expiresAt = new Date(body.expires_at).getTime();
+    const diffMinutes = (expiresAt - now) / 60_000;
+    expect(diffMinutes).toBeGreaterThan(9);
+    expect(diffMinutes).toBeLessThan(11);
+  });
+
+  it("interval is 5", async () => {
+    const { response } = await setupAndCall();
+    const body = await response.json();
+    expect(body.interval).toBe(5);
+  });
+
+  it("accepts optional device_name in body", async () => {
+    const mockSupa = makeMockSupabase();
+    const { response } = await setupAndCall(
+      { device_name: "my-laptop" },
+      mockSupa,
+    );
+    expect(response.status).toBe(201);
+    expect(mockSupa._insertMock).toHaveBeenCalledWith(
+      expect.objectContaining({ device_name: "my-laptop" }),
+    );
+  });
+
+  it("retries user_code generation on unique constraint collision", async () => {
+    const mockSupa = makeMockSupabase();
+    mockSupa._insertMock
+      .mockResolvedValueOnce({
+        error: { code: "23505", message: "unique_violation" },
+      })
+      .mockResolvedValueOnce({ error: null });
+
+    mockGenerateUserCode
+      .mockReturnValueOnce("AAAA-BBBB")
+      .mockReturnValueOnce("CCCC-DDDD");
+
+    mockCreateClient.mockReturnValue(mockSupa as never);
+    const { POST } = await import("@/app/api/auth/device/route");
+    const response = await POST(makeRequest());
+
+    expect(response.status).toBe(201);
+    expect(mockGenerateUserCode).toHaveBeenCalledTimes(2);
+  });
+
+  it("returns 500 after max retries exhausted", async () => {
+    const mockSupa = makeMockSupabase();
+    mockSupa._insertMock.mockResolvedValue({
+      error: { code: "23505", message: "unique_violation" },
+    });
+
+    mockCreateClient.mockReturnValue(mockSupa as never);
+    const { POST } = await import("@/app/api/auth/device/route");
+    const response = await POST(makeRequest());
+
+    expect(response.status).toBe(500);
+    const body = await response.json();
+    expect(body.error).toBeDefined();
+  });
+
+  it("calls delete for expired rows (cleanup)", async () => {
+    const mockSupa = makeMockSupabase();
+    const { response } = await setupAndCall({}, mockSupa);
+    expect(response.status).toBe(201);
+
+    // Verify cleanup was called
+    const fromCalls = mockSupa.from.mock.calls;
+    const deleteCalls = fromCalls.filter(
+      (call) => call[0] === "device_codes",
+    );
+    expect(deleteCalls.length).toBeGreaterThanOrEqual(1);
+    expect(mockSupa._deleteMock).toHaveBeenCalled();
+  });
+});
diff --git a/web/app/api/auth/device/route.ts b/web/app/api/auth/device/route.ts
new file mode 100644
index 0000000..1ba09df
--- /dev/null
+++ b/web/app/api/auth/device/route.ts
@@ -0,0 +1,85 @@
+import { NextResponse } from "next/server";
+import { createClient } from "@supabase/supabase-js";
+import { generateDeviceCode, generateUserCode } from "@/lib/auth/device-codes";
+
+const MAX_RETRIES = 3;
+const EXPIRY_MINUTES = 10;
+const CLEANUP_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour
+
+export async function POST(request: Request) {
+  const supabase = createClient(
+    process.env.NEXT_PUBLIC_SUPABASE_URL!,
+    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
+  );
+
+  let body: { device_name?: string } = {};
+  try {
+    body = await request.json();
+  } catch {
+    // Empty body is fine — device_name is optional
+  }
+
+  const device_name = body.device_name ?? "unknown";
+  const device_code = generateDeviceCode();
+  const expires_at = new Date(Date.now() + EXPIRY_MINUTES * 60 * 1000).toISOString();
+  const client_ip = request.headers.get("x-forwarded-for") ?? "unknown";
+
+  const siteUrl =
+    process.env.NEXT_PUBLIC_SITE_URL ??
+    request.headers.get("origin") ??
+    "http://localhost:3000";
+
+  let user_code = generateUserCode();
+
+  // Insert with retry on user_code collision
+  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
+    const verification_url = `${siteUrl}/auth/device?code=${user_code}`;
+
+    const { error } = await supabase.from("device_codes").insert({
+      device_code,
+      user_code,
+      status: "pending",
+      device_name,
+      expires_at,
+      client_ip,
+    });
+
+    if (!error) {
+      // Fire-and-forget cleanup of expired rows
+      supabase
+        .from("device_codes")
+        .delete()
+        .lt("expires_at", new Date(Date.now() - CLEANUP_THRESHOLD_MS).toISOString())
+        .then(({ error: cleanupErr }) => {
+          if (cleanupErr) {
+            console.warn("[device-auth] cleanup failed:", cleanupErr.message);
+          }
+        });
+
+      return NextResponse.json(
+        {
+          device_code,
+          user_code,
+          verification_url,
+          expires_at,
+          interval: 5,
+        },
+        { status: 201 },
+      );
+    }
+
+    // Retry on unique_violation (user_code collision)
+    if (error.code === "23505") {
+      user_code = generateUserCode();
+      continue;
+    }
+
+    // Non-retryable error
+    return NextResponse.json({ error }, { status: 500 });
+  }
+
+  return NextResponse.json(
+    { error: "Failed to generate unique code" },
+    { status: 500 },
+  );
+}
