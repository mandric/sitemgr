# Section 02: Retry Helper & SDK Configuration

**Depends on:** nothing
**Blocks:** section-04 (S3 hardening), section-05 (enrichment), section-06 (DB hardening)
**Can be implemented as an independent PR**

---

## What You Are Building

- `web/lib/retry.ts` — a lightweight retry helper **for Supabase calls only**
- SDK retry configuration patterns for `S3Client` and the Anthropic client (documented here, applied in sections 04 and 05)
- Anthropic client singleton (documented here, applied in section 05)
- `p-limit` added as a dependency (used in sections 05, 07, 08)

---

## Critical Design Decision: No Custom Retry Around S3 or Anthropic

Both AWS SDK v3 and the Anthropic SDK have built-in retry with exponential backoff. Wrapping their calls in a custom `withRetry()` would cause double-retrying — the custom wrapper retries, and inside each retry attempt the SDK also retries. This is harmful.

- **S3 calls**: Configure retry via `S3Client` constructor options (`maxAttempts`, `retryMode`). No `withRetry()` wrapper around S3 calls.
- **Claude API calls**: Configure retry via `new Anthropic({ maxRetries: 3 })`. The SDK reads `retry-after` headers and backs off automatically. No `withRetry()` wrapper around Anthropic calls.
- **Supabase calls**: Supabase's JS client has no built-in retry. Use `withRetry()` for these — applied in section 06.

`withRetry` must NOT appear in `web/lib/media/s3.ts` or `web/lib/media/enrichment.ts`.

---

## Tests First

### File: `web/__tests__/retry.test.ts`

Write these tests before implementing `web/lib/retry.ts`. Run `npm test` from `web/` — all tests should fail (red) until the implementation is complete.

```typescript
import { describe, it, expect, vi } from "vitest";
import { withRetry } from "@/lib/retry";

describe("withRetry", () => {
  // === Success cases ===
  // Test: resolves immediately when fn succeeds on first call
  // Test: fn is called exactly once on first-try success (no unnecessary retries)

  // === Retry behavior ===
  // Test: calls fn again after failure when shouldRetry returns true
  // Test: with maxRetries: 2, fn is called at most 3 times total (1 initial + 2 retries)
  // Test: stops retrying when shouldRetry returns false for the thrown error
  //       — fn is not called again after shouldRetry returns false
  // Test: throws the error from the last attempt after exhausting all retries
  //       — the thrown error is not wrapped, it is the original error object

  // === Delay behavior (injectable delayFn) ===
  // Test: delayFn is called between retries, not before the first attempt
  // Test: delay uses exponential backoff: attempt 1 uses baseDelay, attempt 2 uses baseDelay * 2
  // Test: delay is capped at maxDelay (never exceeds it, even for large attempt numbers)
  // Test: no real time elapses in any of these tests — delayFn is a vi.fn() that resolves immediately

  // === Default shouldRetry ===
  // Test: default shouldRetry returns true for a generic Error (retryable by default)
  // Test: default shouldRetry returns false for an error with code "23505" (Postgres duplicate key)
  // Test: default shouldRetry returns false for an error with code "23503" (FK violation)
  // Test: default shouldRetry returns false for an error with code "42501" (RLS denied)
  // Test: default shouldRetry returns false for an error with code "PGRST301" (JWT/auth error)
  // Test: default shouldRetry returns false for an error with code "PGRST302"

  // === onRetry callback ===
  // Test: onRetry is called with (attempt, error, delayMs) on each retry
  //       — attempt starts at 1 for the first retry
  //       — onRetry is NOT called on the initial attempt or after final exhaustion
  // Test: onRetry receives the correct delay value that was passed to delayFn
});
```

Key test pattern using the injectable `delayFn`:

```typescript
it("uses exponential backoff without real delays", async () => {
  const delays: number[] = [];
  const mockDelay = vi.fn(async (ms: number) => { delays.push(ms); });

  const fn = vi.fn()
    .mockRejectedValueOnce(new Error("fail 1"))
    .mockRejectedValueOnce(new Error("fail 2"))
    .mockResolvedValueOnce("ok");

  const result = await withRetry(fn, {
    maxRetries: 3,
    baseDelay: 100,
    maxDelay: 5000,
    delayFn: mockDelay,
  });

  expect(result).toBe("ok");
  expect(fn).toHaveBeenCalledTimes(3);
  expect(delays).toEqual([100, 200]); // exponential: 100ms, then 100 * 2^1 = 200ms
});
```

---

## Implementation

### `web/lib/retry.ts`

**Full interface:**

```typescript
export interface RetryConfig {
  maxRetries: number;                                       // default: 2
  baseDelay: number;                                        // default: 500ms
  maxDelay: number;                                         // default: 5000ms
  shouldRetry: (error: unknown) => boolean;                 // default: see below
  delayFn?: (ms: number) => Promise<void>;                  // default: real setTimeout
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  config?: Partial<RetryConfig>
): Promise<T>
```

**Implementation notes:**

- Merge caller config with defaults using `{ ...defaults, ...config }`.
- Loop: call `fn()`. On success, return the result. On failure, check `shouldRetry(error)`. If `false`, rethrow immediately. If `true` and attempts remain: compute delay, call `onRetry` if provided, await `delayFn(delay)`, then try again.
- Exponential backoff formula: `Math.min(baseDelay * Math.pow(2, attempt - 1), maxDelay)` where `attempt` starts at `1` for the first retry.
- When retries are exhausted, rethrow the last error as-is — do not wrap it in a new Error. Callers may inspect the error type.
- Default `delayFn`: `(ms) => new Promise((resolve) => setTimeout(resolve, ms))`.
- Default `shouldRetry`: returns `false` for non-retryable Postgres/PostgREST codes. Check `(error as any)?.code` against: `["23505", "23503", "42501", "PGRST301", "PGRST302"]`. Returns `true` for all other errors.
- No imports required beyond built-in types. No external dependencies.

---

## SDK Retry Configuration (Applied in Sections 04 and 05)

These patterns are documented here because this section establishes the retry philosophy. The actual code changes happen in sections 04 and 05 — reference this document when implementing those.

### S3 Client — applied in section-04

In `web/lib/media/s3.ts`, update `createS3Client()` to pass retry and timeout options to the `S3Client` constructor:

```typescript
import { NodeHttpHandler } from "@smithy/node-http-handler";

new S3Client({
  // ... existing endpoint, region, credentials config ...
  maxAttempts: 4,
  retryMode: "adaptive",        // tracks server capacity; better than "standard" for Supabase Storage
  requestHandler: new NodeHttpHandler({
    connectionTimeout: 5000,    // ms to establish TCP connection
    socketTimeout: 30000,       // ms to wait for response data after connecting
  }),
})
```

`@smithy/node-http-handler` is bundled with `@aws-sdk/client-s3` — no additional install required.

`retryMode: "adaptive"` is preferred over `"standard"` because it tracks server-side capacity signals and avoids thundering herds during throttling — particularly relevant for Supabase Storage's S3 API.

### Anthropic Client Singleton — applied in section-05

The current `enrichImage()` creates a `new Anthropic()` client on every call. This loses rate-limiting state tracked by the SDK internally. Replace it with a module-level singleton:

```typescript
// In web/lib/media/enrichment.ts
let _client: Anthropic | null = null;

function getAnthropicClient(): Anthropic {
  if (!_client) {
    _client = new Anthropic({ maxRetries: 3 });
  }
  return _client;
}
```

The `maxRetries: 3` configuration handles 429 (rate limit), 529 (overloaded), and 500 errors automatically, including `retry-after` header parsing. Three retries with exponential backoff is appropriate for a batch enrichment pipeline.

The singleton matters: the SDK tracks in-flight request counts and usage internally. A fresh client per call loses that state and makes rate-limit handling less effective.

---

## p-limit Dependency

Install `p-limit` in `web/`:

```bash
cd web && npm install p-limit
```

`p-limit` is a 4KB package with zero runtime dependencies. It provides a concurrency limiter for async functions. It is used across three later sections:

- Section 05 (enrichment): batch enrichment at concurrency 3
- Section 07 (agent): `indexBucket` action parallel enrichment
- Section 08 (CLI): `enrich --concurrency` flag

Usage pattern (document this so later sections don't have to rediscover it):

```typescript
import pLimit from "p-limit";

const limit = pLimit(3); // max 3 concurrent operations

const results = await Promise.all(
  items.map((item) => limit(() => processItem(item)))
);
```

`pLimit(n)` returns a function. Pass your async callback to that function. `Promise.all` still collects all results; the limiter just controls how many `processItem` calls run at the same time.

---

## Acceptance Criteria

- `web/__tests__/retry.test.ts` passes with `npm test`
- `web/lib/retry.ts` exports `withRetry` and `RetryConfig`
- `p-limit` appears in `web/package.json` under `"dependencies"`
- No real delays in any test — all tests use the injectable `delayFn` (vi.fn that resolves immediately)
- `withRetry` is NOT used anywhere in `web/lib/media/s3.ts` or `web/lib/media/enrichment.ts`
- `withRetry` IS intended for use in `web/lib/media/db.ts` (applied in section-06)
- `npm test` passes with no new failures in other test files
