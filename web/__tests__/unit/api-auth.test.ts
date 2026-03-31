import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { authenticateRequest, isAuthenticated } from "@/lib/supabase/api-auth";

// Mock @supabase/supabase-js
const mockGetUser = vi.fn();
vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: mockGetUser },
    from: vi.fn(() => ({ select: vi.fn() })),
  })),
}));

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "test-anon-key");
  mockGetUser.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function makeRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost:3000/api/test", { headers });
}

describe("authenticateRequest", () => {
  it("returns 401 when no Authorization header", async () => {
    const result = await authenticateRequest(makeRequest());
    expect(isAuthenticated(result)).toBe(false);
    if (!isAuthenticated(result)) {
      expect(result.status).toBe(401);
    }
  });

  it("returns 401 when Authorization header is not Bearer", async () => {
    const result = await authenticateRequest(
      makeRequest({ authorization: "Basic abc123" }),
    );
    expect(isAuthenticated(result)).toBe(false);
  });

  it("returns 401 when token is invalid", async () => {
    mockGetUser.mockResolvedValueOnce({
      data: { user: null },
      error: { message: "invalid token" },
    });

    const result = await authenticateRequest(
      makeRequest({ authorization: "Bearer bad-token" }),
    );
    expect(isAuthenticated(result)).toBe(false);
  });

  it("returns authenticated context with valid token", async () => {
    mockGetUser.mockResolvedValueOnce({
      data: {
        user: { id: "user-123", email: "test@example.com" },
      },
      error: null,
    });

    const result = await authenticateRequest(
      makeRequest({ authorization: "Bearer valid-token" }),
    );
    expect(isAuthenticated(result)).toBe(true);
    if (isAuthenticated(result)) {
      expect(result.user.id).toBe("user-123");
      expect(result.user.email).toBe("test@example.com");
      expect(result.supabase).toBeDefined();
    }
  });
});
