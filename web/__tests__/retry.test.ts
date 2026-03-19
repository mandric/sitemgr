import { describe, it, expect, vi } from "vitest";
import { withRetry } from "@/lib/retry";

const noDelay = vi.fn(async (_ms: number) => {});

describe("withRetry", () => {
  // === Success cases ===
  it("resolves immediately when fn succeeds on first call", async () => {
    const fn = vi.fn().mockResolvedValueOnce("ok");
    const result = await withRetry(fn, { delayFn: noDelay });
    expect(result).toBe("ok");
  });

  it("fn is called exactly once on first-try success", async () => {
    const fn = vi.fn().mockResolvedValueOnce("ok");
    await withRetry(fn, { delayFn: noDelay });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  // === Retry behavior ===
  it("calls fn again after failure when shouldRetry returns true", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail"))
      .mockResolvedValueOnce("ok");

    const result = await withRetry(fn, { maxRetries: 2, delayFn: noDelay });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("with maxRetries: 2, fn is called at most 3 times total", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("1"))
      .mockRejectedValueOnce(new Error("2"))
      .mockRejectedValueOnce(new Error("3"));

    await expect(
      withRetry(fn, { maxRetries: 2, delayFn: noDelay }),
    ).rejects.toThrow("3");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("stops retrying when shouldRetry returns false", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("stop"))
      .mockResolvedValueOnce("should not reach");

    await expect(
      withRetry(fn, {
        maxRetries: 5,
        shouldRetry: () => false,
        delayFn: noDelay,
      }),
    ).rejects.toThrow("stop");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("throws the original error object after exhausting retries", async () => {
    const originalError = new Error("original");
    const fn = vi.fn().mockRejectedValue(originalError);

    try {
      await withRetry(fn, { maxRetries: 1, delayFn: noDelay });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBe(originalError);
    }
  });

  // === Delay behavior ===
  it("delayFn is called between retries, not before the first attempt", async () => {
    const delays: number[] = [];
    const mockDelay = vi.fn(async (ms: number) => {
      delays.push(ms);
    });

    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("1"))
      .mockResolvedValueOnce("ok");

    await withRetry(fn, {
      maxRetries: 2,
      baseDelay: 100,
      delayFn: mockDelay,
    });

    expect(delays).toHaveLength(1);
    expect(delays[0]).toBe(100);
  });

  it("uses exponential backoff", async () => {
    const delays: number[] = [];
    const mockDelay = vi.fn(async (ms: number) => {
      delays.push(ms);
    });

    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("1"))
      .mockRejectedValueOnce(new Error("2"))
      .mockResolvedValueOnce("ok");

    await withRetry(fn, {
      maxRetries: 3,
      baseDelay: 100,
      maxDelay: 5000,
      delayFn: mockDelay,
    });

    expect(delays).toEqual([100, 200]);
  });

  it("delay is capped at maxDelay", async () => {
    const delays: number[] = [];
    const mockDelay = vi.fn(async (ms: number) => {
      delays.push(ms);
    });

    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("1"))
      .mockRejectedValueOnce(new Error("2"))
      .mockRejectedValueOnce(new Error("3"))
      .mockResolvedValueOnce("ok");

    await withRetry(fn, {
      maxRetries: 5,
      baseDelay: 1000,
      maxDelay: 2500,
      delayFn: mockDelay,
    });

    expect(delays).toEqual([1000, 2000, 2500]);
    expect(Math.max(...delays)).toBeLessThanOrEqual(2500);
  });

  // === Default shouldRetry ===
  it("default shouldRetry returns true for a generic Error", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("generic"))
      .mockResolvedValueOnce("ok");

    const result = await withRetry(fn, { maxRetries: 1, delayFn: noDelay });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["23505", "Postgres duplicate key"],
    ["23503", "FK violation"],
    ["42501", "RLS denied"],
    ["PGRST301", "JWT/auth error"],
    ["PGRST302", "auth error"],
  ])(
    "default shouldRetry returns false for error code %s (%s)",
    async (code) => {
      const err = Object.assign(new Error("db error"), { code });
      const fn = vi.fn().mockRejectedValue(err);

      await expect(
        withRetry(fn, { maxRetries: 3, delayFn: noDelay }),
      ).rejects.toThrow();
      expect(fn).toHaveBeenCalledTimes(1);
    },
  );

  // === onRetry callback ===
  it("onRetry is called with (attempt, error, delayMs) on each retry", async () => {
    const onRetry = vi.fn();
    const err1 = new Error("1");
    const err2 = new Error("2");

    const fn = vi
      .fn()
      .mockRejectedValueOnce(err1)
      .mockRejectedValueOnce(err2)
      .mockResolvedValueOnce("ok");

    await withRetry(fn, {
      maxRetries: 3,
      baseDelay: 100,
      delayFn: noDelay,
      onRetry,
    });

    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenNthCalledWith(1, 1, err1, 100);
    expect(onRetry).toHaveBeenNthCalledWith(2, 2, err2, 200);
  });

  it("onRetry receives the correct delay value that was passed to delayFn", async () => {
    const delays: number[] = [];
    const retryDelays: number[] = [];

    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail"))
      .mockResolvedValueOnce("ok");

    await withRetry(fn, {
      maxRetries: 1,
      baseDelay: 250,
      delayFn: async (ms) => {
        delays.push(ms);
      },
      onRetry: (_attempt, _error, delayMs) => {
        retryDelays.push(delayMs);
      },
    });

    expect(delays).toEqual([250]);
    expect(retryDelays).toEqual([250]);
  });
});
