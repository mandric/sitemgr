import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockCreate = vi.fn();

vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: class MockAnthropic {
      messages = { create: mockCreate };
    },
  };
});

const mockAdminFrom = vi.fn();

vi.mock("@/lib/media/db", () => ({
  getAdminClient: vi.fn(() => ({
    from: (...args: unknown[]) => mockAdminFrom(...args),
  })),
  getUserClient: vi.fn(),
  queryEvents: vi.fn().mockResolvedValue({ events: [], total: 0 }),
  showEvent: vi.fn().mockResolvedValue(null),
  getStats: vi.fn().mockResolvedValue({ total_events: 0 }),
  getEnrichStatus: vi.fn().mockResolvedValue({ total_media: 0, enriched: 0, pending: 0 }),
  insertEvent: vi.fn().mockResolvedValue(undefined),
  insertEnrichment: vi.fn().mockResolvedValue(undefined),
  upsertWatchedKey: vi.fn().mockResolvedValue(undefined),
  getWatchedKeys: vi.fn().mockResolvedValue(new Set()),
}));

vi.mock("@/lib/media/s3", () => ({
  createS3Client: vi.fn(() => ({ send: vi.fn() })),
  listS3Objects: vi.fn().mockResolvedValue([]),
  downloadS3Object: vi.fn().mockResolvedValue(Buffer.alloc(10)),
}));

vi.mock("@/lib/media/enrichment", () => ({
  enrichImage: vi.fn().mockResolvedValue({
    description: "test", objects: [], context: "",
    suggested_tags: [], provider: "anthropic",
    model: "claude-haiku-4-5-20251001", raw_response: "{}",
  }),
}));

const mockRunWithRequestId = vi.fn((id: string, fn: () => unknown) => fn());
vi.mock("@/lib/request-context", () => ({
  runWithRequestId: (...args: unknown[]) => mockRunWithRequestId(...(args as [string, () => unknown])),
  getRequestId: vi.fn(() => undefined),
}));

vi.mock("@/lib/logger", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  LogComponent: { Agent: "agent" },
}));

vi.mock("@/lib/crypto/encryption-versioned", () => ({
  encryptSecretVersioned: vi.fn().mockResolvedValue("v2:encrypted"),
  decryptSecretVersioned: vi.fn().mockResolvedValue("decrypted-secret"),
  getEncryptionVersion: vi.fn().mockReturnValue(2),
  needsMigration: vi.fn().mockReturnValue(false),
}));

import { sendMessageToAgent, type Message } from "@/lib/agent/core";
import { queryEvents, getStats, insertEvent, insertEnrichment, upsertWatchedKey, getWatchedKeys } from "@/lib/media/db";
import { listS3Objects, downloadS3Object, createS3Client } from "@/lib/media/s3";
import { enrichImage } from "@/lib/media/enrichment";

/** Set up mockAdminFrom to handle both user_profiles and bucket_configs queries */
function setupAdminMock(opts: { userId?: string; bucketConfig?: Record<string, unknown> | null } = {}) {
  const userId = opts.userId ?? "user-123";
  const bucketConfig = opts.bucketConfig !== undefined ? opts.bucketConfig : {
    id: "bc-1",
    bucket_name: "test-bucket",
    endpoint_url: "http://localhost:9000",
    region: "us-east-1",
    access_key_id: "test-key",
    secret_access_key: "encrypted-secret",
  };

  mockAdminFrom.mockImplementation((table: string) => {
    if (table === "user_profiles") {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({
              data: userId ? { id: userId } : null,
            }),
          }),
        }),
      };
    }
    if (table === "bucket_configs") {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({
                data: bucketConfig,
                error: null,
              }),
            }),
          }),
        }),
        insert: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: bucketConfig, error: null }),
          }),
        }),
        delete: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ error: null }),
          }),
        }),
      };
    }
    // Default: return a generic chainable
    return {
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          order: vi.fn().mockResolvedValue({ data: [], error: null }),
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        }),
      }),
    };
  });
}

describe("sendMessageToAgent", () => {
  beforeEach(() => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-api-key");
    mockCreate.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns content on successful response", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "Hello! How can I help?" }],
    });

    const result = await sendMessageToAgent("Hi there");

    expect(result).toEqual({ content: "Hello! How can I help?" });
    expect(mockCreate).toHaveBeenCalledOnce();

    const call = mockCreate.mock.calls[0][0];
    expect(call.model).toBe("claude-sonnet-4-20250514");
    expect(call.messages).toEqual([
      { role: "user", content: "Hi there" },
    ]);
  });

  it("includes conversation history in messages", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "Based on our conversation..." }],
    });

    const history: Message[] = [
      { role: "user", content: "first message" },
      { role: "assistant", content: "first reply" },
    ];

    await sendMessageToAgent("follow up", history);

    const call = mockCreate.mock.calls[0][0];
    expect(call.messages).toEqual([
      { role: "user", content: "first message" },
      { role: "assistant", content: "first reply" },
      { role: "user", content: "follow up" },
    ]);
  });

  it("returns error when API key is missing", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    delete process.env.ANTHROPIC_API_KEY;

    const result = await sendMessageToAgent("test");
    expect(result).toEqual({ error: "API key not configured" });
  });

  it("returns error on unexpected response type", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "tool_use", id: "123" }],
    });

    const result = await sendMessageToAgent("test");
    expect(result).toEqual({ error: "Unexpected response type" });
  });

  it("returns error on SDK exception", async () => {
    mockCreate.mockRejectedValue(new Error("Network failure"));

    const result = await sendMessageToAgent("test");
    expect(result).toEqual({ error: "Failed to get response from Claude" });
  });
});

// ── Request context tests ──────────────────────────────────────

describe("executeAction — request context", () => {
  beforeEach(() => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    vi.clearAllMocks();
    mockRunWithRequestId.mockImplementation((id: string, fn: () => unknown) => fn());
    setupAdminMock();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("wraps execution in runWithRequestId", async () => {
    const { executeAction } = await import("@/lib/agent/core");
    await executeAction({ action: "stats" }, "+1234567890", "user-123");

    expect(mockRunWithRequestId).toHaveBeenCalledOnce();
  });

  it("request ID is a non-empty string", async () => {
    const { executeAction } = await import("@/lib/agent/core");
    await executeAction({ action: "stats" }, "+1234567890", "user-123");

    const requestId = mockRunWithRequestId.mock.calls[0][0];
    expect(typeof requestId).toBe("string");
    expect(requestId.length).toBeGreaterThan(0);
  });

  it("request ID is different for two consecutive calls", async () => {
    const { executeAction } = await import("@/lib/agent/core");
    await executeAction({ action: "stats" }, "+1234567890", "user-123");
    await executeAction({ action: "stats" }, "+1234567890", "user-123");

    const id1 = mockRunWithRequestId.mock.calls[0][0];
    const id2 = mockRunWithRequestId.mock.calls[1][0];
    expect(id1).not.toBe(id2);
  });

  it("action handler runs inside the runWithRequestId callback", async () => {
    const callOrder: string[] = [];
    mockRunWithRequestId.mockImplementation((id: string, fn: () => unknown) => {
      callOrder.push("runWithRequestId");
      return fn();
    });
    vi.mocked(getStats).mockImplementation(async () => {
      callOrder.push("getStats");
      return { total_events: 0 } as any;
    });

    const { executeAction } = await import("@/lib/agent/core");
    await executeAction({ action: "stats" }, "+1234567890", "user-123");

    expect(callOrder).toEqual(["runWithRequestId", "getStats"]);
  });
});

// ── Error response standardization ─────────────────────────────

describe("executeAction — error response shape", () => {
  beforeEach(() => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    vi.clearAllMocks();
    mockRunWithRequestId.mockImplementation((id: string, fn: () => unknown) => fn());
    setupAdminMock();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("unknown action returns JSON with errorType field", async () => {
    const { executeAction } = await import("@/lib/agent/core");
    const result = await executeAction(
      { action: "unknown_action" }, "+1234567890", "user-123",
    );
    const parsed = JSON.parse(result);
    expect(parsed.error).toBeDefined();
    expect(parsed.errorType).toBeDefined();
    expect(parsed.errorType).toBe("not_found");
  });

  it("missing bucket_name in remove_bucket returns errorType validation_error", async () => {
    const { executeAction } = await import("@/lib/agent/core");
    const result = await executeAction(
      { action: "remove_bucket", params: {} }, "+1234567890", "user-123",
    );
    const parsed = JSON.parse(result);
    expect(parsed.errorType).toBe("validation_error");
  });

  it("unresolved phone number returns errorType not_found", async () => {
    const { executeAction } = await import("@/lib/agent/core");
    const result = await executeAction(
      { action: "stats" }, "+9999999999", null,
    );
    const parsed = JSON.parse(result);
    expect(parsed.errorType).toBe("not_found");
  });

  it("when a media library function throws, response includes errorType internal", async () => {
    vi.mocked(getStats).mockRejectedValueOnce(new Error("DB connection lost"));

    const { executeAction } = await import("@/lib/agent/core");
    const result = await executeAction(
      { action: "stats" }, "+1234567890", "user-123",
    );
    const parsed = JSON.parse(result);
    expect(parsed.errorType).toBe("internal");
  });

  it("error responses never include errorType undefined", async () => {
    const { executeAction } = await import("@/lib/agent/core");

    // Test unknown action
    const r1 = JSON.parse(await executeAction(
      { action: "bad" }, "+1234567890", "user-123",
    ));
    if (r1.error) expect(r1.errorType).toBeDefined();

    // Test no userId
    const r2 = JSON.parse(await executeAction(
      { action: "stats" }, "+0000000000", null,
    ));
    if (r2.error) expect(r2.errorType).toBeDefined();
  });
});

// ── indexBucket concurrency and partial failure ────────────────

describe("indexBucket — concurrency and partial failure", () => {
  beforeEach(() => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    vi.clearAllMocks();
    mockRunWithRequestId.mockImplementation((id: string, fn: () => unknown) => fn());
    setupAdminMock();

    vi.mocked(getWatchedKeys).mockResolvedValue(new Set());
    vi.mocked(insertEvent).mockResolvedValue(undefined);
    vi.mocked(upsertWatchedKey).mockResolvedValue(undefined);
    vi.mocked(insertEnrichment).mockResolvedValue(undefined);
    vi.mocked(downloadS3Object).mockResolvedValue(Buffer.alloc(10));
    vi.mocked(enrichImage).mockResolvedValue({
      description: "test", objects: [], context: "",
      suggested_tags: [], provider: "anthropic",
      model: "claude-haiku-4-5-20251001", raw_response: "{}",
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("calls listS3Objects once", async () => {
    vi.mocked(listS3Objects).mockResolvedValue([
      { key: "a.jpg", size: 100, etag: "e1", lastModified: "2024-01-01" },
    ]);

    const { executeAction } = await import("@/lib/agent/core");
    await executeAction(
      { action: "index_bucket", params: { bucket_name: "test-bucket" } },
      "+1234567890", "user-123",
    );

    expect(listS3Objects).toHaveBeenCalledOnce();
  });

  it("calls insertEvent for each object in the batch", async () => {
    vi.mocked(listS3Objects).mockResolvedValue([
      { key: "a.jpg", size: 100, etag: "e1", lastModified: "2024-01-01" },
      { key: "b.jpg", size: 200, etag: "e2", lastModified: "2024-01-01" },
    ]);

    const { executeAction } = await import("@/lib/agent/core");
    await executeAction(
      { action: "index_bucket", params: { bucket_name: "test-bucket" } },
      "+1234567890", "user-123",
    );

    expect(insertEvent).toHaveBeenCalledTimes(2);
  });

  it("continues processing when one insertEvent call throws", async () => {
    vi.mocked(listS3Objects).mockResolvedValue([
      { key: "a.jpg", size: 100, etag: "e1", lastModified: "2024-01-01" },
      { key: "b.jpg", size: 200, etag: "e2", lastModified: "2024-01-01" },
      { key: "c.jpg", size: 300, etag: "e3", lastModified: "2024-01-01" },
    ]);

    vi.mocked(insertEvent)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("insert failed"))
      .mockResolvedValueOnce(undefined);

    const { executeAction } = await import("@/lib/agent/core");
    const result = JSON.parse(await executeAction(
      { action: "index_bucket", params: { bucket_name: "test-bucket" } },
      "+1234567890", "user-123",
    ));

    // All three attempted
    expect(insertEvent).toHaveBeenCalledTimes(3);
    // Two succeeded, one failed
    expect(result.batch_indexed).toBe(2);
  });

  it("result includes per_object with failed key", async () => {
    vi.mocked(listS3Objects).mockResolvedValue([
      { key: "good.jpg", size: 100, etag: "e1", lastModified: "2024-01-01" },
      { key: "bad.jpg", size: 200, etag: "e2", lastModified: "2024-01-01" },
    ]);

    vi.mocked(insertEvent)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("insert failed"));

    const { executeAction } = await import("@/lib/agent/core");
    const result = JSON.parse(await executeAction(
      { action: "index_bucket", params: { bucket_name: "test-bucket" } },
      "+1234567890", "user-123",
    ));

    expect(result.per_object).toBeDefined();
    const badEntry = result.per_object.find((p: any) => p.key === "bad.jpg");
    expect(badEntry.status).toBe("error");
  });

  it("when enrichImage throws, continues enriching other objects", async () => {
    vi.mocked(listS3Objects).mockResolvedValue([
      { key: "bad.jpg", size: 100, etag: "e1", lastModified: "2024-01-01" },
      { key: "good.jpg", size: 200, etag: "e2", lastModified: "2024-01-01" },
    ]);

    vi.mocked(enrichImage)
      .mockRejectedValueOnce(new Error("enrich failed"))
      .mockResolvedValueOnce({
        description: "ok", objects: [], context: "",
        suggested_tags: [], provider: "anthropic",
        model: "claude-haiku-4-5-20251001", raw_response: "{}",
      });

    const { executeAction } = await import("@/lib/agent/core");
    const result = JSON.parse(await executeAction(
      { action: "index_bucket", params: { bucket_name: "test-bucket" } },
      "+1234567890", "user-123",
    ));

    // insertEnrichment called only for good.jpg
    expect(insertEnrichment).toHaveBeenCalledOnce();
    expect(result.batch_enriched).toBe(1);
  });

  it("result includes batch_indexed and batch_enriched counts", async () => {
    vi.mocked(listS3Objects).mockResolvedValue([
      { key: "a.jpg", size: 100, etag: "e1", lastModified: "2024-01-01" },
    ]);

    const { executeAction } = await import("@/lib/agent/core");
    const result = JSON.parse(await executeAction(
      { action: "index_bucket", params: { bucket_name: "test-bucket" } },
      "+1234567890", "user-123",
    ));

    expect(result).toHaveProperty("batch_indexed");
    expect(result).toHaveProperty("batch_enriched");
  });

  it("non-image objects are indexed but not enriched", async () => {
    vi.mocked(listS3Objects).mockResolvedValue([
      { key: "archive.zip", size: 100, etag: "e1", lastModified: "2024-01-01" },
    ]);

    const { executeAction } = await import("@/lib/agent/core");
    const result = JSON.parse(await executeAction(
      { action: "index_bucket", params: { bucket_name: "test-bucket" } },
      "+1234567890", "user-123",
    ));

    expect(enrichImage).not.toHaveBeenCalled();
    const entry = result.per_object.find((p: any) => p.key === "archive.zip");
    expect(entry.status).toBe("indexed");
  });
});
