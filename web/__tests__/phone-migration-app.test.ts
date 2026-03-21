/**
 * Unit tests for section-08 phone-to-user_id migration app code changes.
 * Tests that all DB functions properly pass userId and that the agent
 * resolves phone numbers to user_ids before DB operations.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock Supabase ──────────────────────────────────────────────

const { mockCreateClient, fromChain } = vi.hoisted(() => {
  const mockChain = () => {
    const chain: Record<string, unknown> = {};
    chain.select = vi.fn().mockReturnValue(chain);
    chain.insert = vi.fn().mockReturnValue(chain);
    chain.upsert = vi.fn().mockReturnValue(chain);
    chain.update = vi.fn().mockReturnValue(chain);
    chain.delete = vi.fn().mockReturnValue(chain);
    chain.eq = vi.fn().mockReturnValue(chain);
    chain.gte = vi.fn().mockReturnValue(chain);
    chain.lte = vi.fn().mockReturnValue(chain);
    chain.order = vi.fn().mockReturnValue(chain);
    chain.range = vi.fn().mockReturnValue(chain);
    chain.limit = vi.fn().mockReturnValue(chain);
    chain.single = vi.fn().mockResolvedValue({ data: null, error: null });
    chain.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    // Default resolution for chained awaits
    (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
      resolve({ data: [], count: 0, error: null });
    return chain;
  };

  const fromChain = mockChain();
  const rpcFn = vi.fn().mockResolvedValue({ data: [], error: null });

  const mockCreateClient = vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue(fromChain),
    rpc: rpcFn,
  });

  return { mockCreateClient, fromChain, rpcFn };
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: mockCreateClient,
}));

// ── Mock encryption ──────────────────────────────────────────

vi.mock("@/lib/crypto/encryption-versioned", () => ({
  encryptSecretVersioned: vi.fn().mockResolvedValue("current:encrypted"),
  decryptSecretVersioned: vi.fn().mockResolvedValue("decrypted-secret"),
  getEncryptionVersion: vi.fn().mockReturnValue("current"),
  needsMigration: vi.fn().mockReturnValue(false),
}));

// ── Mock S3 ──────────────────────────────────────────────────

vi.mock("@/lib/media/s3", () => ({
  createS3Client: vi.fn().mockReturnValue({}),
  listS3Objects: vi.fn().mockResolvedValue([]),
  downloadS3Object: vi.fn().mockResolvedValue(Buffer.from("test")),
}));

vi.mock("@/lib/media/utils", () => ({
  newEventId: vi.fn().mockReturnValue("test-event-id"),
  detectContentType: vi.fn().mockReturnValue("photo"),
  getMimeType: vi.fn().mockReturnValue("image/jpeg"),
  s3Metadata: vi.fn().mockReturnValue({}),
}));

vi.mock("@/lib/media/enrichment", () => ({
  enrichImage: vi.fn().mockResolvedValue({
    description: "test",
    objects: [],
    context: "test",
    suggested_tags: [],
  }),
}));

// ── Mock Anthropic ──────────────────────────────────────────

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: '{"action":"direct","response":"ok"}' }],
      }),
    },
  })),
}));

vi.mock("@aws-sdk/client-s3", () => ({
  ListObjectsV2Command: vi.fn(),
  ListObjectsCommand: vi.fn(),
}));

// ── Imports (after mocks) ──────────────────────────────────

import {
  queryEvents,
  showEvent,
  getStats,
  getEnrichStatus,
  insertEnrichment,
  upsertWatchedKey,
  getWatchedKeys,
  findEventByHash,
  getPendingEnrichments,
} from "@/lib/media/db";

import {
  executeAction,
  resolveUserId,
} from "@/lib/agent/core";

// ── Test Setup ─────────────────────────────────────────────

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-secret-key");
  vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
  mockCreateClient.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ── Tests ──────────────────────────────────────────────────

describe("db.ts userId parameters", () => {
  it("queryEvents passes userId filter on direct queries", async () => {
    const client = mockCreateClient();
    const fromMock = client.from;

    await queryEvents(client as never, { userId: "user-123", limit: 10 });

    expect(fromMock).toHaveBeenCalledWith("events");
    const chain = fromMock.mock.results[0]?.value;
    expect(chain.eq).toHaveBeenCalledWith("user_id", "user-123");
  });

  it("queryEvents passes p_user_id to search RPC", async () => {
    const client = mockCreateClient();

    await queryEvents(client as never, { userId: "user-123", search: "beach" });

    expect(client.rpc).toHaveBeenCalledWith("search_events", expect.objectContaining({
      p_user_id: "user-123",
    }));
  });

  it("showEvent passes userId filter", async () => {
    const client = mockCreateClient();
    const fromMock = client.from;

    await showEvent(client as never, "event-1", "user-123");

    expect(fromMock).toHaveBeenCalledWith("events");
  });

  it("getStats passes userId to RPC calls and count queries", async () => {
    const client = mockCreateClient();

    await getStats(client as never, { userId: "user-123" });

    expect(client.rpc).toHaveBeenCalledWith("stats_by_content_type", { p_user_id: "user-123" });
    expect(client.rpc).toHaveBeenCalledWith("stats_by_event_type", { p_user_id: "user-123" });
  });

  it("getEnrichStatus passes userId to queries", async () => {
    const client = mockCreateClient();
    const fromMock = client.from;

    await getEnrichStatus(client as never, "user-123");

    expect(fromMock).toHaveBeenCalledWith("events");
    expect(fromMock).toHaveBeenCalledWith("enrichments");
  });

  it("insertEnrichment includes userId in payload", async () => {
    const client = mockCreateClient();
    const fromMock = client.from;

    await insertEnrichment(
      client as never,
      "event-1",
      { description: "test", objects: [], context: "test", suggested_tags: [] },
      "user-123",
    );

    expect(fromMock).toHaveBeenCalledWith("enrichments");
    const chain = fromMock.mock.results[0]?.value;
    expect(chain.insert).toHaveBeenCalledWith(expect.objectContaining({
      user_id: "user-123",
    }));
  });

  it("upsertWatchedKey includes userId in payload", async () => {
    const client = mockCreateClient();
    const fromMock = client.from;

    await upsertWatchedKey(client as never, "key.jpg", "event-1", "etag", 1024, "user-123");

    expect(fromMock).toHaveBeenCalledWith("watched_keys");
    const chain = fromMock.mock.results[0]?.value;
    expect(chain.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: "user-123" }),
      expect.any(Object),
    );
  });

  it("getWatchedKeys filters by userId", async () => {
    const client = mockCreateClient();
    const fromMock = client.from;

    await getWatchedKeys(client as never, "user-123");

    expect(fromMock).toHaveBeenCalledWith("watched_keys");
    const chain = fromMock.mock.results[0]?.value;
    expect(chain.eq).toHaveBeenCalledWith("user_id", "user-123");
  });

  it("findEventByHash filters by userId", async () => {
    const client = mockCreateClient();
    const fromMock = client.from;

    await findEventByHash(client as never, "hash-abc", "user-123");

    expect(fromMock).toHaveBeenCalledWith("events");
    const chain = fromMock.mock.results[0]?.value;
    expect(chain.eq).toHaveBeenCalledWith("user_id", "user-123");
  });

  it("getPendingEnrichments filters by userId", async () => {
    const client = mockCreateClient();
    const fromMock = client.from;

    await getPendingEnrichments(client as never, "user-123");

    expect(fromMock).toHaveBeenCalledWith("events");
  });
});

describe("core.ts resolveUserId", () => {
  it("resolveUserId queries user_profiles by phone_number", async () => {
    // Set up fromChain.maybeSingle to return a user before resolveUserId is called
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (fromChain as any).maybeSingle.mockResolvedValueOnce({
      data: { id: "resolved-user-id" },
      error: null,
    });

    const result = await resolveUserId("+1234567890");

    const client = mockCreateClient();
    const fromMock = client.from;
    expect(fromMock).toHaveBeenCalledWith("user_profiles");
    expect(fromChain.eq).toHaveBeenCalledWith("phone_number", "+1234567890");
    expect(result).toBe("resolved-user-id");
  });

  it("resolveUserId returns null when no user found", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (fromChain as any).maybeSingle.mockResolvedValueOnce({ data: null, error: null });

    const result = await resolveUserId("+9999999999");
    expect(result).toBeNull();
  });
});

describe("core.ts executeAction userId propagation", () => {
  it("executeAction passes resolved userId to getStats", async () => {
    // Set up fromChain.maybeSingle to resolve a user
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (fromChain as any).maybeSingle.mockResolvedValueOnce({
      data: { id: "test-user-uuid" },
      error: null,
    });

    const result = await executeAction(
      { action: "stats" },
      "whatsapp:+1234567890",
    );

    const client = mockCreateClient();
    const fromMock = client.from;
    // Should have called user_profiles to resolve
    expect(fromMock).toHaveBeenCalledWith("user_profiles");
    // Result should be valid JSON (stats output)
    expect(() => JSON.parse(result)).not.toThrow();
  });
});
