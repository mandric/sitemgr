# Section 05: Enrichment Hardening

**Depends on:** section-01 (logger), section-02 (retry/SDK config, p-limit, Anthropic singleton), section-03 (validation)
**Blocks:** section-07 (agent hardening), section-08 (CLI hardening)
**Can be implemented in parallel with section-04 after sections 01–03 are merged**

---

## Overview

This section hardens `web/lib/media/enrichment.ts` by fixing three existing bugs and adding batch processing support:

1. **Client-per-call bug:** `enrichImage()` creates a new `Anthropic()` client on every call, losing the SDK's internal rate-limit state. Fixed by a module-level singleton.

2. **Multi-line JSON parse bug:** The current `parseJsonResponse()` uses `split("\n", 2)[1]` to strip markdown fences, which takes only the second line of the response body. Any JSON response that spans more than one line inside the fence is silently truncated and then fails to parse. Fixed by extracting all content between the opening and closing fence markers.

3. **No pre-enrichment validation:** Invalid images (oversized, wrong MIME type, corrupt magic bytes) are currently sent to the Claude API and fail there — wasting quota and producing confusing errors. Fixed by running `validateImage()` before making the API call.

New additions: batch enrichment using `p-limit`, and token/cost logging from the API response `usage` field.

---

## Dependencies

Before starting this section, verify:

- **Section 01 (Logger):** `web/lib/logger.ts` exports `createLogger` and `LogComponent`. All operational logging in `enrichment.ts` will use the structured logger.
- **Section 02 (Retry/SDK):** The `p-limit` package is installed in `web/` (`npm install p-limit` was run). The Anthropic client retry approach is established: configure `maxRetries: 3` on the `Anthropic` constructor, do not wrap calls in `withRetry()`.
- **Section 03 (Validation):** `web/lib/media/validation.ts` exports `validateImage(buffer: Buffer, mimeType: string): ValidationResult` and the `ValidationResult` interface with `{ valid: boolean; errors: string[]; warnings: string[] }`.

---

## Files to Modify

- `web/lib/media/enrichment.ts` — all changes in this section go here

## Files to Create

- `web/__tests__/enrichment.test.ts` — new unit test file

---

## Tests First

**New file:** `web/__tests__/enrichment.test.ts`

Write all tests before changing any implementation. Mock the Anthropic SDK so no real API calls are made. Mock `validateImage` from section 03. Every test must fail before implementation.

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock Anthropic SDK — intercept client construction and messages.create
vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    maxRetries: number;
    constructor(opts?: { maxRetries?: number }) {
      this.maxRetries = opts?.maxRetries ?? 0;
    }
    messages = {
      create: vi.fn(),
    };
  },
}));

// Mock validation from section 03
vi.mock("@/lib/media/validation", () => ({
  validateImage: vi.fn(),
}));
```

### Anthropic client singleton

The singleton is a module-level variable that is initialized once. Testing it requires resetting the module between tests.

```typescript
describe("Anthropic client singleton", () => {
  beforeEach(() => {
    vi.resetModules(); // clear module cache so _client is null at test start
  });

  // Test: the Anthropic constructor is called exactly once across two enrichImage calls
  //       (import fresh module after resetModules, call enrichImage twice,
  //        spy on the mock constructor and verify call count is 1)

  // Test: the singleton is constructed with maxRetries: 3
  //       (import module, call enrichImage once, inspect the instance's maxRetries field)

  // Test: after vi.resetModules(), a new call creates a fresh Anthropic instance
  //       (import module A, call enrichImage; resetModules; import module B, call enrichImage;
  //        the two instances should be different objects)
});
```

Key test technique for verifying the constructor is called exactly once:

```typescript
it("reuses the same Anthropic instance", async () => {
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const constructorSpy = vi.fn();
  // patch mock to track construction
  vi.mocked(Anthropic).mockImplementation(function(this: any, opts: any) {
    constructorSpy(opts);
    this.maxRetries = opts?.maxRetries ?? 0;
    this.messages = { create: vi.fn().mockResolvedValue(mockApiResponse()) };
  });
  const { enrichImage } = await import("@/lib/media/enrichment");

  await enrichImage(validImageBuffer(), "image/jpeg");
  await enrichImage(validImageBuffer(), "image/jpeg");

  expect(constructorSpy).toHaveBeenCalledTimes(1);
  expect(constructorSpy).toHaveBeenCalledWith({ maxRetries: 3 });
});
```

### Response parsing — multi-line JSON fix

These tests exercise `parseJsonResponse` indirectly through `enrichImage`. Set up `validateImage` mock to return `{ valid: true, errors: [], warnings: [] }` so it does not interfere.

```typescript
describe("response parsing", () => {
  beforeEach(() => {
    const { validateImage } = await import("@/lib/media/validation");
    vi.mocked(validateImage).mockReturnValue({ valid: true, errors: [], warnings: [] });
  });

  // Test: parses clean JSON response with no fences
  //       API returns: '{"description":"a photo","objects":[],"context":"","suggested_tags":[]}'
  //       expect: result.description === "a photo"

  // Test: parses response wrapped in ```json ... ``` where JSON is on a single line
  //       API returns: '```json\n{"description":"cat","objects":["cat"],"context":"","suggested_tags":[]}\n```'
  //       expect: result.description === "cat", result.objects deep equals ["cat"]

  // Test: parses response wrapped in ```json ... ``` where JSON spans multiple lines
  //       API returns:
  //         '```json\n{\n  "description": "a photo",\n  "objects": [],\n  "context": "",\n  "suggested_tags": []\n}\n```'
  //       expect: result.description === "a photo"
  //       (this test specifically catches the current split("\n", 2)[1] bug)

  // Test: parses response wrapped in ``` ... ``` fences with no language tag

  // Test: when response cannot be parsed as JSON at all, returns EnrichmentResult with
  //       description: "", objects: [], context: "", suggested_tags: [], raw_response contains original text
  //       (does NOT throw — caller gets an empty result, not an exception)

  // Test: handles missing "objects" field — result.objects is []
  // Test: handles missing "suggested_tags" field — result.suggested_tags is []
  // Test: handles missing "context" field — result.context is ""
  // Test: handles missing "description" field — result.description is ""

  // Test: coerces "objects" from a string to a single-element array
  //       API returns: '{"description":"x","objects":"a dog","context":"","suggested_tags":[]}'
  //       expect: result.objects deep equals ["a dog"]

  // Test: coerces "suggested_tags" from a string to a single-element array
  //       API returns: '{"description":"x","objects":[],"context":"","suggested_tags":"cat"}'
  //       expect: result.suggested_tags deep equals ["cat"]

  // Test: passes through non-empty arrays for objects and suggested_tags unchanged
  //       API returns: '{"description":"x","objects":["a","b"],"context":"","suggested_tags":["y"]}'
  //       expect: result.objects deep equals ["a", "b"]

  // Test: does NOT use a greedy regex fallback
  //       If the response contains two JSON-like objects and neither parse strategy works,
  //       the function returns an empty result rather than trying to match with /{[\s\S]*}/
});
```

### Pre-enrichment validation

```typescript
describe("enrichImage — pre-enrichment validation", () => {
  // Test: calls validateImage with the image buffer and normalized mimeType before calling the API
  //       verifies validateImage mock was called with (buffer, "image/jpeg") when mimeType is "image/jpeg"

  // Test: calls validateImage with normalized mime — passes "image/jpeg" not "image/jpg"
  //       verifies when enrichImage is called with "image/jpg", validateImage receives "image/jpeg"

  // Test: when validateImage returns { valid: false, errors: ["File too large"], warnings: [] },
  //       client.messages.create is NOT called
  //       (the API must not be reached for invalid images)

  // Test: when validateImage returns invalid, enrichImage returns an EnrichmentResult with
  //       description: "" and does not throw
  //       (the caller decides whether a skipped enrichment is a problem, not enrichImage)

  // Test: logs the validation failure reasons at warn level (spy on logger or console.error)

  // Test: when validateImage returns { valid: true, errors: [], warnings: ["Large dimensions"] },
  //       enrichImage proceeds and calls the API
  //       (warnings are logged but do not block enrichment)
});
```

### Token and cost logging

```typescript
describe("enrichImage — token logging", () => {
  // All tests: validateImage mock returns { valid: true, errors: [], warnings: [] }
  // Spy on console.error (the logger writes to stderr via console.error)
  // Parse the JSON from the spy call to find the log entry with message "enrichment complete"

  // Test: the "enrichment complete" log entry includes input_tokens from response.usage
  // Test: the "enrichment complete" log entry includes output_tokens from response.usage
  // Test: the "enrichment complete" log entry includes the model name
  // Test: the "enrichment complete" log entry includes image_size_bytes matching imageBytes.length
  // Test: the log entry is at "info" level

  // Test: if response.usage is absent, logs a warning but does not throw
  //       (mock API response with usage: undefined)
});
```

### Batch enrichment

```typescript
describe("batchEnrichImages", () => {
  // Test: returns BatchEnrichmentResult with correct shape
  //       { total, succeeded, failed, skipped, errors }

  // Test: total === succeeded + failed + skipped for all outcomes

  // Test: when all items succeed, succeeded === total and failed === skipped === 0

  // Test: when one item's validateImage returns invalid, that item is counted as skipped,
  //       not failed, and enrichImage (API call) is not invoked for it

  // Test: when one item's enrichImage throws, that item is counted as failed,
  //       and { key, error: err.message } appears in errors array

  // Test: when one item fails, remaining items are still processed
  //       (batch does not abort on individual failure)

  // Test: respects the concurrency option — with concurrency: 1, items are processed sequentially
  //       Use a mock that records timestamps or call order to verify serialization

  // Test: with default concurrency (3), up to 3 items can be in-flight simultaneously
  //       Use a mock that tracks active call count and records the max seen

  // Test: logs a batch summary at info level when complete
  //       the log entry should include total, succeeded, failed, skipped fields
});
```

Run `npm test` from `web/` after writing the tests. All tests must fail before implementation is written — this confirms the tests are actually testing new behavior.

---

## Implementation

### 1. Module-level logger

At the top of `web/lib/media/enrichment.ts`, after existing imports, add:

```typescript
import { createLogger, LogComponent } from "@/lib/logger";
const logger = createLogger(LogComponent.Enrichment);
```

Replace any existing `console.log` or `console.error` calls with structured log calls using this logger.

### 2. Anthropic client singleton

Add a module-level variable and accessor above `enrichImage`. This replaces the `const client = new Anthropic()` line inside the function body:

```typescript
let _client: Anthropic | null = null;

function getAnthropicClient(): Anthropic {
  if (!_client) {
    _client = new Anthropic({ maxRetries: 3 });
  }
  return _client;
}
```

Inside `enrichImage`, change `const client = new Anthropic()` to `const client = getAnthropicClient()`.

The singleton is important because the Anthropic SDK tracks rate-limit state internally. Creating a new client per call loses that state and makes adaptive rate-limit handling less effective during batch processing.

`maxRetries: 3` means the SDK will make up to 4 total attempts (1 initial + 3 retries) before throwing. It handles 429 (rate limit), 529 (overloaded), and 500 errors automatically using exponential backoff, and reads `retry-after` response headers when present.

Do not add `withRetry()` from `web/lib/retry.ts` around the API call. That causes double-retrying.

For testability: export a `_resetAnthropicClient` function that sets `_client = null`. Prefix it with underscore to signal it is for test use only. Tests call this (or use `vi.resetModules()`) to get a clean singleton.

### 3. Fix `parseJsonResponse` for multi-line JSON

The current implementation:

```typescript
function parseJsonResponse(text: string): Record<string, unknown> {
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.split("\n", 2)[1];   // BUG: takes only second line
    cleaned = cleaned.split("```")[0];
  }
  return JSON.parse(cleaned);
}
```

The `split("\n", 2)[1]` call takes the second line of the response text — that is, the first line of JSON content after the opening fence line like ` ```json `. Any JSON spanning multiple lines has everything past the first line discarded.

Change the function signature to return `Record<string, unknown> | null` (the caller handles `null` instead of catching a throw):

```typescript
function parseJsonResponse(text: string): Record<string, unknown> | null
```

The new parsing strategy, applied in order without regex fallback:

1. Try `JSON.parse(text.trim())` directly. If it succeeds, return the parsed object. This handles responses with no fences, which is the common case once the model is reliably instructed to return plain JSON.

2. If step 1 throws, look for a markdown fence. Find the first occurrence of ` ``` ` (with or without a language tag). The opening fence line ends at the first `\n` after ` ``` `. The closing fence starts at the next ` ``` ` after that. Extract ALL text between those two positions. Try `JSON.parse()` on the extracted content.

3. If step 2 also fails — either no fence was found, or the fenced content is not valid JSON — return `null`.

Do not use a regex like `/{[\s\S]*}/` as a fallback. It is too greedy: if the model includes any conversational text around the JSON, the regex will either match the wrong span or match a partial object. A clean parse failure that returns `null` is safer than a wrong parse that returns garbage.

### 4. Coerce field types after parsing

After calling `parseJsonResponse`, the raw parsed object may have fields with unexpected types. Apply defensive coercions before building the `EnrichmentResult`. Define a small helper:

```typescript
function coerceToStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value as string[];
  if (typeof value === "string" && value.length > 0) return [value];
  return [];
}
```

Use `coerceToStringArray` for `objects` and `suggested_tags`. Use `String(value ?? "")` for `description` and `context` with a fallback to `""`.

If `parseJsonResponse` returns `null`, build an `EnrichmentResult` with all empty/default fields. Log a warning that includes the raw response truncated to 500 characters (to avoid filling logs with huge model outputs):

```typescript
logger.warn("enrichment response could not be parsed", {
  raw_response_preview: rawResponse.slice(0, 500),
});
```

Do not throw when parsing fails — return the empty result. The caller (agent action or CLI) can decide whether an empty enrichment warrants a retry or alert.

### 5. Pre-enrichment validation

Import `validateImage` from `./validation`. At the start of `enrichImage`, before building the base64 string or touching the API client:

```typescript
import { validateImage } from "./validation";
```

Normalize the MIME type first (keep the existing `image/jpg` → `image/jpeg` coercion), then pass the normalized type to `validateImage`:

```typescript
const normalizedMime = mimeType === "image/jpg" ? "image/jpeg" : mimeType;
const validation = validateImage(imageBytes, normalizedMime);
```

If `validation.valid` is false:

- Log the failure at `warn` level, including `validation.errors`, image size in bytes, and MIME type.
- Return an `EnrichmentResult` with all empty/default fields and `raw_response: ""`.
- Do not throw. The caller decides what to do with a skipped enrichment. Do not create any database events — that is the caller's job.

If `validation.valid` is true but `validation.warnings` is non-empty, log the warnings at `info` level and proceed with enrichment.

### 6. Token and cost logging

After a successful API response, log usage metadata before constructing the `EnrichmentResult`:

```typescript
logger.info("enrichment complete", {
  model: response.model,
  input_tokens: response.usage?.input_tokens,
  output_tokens: response.usage?.output_tokens,
  image_size_bytes: imageBytes.length,
});
```

This is observability-only — no billing logic. Use `info` level so it appears in production logs by default.

If `response.usage` is `undefined` (the TypeScript types say it won't be, but be defensive), log a warning and continue rather than crashing:

```typescript
if (!response.usage) {
  logger.warn("enrichment API response missing usage field", { model: response.model });
}
```

### 7. Add `batchEnrichImages`

Add a new exported function. This is the primary entry point for the agent's `index_bucket` action (section 07) and the CLI `enrich` command (section 08):

```typescript
export interface BatchEnrichmentItem {
  key: string;
  imageBytes: Buffer;
  mimeType: string;
}

export interface BatchEnrichmentResult {
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  errors: Array<{ key: string; error: string }>;
}

export async function batchEnrichImages(
  items: BatchEnrichmentItem[],
  options?: { concurrency?: number }
): Promise<BatchEnrichmentResult>
```

Implementation:

- Import `p-limit` at the top of the file: `import pLimit from "p-limit"`.
- Create the limiter inside the function: `const limit = pLimit(options?.concurrency ?? 3)`.
- For each item, run `limit(() => enrichImage(item.imageBytes, item.mimeType))` inside `Promise.all`.
- Count results:
  - If `enrichImage` returns a result with `description === ""` (validation skipped), count as `skipped`.
  - If `enrichImage` returns a result with a non-empty `description`, count as `succeeded`.
  - If `enrichImage` throws, catch the error, count as `failed`, push `{ key: item.key, error: err.message }` to `errors`. Do not rethrow — continue the batch.
- After all items complete, log the summary: `logger.info("batch enrichment complete", { total, succeeded, failed, skipped })`.
- Return the result. `total === succeeded + failed + skipped` must always hold.

The distinction between `skipped` (validation rejected the image, expected and quiet) and `failed` (API call threw, may warrant investigation) lets callers treat them differently.

`batchEnrichImages` does not handle database writes. The caller is responsible for calling `insertEnrichment` after each successful item. Keep the enrichment module free of database imports.

---

## Summary of Changes

| What | Where | Why |
|------|-------|-----|
| `getAnthropicClient()` singleton | `enrichment.ts` | One client preserves SDK rate-limit state across batch calls |
| `parseJsonResponse` multi-line fix | `enrichment.ts` | `split("\n", 2)[1]` truncates multi-line JSON — the current code fails silently |
| `coerceToStringArray()` for `objects` / `suggested_tags` | `enrichment.ts` | Model sometimes returns a string where an array is expected |
| `null` return from `parseJsonResponse` on failure | `enrichment.ts` | Replaces uncaught throw; empty result is safer than crashing the pipeline |
| Pre-enrichment validation via `validateImage` | `enrichment.ts` | Avoids wasting API quota on images the API would reject anyway |
| Token/cost logging from `response.usage` | `enrichment.ts` | Observability for API usage in production |
| `batchEnrichImages` with `p-limit` | `enrichment.ts` | Batch processing with concurrency control and per-item error isolation |
| Structured logging throughout | `enrichment.ts` | Replaces bare `console.log`; includes model, token counts, image size |

---

## Acceptance Criteria

- `web/__tests__/enrichment.test.ts` passes with `npm test`
- The multi-line JSON test passes (this specifically validates the `split("\n", 2)[1]` bug is fixed)
- `web/lib/media/enrichment.ts` no longer contains `new Anthropic()` inside `enrichImage()`
- Calling `enrichImage` with an oversized buffer does not call `client.messages.create`
- `batchEnrichImages` continues processing after an individual item throws
- All log output uses `createLogger(LogComponent.Enrichment)`, not `console.log` or `console.error`
- `withRetry()` from `web/lib/retry.ts` is NOT imported or used anywhere in `enrichment.ts`
- The existing `web/__tests__/s3-actions.test.ts` continues to pass without modification (it mocks `enrichImage` entirely at the module boundary)

---

## Notes

`parseJsonResponse` is currently unexported. Keep it unexported — test it indirectly through `enrichImage`, which is the natural public seam. The multi-line JSON test exercises the bug through `enrichImage` by mocking the Anthropic SDK to return a multi-line fenced response.

`batchEnrichImages` does not call `insertEnrichment`. That responsibility belongs to the caller (section 07 for the agent, section 08 for the CLI). Keeping enrichment and database concerns separated makes each easier to test and change independently.

Section 03's `validateImage` does not check image dimensions — it only checks magic bytes, MIME type, and file size. The dimension warning mentioned in `claude-plan.md` section 4.1 requires decoding image metadata, which is not in scope for section 03. Omit dimension checking in this section; it is a backlog item.
