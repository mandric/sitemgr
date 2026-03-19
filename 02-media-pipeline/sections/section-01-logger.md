# Section 01: Structured Logger & Request Context

**Depends on:** nothing
**Blocks:** section-04 (S3 hardening), section-05 (enrichment), section-06 (DB hardening), section-07 (agent), section-08 (CLI)
**Can be implemented as an independent PR**

---

## What You Are Building

Two new files:

- `web/lib/logger.ts` — a lightweight structured logger that writes JSON to stderr
- `web/lib/request-context.ts` — an AsyncLocalStorage-based request ID propagation helper

Every subsequent hardening section uses these. Build them first so all subsequent work has observability from day one.

---

## Why Stderr, Not Stdout

The CLI supports piping: `smgr stats | jq .total_events`. If operational logs land on stdout they corrupt that output. All structured logs must go to `console.error` (which writes to stderr). User-facing CLI output (tables, JSON results) continues to use `console.log` to stdout — that output is NOT touched here.

---

## Tests First

Write these tests before writing any implementation code. Run `npm test` from `web/` — all tests should fail (red) until the implementation is complete.

### File: `web/__tests__/logger.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createLogger, LogComponent } from "@/lib/logger";
import { runWithRequestId } from "@/lib/request-context";

describe("createLogger", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Test: returns an object with debug, info, warn, and error methods
  // Test: info() writes to stderr (console.error), not stdout (console.log)
  // Test: error() writes to stderr
  // Test: debug() and warn() also write to stderr
  // Test: output is valid JSON — JSON.parse does not throw on the first argument passed to console.error
  // Test: JSON entry includes "timestamp" field that parses as a valid Date
  // Test: JSON entry includes "level" field matching the method called ("info", "warn", "error", "debug")
  // Test: JSON entry includes "component" field matching the string passed to createLogger
  // Test: JSON entry includes "message" field matching the string argument
  // Test: additional metadata object fields are spread into the top-level JSON (not nested under "meta")
  // Test: nested objects in metadata are preserved as-is
  // Test: calling logger.error() with an Error object in meta includes error_message and error_stack
});
```

Key test pattern — spy on `console.error` and parse the first argument as JSON:

```typescript
it("info() outputs valid JSON to stderr", () => {
  const logger = createLogger("test-component");
  logger.info("hello world", { userId: "u1" });

  expect(console.error).toHaveBeenCalledOnce();
  const raw = (console.error as ReturnType<typeof vi.spyOn>).mock.calls[0][0] as string;
  const entry = JSON.parse(raw);

  expect(entry.level).toBe("info");
  expect(entry.component).toBe("test-component");
  expect(entry.message).toBe("hello world");
  expect(entry.userId).toBe("u1");
  expect(() => new Date(entry.timestamp)).not.toThrow();
});
```

### File: `web/__tests__/request-context.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runWithRequestId, getRequestId } from "@/lib/request-context";
import { createLogger } from "@/lib/logger";

describe("runWithRequestId / getRequestId", () => {
  // Test: getRequestId() returns undefined when called outside any context
  // Test: getRequestId() returns the ID set by runWithRequestId() within the callback
  // Test: nested async calls inside the callback can access the same request ID
  // Test: context does not leak — getRequestId() returns undefined after the callback resolves
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
    // neither context leaked into the other
  });
});

describe("logger integration with request context", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Test: logger includes "request_id" field in the JSON entry when called inside runWithRequestId
  //       — the value matches the ID passed to runWithRequestId
  // Test: logger omits "request_id" field entirely when called outside any context
  //       — JSON.parse(raw) should not have a "request_id" key at all
});
```

---

## Implementation

### `web/lib/request-context.ts`

Uses Node's built-in `AsyncLocalStorage` from the `"async_hooks"` module — no install required.

```typescript
import { AsyncLocalStorage } from "async_hooks";

const storage = new AsyncLocalStorage<string>();

export function runWithRequestId<T>(requestId: string, fn: () => T): T
export function getRequestId(): string | undefined
```

`runWithRequestId` calls `storage.run(requestId, fn)` and returns its result. `getRequestId` calls `storage.getStore()`. The generic `<T>` preserves `Promise<T>` return types automatically — `storage.run()` does this correctly.

Do not export `storage` itself. Do not add any other exports.

### `web/lib/logger.ts`

**The `LogEntry` shape:**

```typescript
interface LogEntry {
  timestamp: string;          // new Date().toISOString()
  level: "debug" | "info" | "warn" | "error";
  component: string;          // passed to createLogger()
  message: string;
  request_id?: string;        // from getRequestId(), omitted if undefined
  [key: string]: unknown;     // extra metadata fields
}
```

**The `Logger` interface:**

```typescript
interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export function createLogger(component: string): Logger
```

**Implementation notes:**

- Each method builds a `LogEntry` object, spreads any `meta` fields into the top-level object (not nested under a `meta` key), then calls `console.error(JSON.stringify(entry))`.
- Import and call `getRequestId()` from `web/lib/request-context.ts`. If it returns `undefined`, omit `request_id` from the entry entirely (do not write `request_id: null`).
- If `meta` contains an `Error` object under any key, extract `.message` as `error_message` and `.stack` as `error_stack` into the top-level entry.
- No external dependencies. No log level filtering in v1 — all levels are written. A `LOG_LEVEL` filter can be added later without breaking callers.
- Read `process.env.LOG_LEVEL` at call time if you add filtering — not at module load time, so `vi.stubEnv()` works in tests without re-importing the module.

**Component name constants:**

Export a `LogComponent` object so callers have autocomplete and no magic strings:

```typescript
export const LogComponent = {
  S3: "s3",
  Enrichment: "enrichment",
  DB: "db",
  Agent: "agent",
  CLI: "cli",
  API: "api",
  Crypto: "crypto",
} as const;
```

Usage: `createLogger(LogComponent.S3)`.

---

## Migration Guide for Existing `console.log` Calls

This section does NOT require migrating all existing `console.log` calls. That happens incrementally in sections 04–08. When you build the logger, just confirm the tests pass and the module is importable.

The rule to apply in later sections:

- **User-facing output** (CLI tables, JSON results, progress output that the user reads): Keep as `console.log` to stdout.
- **Operational logging** (errors, debug info, timings, counts, warnings): Replace with `logger.info()` / `logger.error()` etc. to stderr.

This is a per-call judgment, not a find-and-replace.

---

## Entry Points for Request Context

These entry points will wrap their work in `runWithRequestId` in sections 07 and 08. For now you only need to build the infrastructure:

- **CLI command dispatch** (`web/bin/smgr.ts`): wrap each command handler
- **API route handlers** (`web/app/api/`): wrap the `POST`/`GET` handler body
- **Agent action dispatch** (`web/lib/agent/core.ts`): wrap each action handler invocation

Generate the request ID at each entry point using `ulid()` (already in `package.json`) or `crypto.randomUUID().slice(0, 8)`.

---

## Acceptance Criteria

- `web/__tests__/logger.test.ts` passes with `npm test`
- `web/__tests__/request-context.test.ts` passes with `npm test`
- `web/lib/logger.ts` exports `createLogger` and `LogComponent`
- `web/lib/request-context.ts` exports `runWithRequestId` and `getRequestId`
- No new runtime dependencies added to `package.json`
- All logger output goes to stderr — verified by the `console.error` spy tests
- `npm test` passes with no new failures in other test files
