import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock cli-auth module
const mockRefreshSession = vi.fn();
const mockResolveApiConfig = vi.fn();

vi.mock("@/lib/auth/cli-auth", () => ({
  login: vi.fn(),
  clearCredentials: vi.fn(),
  loadCredentials: vi.fn(),
  refreshSession: (...args: unknown[]) => mockRefreshSession(...args),
  resolveApiConfig: (...args: unknown[]) => mockResolveApiConfig(...args),
}));

// Mock db module
const mockSetSession = vi.fn();
const mockUserClient = {
  auth: { setSession: mockSetSession },
  from: vi.fn(),
};
vi.mock("@/lib/media/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/media/db")>();
  return {
    ...actual,
    getUserClient: vi.fn(() => mockUserClient),
  };
});

// Mock process.exit to prevent test runner from dying
vi.spyOn(process, "exit").mockImplementation(() => {
  throw new Error("process.exit called");
});

describe("smgr getClient()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveApiConfig.mockReturnValue({
      url: "http://localhost:54321",
      anonKey: "test-anon-key",
      webUrl: "http://localhost:3000",
    });
    mockRefreshSession.mockResolvedValue({
      access_token: "test-access-token",
      refresh_token: "test-refresh-token",
      user_id: "user-123",
    });
    mockSetSession.mockResolvedValue({ error: null });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns a user client (getUserClient), not an admin client", async () => {
    // We can't easily import getClient directly since it's not exported.
    // Instead verify via static analysis that getAdminClient is not imported.
    const fs = await import("fs");
    const source = fs.readFileSync("bin/smgr.ts", "utf-8");
    expect(source).not.toContain("getAdminClient");
    expect(source).toContain("getUserClient");
  });

  it("does not reference SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("bin/smgr.ts", "utf-8");
    expect(source).not.toContain("SUPABASE_SECRET_KEY");
    expect(source).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
  });

  it("getClient is async (returns a Promise)", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("bin/smgr.ts", "utf-8");
    expect(source).toMatch(/async function getClient\(\)/);
  });

  it("uses SMGR_API_URL and SMGR_API_KEY via resolveApiConfig", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("bin/smgr.ts", "utf-8");
    expect(source).toContain("resolveApiConfig()");
  });
});
