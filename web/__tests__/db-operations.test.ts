import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock setup ─────────────────────────────────────────────────

const mockUpsert = vi.fn();
const mockInsert = vi.fn();
const mockRpc = vi.fn();

function chainable(overrides: Record<string, unknown> = {}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: Record<string, any> = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    gte: vi.fn().mockReturnThis(),
    lte: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    range: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    insert: mockInsert,
    upsert: mockUpsert,
    then: undefined, // prevent auto-resolve
  };
  Object.assign(chain, overrides);
  // Make chainable methods return the chain
  for (const key of ["select", "eq", "gte", "lte", "order", "range", "limit"]) {
    chain[key] = vi.fn().mockReturnValue(chain);
  }
  return chain;
}

const mockFrom = vi.fn();
const mockSupabaseClient = {
  from: mockFrom,
  rpc: mockRpc,
};

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => mockSupabaseClient),
}));

vi.mock("@/lib/logger", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  LogComponent: { DB: "db" },
}));

vi.mock("@/lib/request-context", () => ({
  getRequestId: vi.fn().mockReturnValue("test-request-id"),
}));

vi.mock("@/lib/retry", () => ({
  withRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

beforeEach(() => {
  vi.stubEnv("SMGR_API_URL", "http://localhost:54321");
  vi.stubEnv("SUPABASE_SECRET_KEY", "test-service-key");
  vi.stubEnv("SMGR_API_KEY", "test-anon-key");
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ── upsertWatchedKey ───────────────────────────────────────────

describe("upsertWatchedKey", () => {
  it("upsert call includes bucket_config_id in the row data", async () => {
    const chain = chainable();
    mockFrom.mockReturnValue(chain);
    mockUpsert.mockResolvedValue({ error: null });

    const { upsertWatchedKey } = await import("@/lib/media/db");
    await upsertWatchedKey("photos/a.jpg", "evt-1", "abc123", 1024, "user-1", "bucket-42");

    expect(mockUpsert).toHaveBeenCalledOnce();
    const [row] = mockUpsert.mock.calls[0];
    expect(row.bucket_config_id).toBe("bucket-42");
  });

  it("onConflict is set to 's3_key'", async () => {
    const chain = chainable();
    mockFrom.mockReturnValue(chain);
    mockUpsert.mockResolvedValue({ error: null });

    const { upsertWatchedKey } = await import("@/lib/media/db");
    await upsertWatchedKey("photos/a.jpg", "evt-1", "abc123", 1024, "user-1", "bucket-42");

    const [, opts] = mockUpsert.mock.calls[0];
    expect(opts.onConflict).toBe("s3_key");
  });

  it("ignoreDuplicates is NOT set", async () => {
    const chain = chainable();
    mockFrom.mockReturnValue(chain);
    mockUpsert.mockResolvedValue({ error: null });

    const { upsertWatchedKey } = await import("@/lib/media/db");
    await upsertWatchedKey("photos/a.jpg", "evt-1", "abc123", 1024);

    const [, opts] = mockUpsert.mock.calls[0];
    expect(opts.ignoreDuplicates).toBeUndefined();
  });

  it("upsert row includes etag and size_bytes", async () => {
    const chain = chainable();
    mockFrom.mockReturnValue(chain);
    mockUpsert.mockResolvedValue({ error: null });

    const { upsertWatchedKey } = await import("@/lib/media/db");
    await upsertWatchedKey("photos/a.jpg", "evt-1", "etag-xyz", 2048);

    const [row] = mockUpsert.mock.calls[0];
    expect(row.etag).toBe("etag-xyz");
    expect(row.size_bytes).toBe(2048);
  });

  it("returns { data, error } on success", async () => {
    const chain = chainable();
    mockFrom.mockReturnValue(chain);
    mockUpsert.mockResolvedValue({ data: null, error: null });

    const { upsertWatchedKey } = await import("@/lib/media/db");
    const result = await upsertWatchedKey("photos/a.jpg", "evt-1", "abc", 100);

    expect(result).toHaveProperty("error", null);
  });
});

// ── queryEvents ────────────────────────────────────────────────

describe("queryEvents", () => {
  it("with no search issues exactly ONE from() call (no N+1)", async () => {
    const chain = chainable();
    // Final resolution of the chain (when awaited via range)
    chain.range = vi.fn().mockResolvedValue({
      data: [
        { id: "e1", type: "create", enrichments: [{ description: "cat" }] },
        { id: "e2", type: "create", enrichments: [] },
      ],
      count: 2,
      error: null,
    });
    mockFrom.mockReturnValue(chain);

    const { queryEvents } = await import("@/lib/media/db");
    const result = await queryEvents({});

    // Only one from() call, not one per event
    expect(mockFrom).toHaveBeenCalledTimes(1);
    expect(result.data).toHaveLength(2);
  });

  it("returned events include enrichment data normalized from join", async () => {
    const chain = chainable();
    chain.range = vi.fn().mockResolvedValue({
      data: [
        { id: "e1", type: "create", enrichments: [{ description: "a cat", objects: ["cat"] }] },
      ],
      count: 1,
      error: null,
    });
    mockFrom.mockReturnValue(chain);

    const { queryEvents } = await import("@/lib/media/db");
    const result = await queryEvents({});

    expect(result.data[0].enrichment).toEqual({ description: "a cat", objects: ["cat"] });
    expect(result.data[0].enrichments).toBeUndefined();
  });

  it("with search option calls the search_events RPC", async () => {
    mockRpc.mockResolvedValue({
      data: [{ id: "e1" }],
      error: null,
    });

    const { queryEvents } = await import("@/lib/media/db");
    await queryEvents({ search: "cat", userId: "u1" });

    expect(mockRpc).toHaveBeenCalledWith("search_events", expect.objectContaining({
      query_text: "cat",
    }));
  });

  it("returns empty array when no events match", async () => {
    const chain = chainable();
    chain.range = vi.fn().mockResolvedValue({
      data: [],
      count: 0,
      error: null,
    });
    mockFrom.mockReturnValue(chain);

    const { queryEvents } = await import("@/lib/media/db");
    const result = await queryEvents({});

    expect(result.data).toEqual([]);
    expect(result.count).toBe(0);
  });

  it("with empty string search returns empty results without calling RPC", async () => {
    const { queryEvents } = await import("@/lib/media/db");
    const result = await queryEvents({ search: "" });

    expect(mockRpc).not.toHaveBeenCalled();
    expect(result.data).toEqual([]);
    expect(result.count).toBe(0);
  });

  it("caps result_limit at 100", async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });

    const { queryEvents } = await import("@/lib/media/db");
    await queryEvents({ search: "test", limit: 500 });

    const rpcArgs = mockRpc.mock.calls[0][1];
    expect(rpcArgs.result_limit).toBeLessThanOrEqual(100);
  });

  it("caps range limit at 100 for non-search queries", async () => {
    const chain = chainable();
    chain.range = vi.fn().mockResolvedValue({
      data: [],
      count: 0,
      error: null,
    });
    mockFrom.mockReturnValue(chain);

    const { queryEvents } = await import("@/lib/media/db");
    await queryEvents({ limit: 500 });

    // range(0, 99) for limit of 100
    const rangeArgs = chain.range.mock.calls[0];
    expect(rangeArgs[1]).toBeLessThanOrEqual(99);
  });

  it("returns error from Supabase without throwing", async () => {
    const chain = chainable();
    chain.range = vi.fn().mockResolvedValue({
      data: null,
      count: null,
      error: { code: "42501", message: "insufficient privilege" },
    });
    mockFrom.mockReturnValue(chain);

    const { queryEvents } = await import("@/lib/media/db");
    const result = await queryEvents({});

    expect(result.error).toBeDefined();
    expect(result.error).toHaveProperty("code", "42501");
  });
});

// ── Error passthrough (replaces mapDbError tests) ──────────────

describe("error passthrough", () => {
  it("insertEvent returns error with code 23505 on duplicate key", async () => {
    mockFrom.mockReturnValue({
      insert: vi.fn().mockResolvedValue({
        data: null,
        error: { code: "23505", message: "unique constraint" },
      }),
    });

    const { insertEvent } = await import("@/lib/media/db");
    const result = await insertEvent({
      id: "e1", device_id: "d1", type: "create",
      content_type: null, content_hash: null,
      local_path: null, remote_path: null,
      metadata: null, parent_id: null, user_id: "u1",
    });

    expect(result.error).toBeDefined();
    expect((result.error as { code: string }).code).toBe("23505");
  });

  it("insertEnrichment returns error with code 23503 on FK violation", async () => {
    mockFrom.mockReturnValue({
      insert: vi.fn().mockResolvedValue({
        data: null,
        error: { code: "23503", message: "foreign key violation" },
      }),
    });

    const { insertEnrichment } = await import("@/lib/media/db");
    const result = await insertEnrichment("no-such-event", {
      description: "x", objects: [], context: "", suggested_tags: [],
    });

    expect(result.error).toBeDefined();
    expect((result.error as { code: string }).code).toBe("23503");
  });

  it("insertEvent returns error with code 42501 on RLS denied", async () => {
    mockFrom.mockReturnValue({
      insert: vi.fn().mockResolvedValue({
        data: null,
        error: { code: "42501", message: "insufficient privilege" },
      }),
    });

    const { insertEvent } = await import("@/lib/media/db");
    const result = await insertEvent({
      id: "e1", device_id: "d1", type: "create",
      content_type: null, content_hash: null,
      local_path: null, remote_path: null,
      metadata: null, parent_id: null, user_id: "u1",
    });

    expect(result.error).toBeDefined();
    expect((result.error as { code: string }).code).toBe("42501");
  });

  it("full error object preserved (code, message, details, hint)", async () => {
    const fullError = {
      code: "23505",
      message: "unique constraint",
      details: "Key (id)=(e1) already exists.",
      hint: null,
    };
    mockFrom.mockReturnValue({
      insert: vi.fn().mockResolvedValue({
        data: null,
        error: fullError,
      }),
    });

    const { insertEvent } = await import("@/lib/media/db");
    const result = await insertEvent({
      id: "e1", device_id: "d1", type: "create",
      content_type: null, content_hash: null,
      local_path: null, remote_path: null,
      metadata: null, parent_id: null, user_id: "u1",
    });

    expect(result.error).toEqual(fullError);
  });
});

// ── insertEvent ────────────────────────────────────────────────

describe("insertEvent", () => {
  it("inserts row with all required fields", async () => {
    mockFrom.mockReturnValue({
      insert: mockInsert.mockResolvedValue({ data: null, error: null }),
    });

    const { insertEvent } = await import("@/lib/media/db");
    await insertEvent({
      id: "e1", device_id: "d1", type: "create",
      content_type: "photo", content_hash: "h1",
      local_path: null, remote_path: "/r", metadata: null,
      parent_id: null, user_id: "u1",
    });

    expect(mockInsert).toHaveBeenCalledOnce();
    const row = mockInsert.mock.calls[0][0];
    expect(row.id).toBe("e1");
    expect(row.type).toBe("create");
    expect(row.user_id).toBe("u1");
  });

  it("timestamp defaults to current ISO string when not provided", async () => {
    mockFrom.mockReturnValue({
      insert: mockInsert.mockResolvedValue({ data: null, error: null }),
    });

    const { insertEvent } = await import("@/lib/media/db");
    const before = new Date().toISOString();
    await insertEvent({
      id: "e1", device_id: "d1", type: "create",
      content_type: null, content_hash: null,
      local_path: null, remote_path: null, metadata: null,
      parent_id: null, user_id: "u1",
    });
    const after = new Date().toISOString();

    const row = mockInsert.mock.calls[0][0];
    expect(row.timestamp).toBeDefined();
    expect(row.timestamp >= before).toBe(true);
    expect(row.timestamp <= after).toBe(true);
  });

  it("returns { data, error } on success", async () => {
    mockFrom.mockReturnValue({
      insert: mockInsert.mockResolvedValue({ data: null, error: null }),
    });

    const { insertEvent } = await import("@/lib/media/db");
    const result = await insertEvent({
      id: "e1", device_id: "d1", type: "create",
      content_type: null, content_hash: null,
      local_path: null, remote_path: null, metadata: null,
      parent_id: null, user_id: "u1",
    });

    expect(result).toHaveProperty("error", null);
  });
});

// ── insertEnrichment ───────────────────────────────────────────

describe("insertEnrichment", () => {
  it("inserts enrichment row linked to the given event_id", async () => {
    mockFrom.mockReturnValue({
      insert: mockInsert.mockResolvedValue({ data: null, error: null }),
    });

    const { insertEnrichment } = await import("@/lib/media/db");
    await insertEnrichment("evt-42", {
      description: "a cat", objects: ["cat"], context: "indoor", suggested_tags: ["pet"],
    });

    expect(mockInsert).toHaveBeenCalledOnce();
    const row = mockInsert.mock.calls[0][0];
    expect(row.event_id).toBe("evt-42");
    expect(row.description).toBe("a cat");
  });

  it("returns error on FK violation instead of throwing", async () => {
    mockFrom.mockReturnValue({
      insert: vi.fn().mockResolvedValue({
        data: null,
        error: { code: "23503", message: "violates foreign key constraint" },
      }),
    });

    const { insertEnrichment } = await import("@/lib/media/db");
    const result = await insertEnrichment("bad-id", {
      description: "x", objects: [], context: "", suggested_tags: [],
    });

    expect(result.error).toBeDefined();
    expect((result.error as { code: string }).code).toBe("23503");
  });
});

// ── getStats ───────────────────────────────────────────────────

describe("getStats", () => {
  it("returns correct shape in data field", async () => {
    const headChain = chainable();
    headChain.select = vi.fn().mockReturnValue(headChain);
    headChain.eq = vi.fn().mockReturnValue(headChain);
    // Make chainable resolve with count
    Object.defineProperty(headChain, "then", {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      value: (resolve: any) =>
        resolve({ data: null, count: 5, error: null }),
      configurable: true,
    });

    mockFrom.mockReturnValue(headChain);
    mockRpc
      .mockResolvedValueOnce({ data: [{ content_type: "photo", count: 3 }], error: null })
      .mockResolvedValueOnce({ data: [{ type: "create", count: 5 }], error: null });

    const { getStats } = await import("@/lib/media/db");
    const result = await getStats();

    expect(result.error).toBeNull();
    expect(result.data).toHaveProperty("total_events");
    expect(result.data).toHaveProperty("by_content_type");
    expect(result.data).toHaveProperty("by_event_type");
    expect(result.data).toHaveProperty("watched_s3_keys");
    expect(result.data).toHaveProperty("enriched");
    expect(result.data).toHaveProperty("pending_enrichment");
  });
});

// ── getEnrichStatus ────────────────────────────────────────────

describe("getEnrichStatus", () => {
  it("returns total_media, enriched, pending with correct values", async () => {
    const headChain = chainable();
    headChain.select = vi.fn().mockReturnValue(headChain);
    headChain.eq = vi.fn().mockReturnValue(headChain);

    let callCount = 0;
    Object.defineProperty(headChain, "then", {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      value: (resolve: any) => {
        callCount++;
        // First call is events (total=10), second is enrichments (enriched=4)
        resolve({ data: null, count: callCount === 1 ? 10 : 4, error: null });
      },
      configurable: true,
    });

    mockFrom.mockReturnValue(headChain);

    const { getEnrichStatus } = await import("@/lib/media/db");
    const result = await getEnrichStatus();

    expect(result.error).toBeNull();
    expect(result.data!.total_media).toBe(10);
    expect(result.data!.enriched).toBe(4);
    expect(result.data!.pending).toBe(6);
  });

  it("pending is 0 when all events are enriched", async () => {
    const headChain = chainable();
    headChain.select = vi.fn().mockReturnValue(headChain);
    headChain.eq = vi.fn().mockReturnValue(headChain);

    Object.defineProperty(headChain, "then", {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      value: (resolve: any) => resolve({ data: null, count: 5, error: null }),
      configurable: true,
    });

    mockFrom.mockReturnValue(headChain);

    const { getEnrichStatus } = await import("@/lib/media/db");
    const result = await getEnrichStatus();

    expect(result.data!.pending).toBe(0);
  });

  it("handles no events", async () => {
    const headChain = chainable();
    headChain.select = vi.fn().mockReturnValue(headChain);
    headChain.eq = vi.fn().mockReturnValue(headChain);

    Object.defineProperty(headChain, "then", {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      value: (resolve: any) => resolve({ data: null, count: 0, error: null }),
      configurable: true,
    });

    mockFrom.mockReturnValue(headChain);

    const { getEnrichStatus } = await import("@/lib/media/db");
    const result = await getEnrichStatus();

    expect(result.data!.total_media).toBe(0);
    expect(result.data!.enriched).toBe(0);
    expect(result.data!.pending).toBe(0);
  });
});
