import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/media/db", () => ({
  getUserClient: vi.fn(),
}));

import { getUserClient } from "@/lib/media/db";

const mockGetUserClient = vi.mocked(getUserClient);

function makeRequest(body: Record<string, unknown> = {}) {
  return new Request("http://localhost:3000/api/auth/device/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeMockClient(rpcResult: { data: unknown; error: unknown }) {
  const rpcMock = vi.fn().mockResolvedValue(rpcResult);
  return {
    rpc: rpcMock,
    _rpcMock: rpcMock,
  };
}

describe("POST /api/auth/device/token", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "test-anon-key");
    vi.clearAllMocks();
  });

  it("returns 400 if device_code is missing", async () => {
    const { POST } = await import("@/app/api/auth/device/token/route");
    const response = await POST(makeRequest({}));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("device_code is required");
  });

  it("returns 404 for unknown device code", async () => {
    const mock = makeMockClient({ data: [], error: null });
    mockGetUserClient.mockReturnValue(mock as never);

    const { POST } = await import("@/app/api/auth/device/token/route");
    const response = await POST(makeRequest({ device_code: "unknown" }));
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("Device code not found");
  });

  it("returns { status: 'pending' } for a pending device code", async () => {
    const mock = makeMockClient({
      data: [
        {
          status: "pending",
          token_hash: null,
          email: null,
          expires_at: new Date(Date.now() + 600_000).toISOString(),
        },
      ],
      error: null,
    });
    mockGetUserClient.mockReturnValue(mock as never);

    const { POST } = await import("@/app/api/auth/device/token/route");
    const response = await POST(makeRequest({ device_code: "abc123" }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("pending");
    expect(body.token_hash).toBeUndefined();
  });

  it("returns approved with session fields after server-side verifyOtp", async () => {
    const rpcMock = vi.fn()
      .mockResolvedValueOnce({
        data: [
          {
            status: "approved",
            token_hash: "secret-hash",
            email: "user@example.com",
            expires_at: new Date(Date.now() + 600_000).toISOString(),
          },
        ],
        error: null,
      })
      // consume_device_code call
      .mockResolvedValueOnce({ data: null, error: null });

    const verifyOtpMock = vi.fn().mockResolvedValue({
      data: {
        session: {
          access_token: "at-123",
          refresh_token: "rt-456",
          expires_at: 9999999999,
          user: { id: "user-id-789", email: "user@example.com" },
        },
      },
      error: null,
    });

    mockGetUserClient.mockReturnValue({
      rpc: rpcMock,
      auth: { verifyOtp: verifyOtpMock },
    } as never);

    const { POST } = await import("@/app/api/auth/device/token/route");
    const response = await POST(makeRequest({ device_code: "abc123" }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("approved");
    expect(body.access_token).toBe("at-123");
    expect(body.refresh_token).toBe("rt-456");
    expect(body.user_id).toBe("user-id-789");
    expect(body.email).toBe("user@example.com");

    // Verify consume was called before verifyOtp
    expect(rpcMock).toHaveBeenCalledWith("consume_device_code", {
      p_device_code: "abc123",
    });
    expect(verifyOtpMock).toHaveBeenCalledWith({
      token_hash: "secret-hash",
      type: "magiclink",
    });
  });

  it("returns expired when pending code has passed expires_at", async () => {
    const rpcMock = vi.fn()
      .mockResolvedValueOnce({
        data: [
          {
            status: "pending",
            token_hash: null,
            email: null,
            expires_at: new Date(Date.now() - 60_000).toISOString(),
          },
        ],
        error: null,
      })
      // expire_device_code call
      .mockResolvedValueOnce({ data: null, error: null })
      // update_device_code_polled_at call
      .mockResolvedValueOnce({ data: null, error: null });

    mockGetUserClient.mockReturnValue({ rpc: rpcMock } as never);

    const { POST } = await import("@/app/api/auth/device/token/route");
    const response = await POST(makeRequest({ device_code: "abc123" }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("expired");

    expect(rpcMock).toHaveBeenCalledWith("expire_device_code", {
      p_device_code: "abc123",
    });
  });

  it("returns consumed without token_hash for already consumed code", async () => {
    const mock = makeMockClient({
      data: [
        {
          status: "consumed",
          token_hash: null,
          email: "user@example.com",
          expires_at: new Date(Date.now() + 600_000).toISOString(),
        },
      ],
      error: null,
    });
    mockGetUserClient.mockReturnValue(mock as never);

    const { POST } = await import("@/app/api/auth/device/token/route");
    const response = await POST(makeRequest({ device_code: "abc123" }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("consumed");
    expect(body.token_hash).toBeUndefined();
  });

  it("returns 500 on RPC error", async () => {
    const mock = makeMockClient({
      data: null,
      error: { message: "connection refused", code: "PGRST000" },
    });
    mockGetUserClient.mockReturnValue(mock as never);

    const { POST } = await import("@/app/api/auth/device/token/route");
    const response = await POST(makeRequest({ device_code: "abc123" }));
    expect(response.status).toBe(500);
  });
});
