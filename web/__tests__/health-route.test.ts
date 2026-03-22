import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/media/db", () => ({
  getUserClient: vi.fn(),
  getAdminClient: vi.fn(),
}));

import { getUserClient, getAdminClient } from "@/lib/media/db";
import { GET } from "@/app/api/health/route";

const mockGetUserClient = vi.mocked(getUserClient);
const mockGetAdminClient = vi.mocked(getAdminClient);

function makeMockClient(queryError: { message: string } | null = null) {
  return {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue({ error: queryError }),
      }),
    }),
  } as unknown as ReturnType<typeof getUserClient>;
}

describe("GET /api/health", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "test-anon-key");
    vi.clearAllMocks();
  });

  it("creates a user client, not an admin client", async () => {
    mockGetUserClient.mockReturnValue(makeMockClient());
    await GET();
    expect(mockGetUserClient).toHaveBeenCalledWith({
      url: "http://localhost:54321",
      anonKey: "test-anon-key",
    });
    expect(mockGetAdminClient).not.toHaveBeenCalled();
  });

  it("returns 200 with status 'ok' when DB is reachable", async () => {
    mockGetUserClient.mockReturnValue(makeMockClient());
    const response = await GET();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("ok");
  });

  it("returns 503 when DB query fails", async () => {
    mockGetUserClient.mockReturnValue(
      makeMockClient({ message: "connection refused" }),
    );
    const response = await GET();
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.status).toBe("degraded");
  });

  it("does not reference SUPABASE_SERVICE_ROLE_KEY", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const source = fs.readFileSync(
      path.resolve(__dirname, "../app/api/health/route.ts"),
      "utf-8",
    );
    expect(source).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(source).not.toContain("getAdminClient");
  });
});
