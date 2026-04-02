import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:child_process", () => ({
  exec: vi.fn(),
}));

// Mock fs operations used by saveCredentials
vi.mock("node:fs", async () => {
  const actual = await vi.importActual("node:fs");
  return {
    ...actual,
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(true),
  };
});

import { login } from "@/lib/auth/cli-auth";

const INITIATE_RESPONSE = {
  device_code: "dc-test-123",
  user_code: "ABCD-EFGH",
  verification_url: "http://localhost:3000/auth/device?code=ABCD-EFGH",
  expires_at: new Date(Date.now() + 600_000).toISOString(),
  interval: 0.01, // very short for tests
};

const APPROVED_SESSION_RESPONSE = {
  status: "approved",
  access_token: "at-123",
  refresh_token: "rt-456",
  user_id: "uid-789",
  email: "user@test.com",
  expires_at: 9999999999,
};

function mockFetchResponses(...responses: Array<{ status: number; body: unknown }>) {
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  for (const r of responses) {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(r.body), { status: r.status }),
    );
  }
  return fetchSpy;
}

describe("login() device code flow", () => {
  beforeEach(() => {
    vi.stubEnv("SITEMGR_WEB_URL", "http://localhost:3000");
    vi.clearAllMocks();

    // Suppress stderr output during tests
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("calls POST /api/auth/device and receives device_code + user_code", async () => {
    const fetchSpy = mockFetchResponses(
      { status: 201, body: INITIATE_RESPONSE },
      { status: 200, body: APPROVED_SESSION_RESPONSE },
    );

    await login("test-device");

    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:3000/api/auth/device",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ device_name: "test-device" }),
      }),
    );
  });

  it("prints user_code to stderr", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    mockFetchResponses(
      { status: 201, body: INITIATE_RESPONSE },
      { status: 200, body: APPROVED_SESSION_RESPONSE },
    );

    await login();

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("ABCD-EFGH"),
    );
  });

  it("polls POST /api/auth/device/token until approved", async () => {
    const fetchSpy = mockFetchResponses(
      { status: 201, body: INITIATE_RESPONSE },
      { status: 200, body: { status: "pending" } },
      { status: 200, body: { status: "pending" } },
      { status: 200, body: APPROVED_SESSION_RESPONSE },
    );

    await login();

    // 1 initiate + 3 polls = 4 fetch calls
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  it("on approved, saves session credentials directly (no verifyOtp)", async () => {
    mockFetchResponses(
      { status: 201, body: INITIATE_RESPONSE },
      { status: 200, body: APPROVED_SESSION_RESPONSE },
    );

    const creds = await login();

    expect(creds.access_token).toBe("at-123");
    expect(creds.refresh_token).toBe("rt-456");
    expect(creds.user_id).toBe("uid-789");
    expect(creds.email).toBe("user@test.com");
  });

  it("throws on expired response", async () => {
    mockFetchResponses(
      { status: 201, body: INITIATE_RESPONSE },
      { status: 200, body: { status: "expired" } },
    );

    await expect(login()).rejects.toThrow(/expired/i);
  });

  it("throws on denied response", async () => {
    mockFetchResponses(
      { status: 201, body: INITIATE_RESPONSE },
      { status: 200, body: { status: "denied" } },
    );

    await expect(login()).rejects.toThrow(/denied/i);
  });

  it("throws when client-side timeout reached", async () => {
    const expiredResponse = {
      ...INITIATE_RESPONSE,
      expires_at: new Date(Date.now() - 1000).toISOString(),
    };

    mockFetchResponses(
      { status: 201, body: expiredResponse },
    );

    await expect(login()).rejects.toThrow(/expired/i);
  });

  it("sends device_name in initiate request body", async () => {
    const fetchSpy = mockFetchResponses(
      { status: 201, body: INITIATE_RESPONSE },
      { status: 200, body: APPROVED_SESSION_RESPONSE },
    );

    await login("my-laptop");

    const initCall = fetchSpy.mock.calls[0];
    const body = JSON.parse(initCall[1]?.body as string);
    expect(body.device_name).toBe("my-laptop");
  });

  it("uses SITEMGR_WEB_URL for fetch calls, not SITEMGR_API_URL", async () => {
    const fetchSpy = mockFetchResponses(
      { status: 201, body: INITIATE_RESPONSE },
      { status: 200, body: APPROVED_SESSION_RESPONSE },
    );

    await login();

    // Both calls should use the web URL, not the Supabase URL
    for (const call of fetchSpy.mock.calls) {
      expect(call[0]).toContain("localhost:3000");
      expect(call[0]).not.toContain("localhost:54321");
    }
  });
});
