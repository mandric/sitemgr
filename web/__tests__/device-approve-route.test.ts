import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the cookie-based server client
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

// Mock the raw Supabase SDK (for admin/service-role client)
vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(),
}));

import { createClient as createServerClient } from "@/lib/supabase/server";
import { createClient as createSdkClient } from "@supabase/supabase-js";

const mockCreateServerClient = vi.mocked(createServerClient);
const mockCreateSdkClient = vi.mocked(createSdkClient);

function makeRequest(body: Record<string, unknown> = {}) {
  return new Request("http://localhost:3000/api/auth/device/approve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

interface MockClientOptions {
  user?: { id: string; email: string } | null;
  userError?: { message: string } | null;
  selectResult?: { data: unknown; error: unknown };
  generateLinkResult?: {
    data: { properties: { hashed_token: string } } | null;
    error: unknown;
  };
  updateResult?: { error: unknown };
}

function setupMocks(opts: MockClientOptions) {
  // Server client (cookie-based) — only used for auth.getUser()
  const serverClient = {
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: opts.user ?? null },
        error: opts.userError ?? (opts.user ? null : { message: "not authenticated" }),
      }),
    },
  };
  mockCreateServerClient.mockResolvedValue(serverClient as never);

  // Admin client (service-role) — used for queries + generateLink
  const singleMock = vi.fn().mockResolvedValue(
    opts.selectResult ?? { data: null, error: { code: "PGRST116" } },
  );
  const gtMock = vi.fn().mockReturnValue({ single: singleMock });
  const eqStatusMock = vi.fn().mockReturnValue({ gt: gtMock });
  const eqCodeMock = vi.fn().mockReturnValue({ eq: eqStatusMock });
  const selectMock = vi.fn().mockReturnValue({ eq: eqCodeMock });

  const updateEqMock = vi.fn().mockResolvedValue(
    opts.updateResult ?? { error: null },
  );
  const updateMock = vi.fn().mockReturnValue({ eq: updateEqMock });

  const adminClient = {
    from: vi.fn().mockReturnValue({
      select: selectMock,
      update: updateMock,
    }),
    auth: {
      admin: {
        generateLink: vi.fn().mockResolvedValue(
          opts.generateLinkResult ?? {
            data: { properties: { hashed_token: "test-hash" } },
            error: null,
          },
        ),
      },
    },
    _updateMock: updateMock,
    _updateEqMock: updateEqMock,
  };
  mockCreateSdkClient.mockReturnValue(adminClient as never);

  return { serverClient, adminClient };
}

describe("POST /api/auth/device/approve", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "test-anon-key");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
    vi.clearAllMocks();
  });

  it("returns 401 if user is not authenticated", async () => {
    setupMocks({ user: null });

    const { POST } = await import("@/app/api/auth/device/approve/route");
    const response = await POST(makeRequest({ user_code: "ABCD-EFGH" }));
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 404 if user_code does not exist or is expired", async () => {
    setupMocks({
      user: { id: "user-uuid", email: "alice@example.com" },
      selectResult: { data: null, error: { code: "PGRST116" } },
    });

    const { POST } = await import("@/app/api/auth/device/approve/route");
    const response = await POST(makeRequest({ user_code: "XXXX-YYYY" }));
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("Code not found or expired");
  });

  it("returns 200 with { success: true } on valid approval", async () => {
    setupMocks({
      user: { id: "user-uuid", email: "alice@example.com" },
      selectResult: {
        data: { id: "row-uuid", user_code: "ABCD-EFGH" },
        error: null,
      },
    });

    const { POST } = await import("@/app/api/auth/device/approve/route");
    const response = await POST(makeRequest({ user_code: "ABCD-EFGH" }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
  });

  it("updates device_code row with correct fields", async () => {
    const { adminClient } = setupMocks({
      user: { id: "user-uuid", email: "alice@example.com" },
      selectResult: {
        data: { id: "row-uuid", user_code: "ABCD-EFGH" },
        error: null,
      },
    });

    const { POST } = await import("@/app/api/auth/device/approve/route");
    await POST(makeRequest({ user_code: "ABCD-EFGH" }));

    expect(adminClient._updateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "approved",
        user_id: "user-uuid",
        email: "alice@example.com",
        token_hash: "test-hash",
        approved_at: expect.any(String),
      }),
    );
    expect(adminClient._updateEqMock).toHaveBeenCalledWith("id", "row-uuid");
  });

  it("calls admin.generateLink with correct parameters", async () => {
    const { adminClient } = setupMocks({
      user: { id: "user-uuid", email: "alice@example.com" },
      selectResult: {
        data: { id: "row-uuid", user_code: "ABCD-EFGH" },
        error: null,
      },
    });

    const { POST } = await import("@/app/api/auth/device/approve/route");
    await POST(makeRequest({ user_code: "ABCD-EFGH" }));

    expect(adminClient.auth.admin.generateLink).toHaveBeenCalledWith({
      type: "magiclink",
      email: "alice@example.com",
    });
  });
});
