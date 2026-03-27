import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth/device-codes", () => ({
  generateDeviceCode: vi.fn(),
  generateUserCode: vi.fn(),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(),
}));

import { generateDeviceCode, generateUserCode } from "@/lib/auth/device-codes";
import { createClient } from "@supabase/supabase-js";

const mockGenerateDeviceCode = vi.mocked(generateDeviceCode);
const mockGenerateUserCode = vi.mocked(generateUserCode);
const mockCreateClient = vi.mocked(createClient);

function makeRequest(body: Record<string, unknown> = {}) {
  return new Request("http://localhost:3000/api/auth/device", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeMockSupabase(insertResult: { error: unknown } | null = null) {
  const ltMock = vi.fn().mockResolvedValue({ error: null });
  const deleteMock = vi.fn().mockReturnValue({
    lt: ltMock,
  });

  const insertMock = vi.fn().mockResolvedValue(
    insertResult ?? { error: null },
  );

  return {
    from: vi.fn().mockReturnValue({
      insert: insertMock,
      delete: deleteMock,
    }),
    _insertMock: insertMock,
    _deleteMock: deleteMock,
    _ltMock: ltMock,
  };
}

describe("POST /api/auth/device", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "test-anon-key");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "http://localhost:3000");
    vi.clearAllMocks();

    mockGenerateDeviceCode.mockReturnValue(
      "a".repeat(64),
    );
    mockGenerateUserCode.mockReturnValue("ABCD-EFGH");
  });

  async function setupAndCall(
    body: Record<string, unknown> = {},
    supabaseOverride?: ReturnType<typeof makeMockSupabase>,
  ) {
    const mockSupa = supabaseOverride ?? makeMockSupabase();
    mockCreateClient.mockReturnValue(mockSupa as never);
    const { POST } = await import("@/app/api/auth/device/route");
    const response = await POST(makeRequest(body));
    return { response, mockSupa };
  }

  it("returns 201 with correct response shape", async () => {
    const { response } = await setupAndCall();
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.device_code).toBe("a".repeat(64));
    expect(body.user_code).toBe("ABCD-EFGH");
    expect(body.verification_url).toContain("ABCD-EFGH");
    expect(body.interval).toBe(5);
    expect(body.expires_at).toBeDefined();
  });

  it("device_code is the 64-char hex from generateDeviceCode", async () => {
    const { response } = await setupAndCall();
    const body = await response.json();
    expect(body.device_code).toBe("a".repeat(64));
    expect(body.device_code).toHaveLength(64);
  });

  it("user_code matches XXXX-XXXX format", async () => {
    const { response } = await setupAndCall();
    const body = await response.json();
    expect(body.user_code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  });

  it("verification_url contains user_code as query parameter", async () => {
    const { response } = await setupAndCall();
    const body = await response.json();
    const url = new URL(body.verification_url);
    expect(url.searchParams.get("code")).toBe("ABCD-EFGH");
    expect(url.pathname).toBe("/auth/device");
  });

  it("expires_at is approximately 10 minutes in the future", async () => {
    const now = Date.now();
    const { response } = await setupAndCall();
    const body = await response.json();
    const expiresAt = new Date(body.expires_at).getTime();
    const diffMinutes = (expiresAt - now) / 60_000;
    expect(diffMinutes).toBeGreaterThan(9);
    expect(diffMinutes).toBeLessThan(11);
  });

  it("interval is 5", async () => {
    const { response } = await setupAndCall();
    const body = await response.json();
    expect(body.interval).toBe(5);
  });

  it("accepts optional device_name in body", async () => {
    const mockSupa = makeMockSupabase();
    const { response } = await setupAndCall(
      { device_name: "my-laptop" },
      mockSupa,
    );
    expect(response.status).toBe(201);
    expect(mockSupa._insertMock).toHaveBeenCalledWith(
      expect.objectContaining({ device_name: "my-laptop" }),
    );
  });

  it("retries user_code generation on unique constraint collision", async () => {
    const mockSupa = makeMockSupabase();
    mockSupa._insertMock
      .mockResolvedValueOnce({
        error: { code: "23505", message: "unique_violation" },
      })
      .mockResolvedValueOnce({ error: null });

    mockGenerateUserCode
      .mockReturnValueOnce("AAAA-BBBB")
      .mockReturnValueOnce("CCCC-DDDD");

    mockCreateClient.mockReturnValue(mockSupa as never);
    const { POST } = await import("@/app/api/auth/device/route");
    const response = await POST(makeRequest());

    expect(response.status).toBe(201);
    expect(mockGenerateUserCode).toHaveBeenCalledTimes(2);
  });

  it("returns 500 after max retries exhausted", async () => {
    const mockSupa = makeMockSupabase();
    mockSupa._insertMock.mockResolvedValue({
      error: { code: "23505", message: "unique_violation" },
    });

    mockCreateClient.mockReturnValue(mockSupa as never);
    const { POST } = await import("@/app/api/auth/device/route");
    const response = await POST(makeRequest());

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBeDefined();
  });

  it("calls delete for expired rows with correct threshold", async () => {
    const now = Date.now();
    const mockSupa = makeMockSupabase();
    const { response } = await setupAndCall({}, mockSupa);
    expect(response.status).toBe(201);

    expect(mockSupa._deleteMock).toHaveBeenCalled();
    expect(mockSupa._ltMock).toHaveBeenCalledWith(
      "expires_at",
      expect.any(String),
    );

    // Verify threshold is approximately 1 hour ago
    const threshold = new Date(mockSupa._ltMock.mock.calls[0][1]).getTime();
    const diffMinutes = (now - threshold) / 60_000;
    expect(diffMinutes).toBeGreaterThan(58);
    expect(diffMinutes).toBeLessThan(62);
  });

  it("returns 500 with Supabase error on non-retryable insert failure", async () => {
    const mockSupa = makeMockSupabase();
    mockSupa._insertMock.mockResolvedValue({
      error: { code: "42P01", message: "relation does not exist", details: "device_codes" },
    });

    mockCreateClient.mockReturnValue(mockSupa as never);
    const { POST } = await import("@/app/api/auth/device/route");
    const response = await POST(makeRequest());

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error.code).toBe("42P01");
    expect(body.error.message).toBe("relation does not exist");
  });
});
