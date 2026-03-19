import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runWithRequestId, getRequestId } from "@/lib/request-context";
import { createLogger } from "@/lib/logger";

describe("runWithRequestId / getRequestId", () => {
  it("getRequestId() returns undefined when called outside any context", () => {
    expect(getRequestId()).toBeUndefined();
  });

  it("getRequestId() returns the ID set by runWithRequestId within the callback", () => {
    runWithRequestId("req-123", () => {
      expect(getRequestId()).toBe("req-123");
    });
  });

  it("nested async calls inside the callback can access the same request ID", async () => {
    await runWithRequestId("req-456", async () => {
      await Promise.resolve();
      expect(getRequestId()).toBe("req-456");

      await new Promise((r) => setTimeout(r, 1));
      expect(getRequestId()).toBe("req-456");
    });
  });

  it("context does not leak after the callback resolves", async () => {
    await runWithRequestId("req-789", async () => {
      expect(getRequestId()).toBe("req-789");
    });
    expect(getRequestId()).toBeUndefined();
  });
});

describe("concurrent context isolation", () => {
  it("two parallel runWithRequestId calls are isolated from each other", async () => {
    const results: string[] = [];
    await Promise.all([
      runWithRequestId("req-A", async () => {
        await new Promise((r) => setTimeout(r, 5));
        results.push(getRequestId()!);
      }),
      runWithRequestId("req-B", async () => {
        await new Promise((r) => setTimeout(r, 2));
        results.push(getRequestId()!);
      }),
    ]);
    expect(results).toContain("req-A");
    expect(results).toContain("req-B");
    expect(results).toHaveLength(2);
  });
});

describe("logger integration with request context", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logger includes request_id when called inside runWithRequestId", () => {
    const logger = createLogger("test");
    runWithRequestId("ctx-abc", () => {
      logger.info("inside context");
    });

    const raw = (console.error as ReturnType<typeof vi.spyOn>).mock
      .calls[0][0] as string;
    const entry = JSON.parse(raw);
    expect(entry.request_id).toBe("ctx-abc");
  });

  it("logger omits request_id when called outside any context", () => {
    const logger = createLogger("test");
    logger.info("outside context");

    const raw = (console.error as ReturnType<typeof vi.spyOn>).mock
      .calls[0][0] as string;
    const entry = JSON.parse(raw);
    expect(entry).not.toHaveProperty("request_id");
  });
});
