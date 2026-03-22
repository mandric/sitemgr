import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockGetUser = vi.fn();
const mockFrom = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn().mockResolvedValue({
    auth: { getUser: () => mockGetUser() },
    from: (...args: unknown[]) => mockFrom(...args),
  }),
}));

const mockGetConversationHistory = vi.fn().mockResolvedValue([]);
const mockSendMessageToAgent = vi.fn().mockResolvedValue({ content: "reply" });
const mockSaveConversationHistory = vi.fn().mockResolvedValue(undefined);

vi.mock("@/lib/agent/core", () => ({
  getConversationHistory: (...args: unknown[]) => mockGetConversationHistory(...args),
  sendMessageToAgent: (...args: unknown[]) => mockSendMessageToAgent(...args),
  saveConversationHistory: (...args: unknown[]) => mockSaveConversationHistory(...args),
}));

vi.mock("@/lib/media/db", () => ({
  getStats: vi.fn().mockResolvedValue({ data: { total_events: 0 }, error: null }),
}));

describe("sendMessage server action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUser.mockResolvedValue({
      data: { user: { id: "user-123" } },
    });
    mockFrom.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ data: [] }),
      }),
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("passes the user's server client to getConversationHistory", async () => {
    const { sendMessage } = await import("@/components/agent/actions");
    await sendMessage("hello");

    expect(mockGetConversationHistory).toHaveBeenCalledOnce();
    // First arg should be the supabase client (an object with .auth and .from)
    const client = mockGetConversationHistory.mock.calls[0][0];
    expect(client).toHaveProperty("auth");
    expect(client).toHaveProperty("from");
  });

  it("passes the user's server client to saveConversationHistory", async () => {
    const { sendMessage } = await import("@/components/agent/actions");
    await sendMessage("hello");

    expect(mockSaveConversationHistory).toHaveBeenCalledOnce();
    const client = mockSaveConversationHistory.mock.calls[0][0];
    expect(client).toHaveProperty("auth");
    expect(client).toHaveProperty("from");
  });

  it("does not pass a client to sendMessageToAgent (it only calls Anthropic)", async () => {
    const { sendMessage } = await import("@/components/agent/actions");
    await sendMessage("hello");

    expect(mockSendMessageToAgent).toHaveBeenCalledOnce();
    // sendMessageToAgent should receive (message, history) — not a client as first arg
    const firstArg = mockSendMessageToAgent.mock.calls[0][0];
    expect(typeof firstArg).toBe("string");
  });

  it("does not create an admin client or reference service role key", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("components/agent/actions.ts", "utf-8");
    expect(source).not.toContain("getAdminClient");
    expect(source).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
  });
});
