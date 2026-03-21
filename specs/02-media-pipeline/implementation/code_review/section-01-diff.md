diff --git a/web/__tests__/logger.test.ts b/web/__tests__/logger.test.ts
new file mode 100644
index 0000000..d57dd97
--- /dev/null
+++ b/web/__tests__/logger.test.ts
@@ -0,0 +1,143 @@
+import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
+import { createLogger, LogComponent } from "@/lib/logger";
+import { runWithRequestId } from "@/lib/request-context";
+
+describe("createLogger", () => {
+  beforeEach(() => {
+    vi.spyOn(console, "error").mockImplementation(() => {});
+  });
+
+  afterEach(() => {
+    vi.restoreAllMocks();
+  });
+
+  it("returns an object with debug, info, warn, and error methods", () => {
+    const logger = createLogger("test");
+    expect(typeof logger.debug).toBe("function");
+    expect(typeof logger.info).toBe("function");
+    expect(typeof logger.warn).toBe("function");
+    expect(typeof logger.error).toBe("function");
+  });
+
+  it("info() writes to stderr via console.error", () => {
+    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
+    const logger = createLogger("test");
+    logger.info("hello");
+
+    expect(console.error).toHaveBeenCalledOnce();
+    expect(logSpy).not.toHaveBeenCalled();
+    logSpy.mockRestore();
+  });
+
+  it("error() writes to stderr via console.error", () => {
+    const logger = createLogger("test");
+    logger.error("boom");
+    expect(console.error).toHaveBeenCalledOnce();
+  });
+
+  it("debug() and warn() also write to stderr", () => {
+    const logger = createLogger("test");
+    logger.debug("dbg");
+    logger.warn("wrn");
+    expect(console.error).toHaveBeenCalledTimes(2);
+  });
+
+  it("output is valid JSON", () => {
+    const logger = createLogger("test");
+    logger.info("test message");
+
+    const raw = (console.error as ReturnType<typeof vi.spyOn>).mock
+      .calls[0][0] as string;
+    expect(() => JSON.parse(raw)).not.toThrow();
+  });
+
+  it("JSON entry includes timestamp that parses as a valid Date", () => {
+    const logger = createLogger("test");
+    logger.info("test");
+
+    const raw = (console.error as ReturnType<typeof vi.spyOn>).mock
+      .calls[0][0] as string;
+    const entry = JSON.parse(raw);
+    expect(entry.timestamp).toBeDefined();
+    const d = new Date(entry.timestamp);
+    expect(d.getTime()).not.toBeNaN();
+  });
+
+  it("JSON entry includes level field matching the method called", () => {
+    const logger = createLogger("test");
+
+    logger.info("a");
+    logger.warn("b");
+    logger.error("c");
+    logger.debug("d");
+
+    const calls = (console.error as ReturnType<typeof vi.spyOn>).mock.calls;
+    expect(JSON.parse(calls[0][0] as string).level).toBe("info");
+    expect(JSON.parse(calls[1][0] as string).level).toBe("warn");
+    expect(JSON.parse(calls[2][0] as string).level).toBe("error");
+    expect(JSON.parse(calls[3][0] as string).level).toBe("debug");
+  });
+
+  it("JSON entry includes component field matching createLogger argument", () => {
+    const logger = createLogger("my-component");
+    logger.info("test");
+
+    const raw = (console.error as ReturnType<typeof vi.spyOn>).mock
+      .calls[0][0] as string;
+    expect(JSON.parse(raw).component).toBe("my-component");
+  });
+
+  it("JSON entry includes message field matching the string argument", () => {
+    const logger = createLogger("test");
+    logger.info("hello world");
+
+    const raw = (console.error as ReturnType<typeof vi.spyOn>).mock
+      .calls[0][0] as string;
+    expect(JSON.parse(raw).message).toBe("hello world");
+  });
+
+  it("additional metadata fields are spread into the top-level JSON", () => {
+    const logger = createLogger("test");
+    logger.info("hello", { userId: "u1", count: 42 });
+
+    const raw = (console.error as ReturnType<typeof vi.spyOn>).mock
+      .calls[0][0] as string;
+    const entry = JSON.parse(raw);
+    expect(entry.userId).toBe("u1");
+    expect(entry.count).toBe(42);
+  });
+
+  it("nested objects in metadata are preserved as-is", () => {
+    const logger = createLogger("test");
+    logger.info("test", { data: { nested: { deep: true } } });
+
+    const raw = (console.error as ReturnType<typeof vi.spyOn>).mock
+      .calls[0][0] as string;
+    const entry = JSON.parse(raw);
+    expect(entry.data).toEqual({ nested: { deep: true } });
+  });
+
+  it("Error object in meta includes error_message and error_stack", () => {
+    const logger = createLogger("test");
+    const err = new Error("something broke");
+    logger.error("failure", { err });
+
+    const raw = (console.error as ReturnType<typeof vi.spyOn>).mock
+      .calls[0][0] as string;
+    const entry = JSON.parse(raw);
+    expect(entry.error_message).toBe("something broke");
+    expect(entry.error_stack).toContain("something broke");
+  });
+});
+
+describe("LogComponent", () => {
+  it("has expected component name constants", () => {
+    expect(LogComponent.S3).toBe("s3");
+    expect(LogComponent.Enrichment).toBe("enrichment");
+    expect(LogComponent.DB).toBe("db");
+    expect(LogComponent.Agent).toBe("agent");
+    expect(LogComponent.CLI).toBe("cli");
+    expect(LogComponent.API).toBe("api");
+    expect(LogComponent.Crypto).toBe("crypto");
+  });
+});
diff --git a/web/__tests__/request-context.test.ts b/web/__tests__/request-context.test.ts
new file mode 100644
index 0000000..80079ae
--- /dev/null
+++ b/web/__tests__/request-context.test.ts
@@ -0,0 +1,82 @@
+import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
+import { runWithRequestId, getRequestId } from "@/lib/request-context";
+import { createLogger } from "@/lib/logger";
+
+describe("runWithRequestId / getRequestId", () => {
+  it("getRequestId() returns undefined when called outside any context", () => {
+    expect(getRequestId()).toBeUndefined();
+  });
+
+  it("getRequestId() returns the ID set by runWithRequestId within the callback", () => {
+    runWithRequestId("req-123", () => {
+      expect(getRequestId()).toBe("req-123");
+    });
+  });
+
+  it("nested async calls inside the callback can access the same request ID", async () => {
+    await runWithRequestId("req-456", async () => {
+      await Promise.resolve();
+      expect(getRequestId()).toBe("req-456");
+
+      await new Promise((r) => setTimeout(r, 1));
+      expect(getRequestId()).toBe("req-456");
+    });
+  });
+
+  it("context does not leak after the callback resolves", async () => {
+    await runWithRequestId("req-789", async () => {
+      expect(getRequestId()).toBe("req-789");
+    });
+    expect(getRequestId()).toBeUndefined();
+  });
+});
+
+describe("concurrent context isolation", () => {
+  it("two parallel runWithRequestId calls are isolated from each other", async () => {
+    const results: string[] = [];
+    await Promise.all([
+      runWithRequestId("req-A", async () => {
+        await new Promise((r) => setTimeout(r, 5));
+        results.push(getRequestId()!);
+      }),
+      runWithRequestId("req-B", async () => {
+        await new Promise((r) => setTimeout(r, 2));
+        results.push(getRequestId()!);
+      }),
+    ]);
+    expect(results).toContain("req-A");
+    expect(results).toContain("req-B");
+    expect(results).toHaveLength(2);
+  });
+});
+
+describe("logger integration with request context", () => {
+  beforeEach(() => {
+    vi.spyOn(console, "error").mockImplementation(() => {});
+  });
+  afterEach(() => {
+    vi.restoreAllMocks();
+  });
+
+  it("logger includes request_id when called inside runWithRequestId", () => {
+    const logger = createLogger("test");
+    runWithRequestId("ctx-abc", () => {
+      logger.info("inside context");
+    });
+
+    const raw = (console.error as ReturnType<typeof vi.spyOn>).mock
+      .calls[0][0] as string;
+    const entry = JSON.parse(raw);
+    expect(entry.request_id).toBe("ctx-abc");
+  });
+
+  it("logger omits request_id when called outside any context", () => {
+    const logger = createLogger("test");
+    logger.info("outside context");
+
+    const raw = (console.error as ReturnType<typeof vi.spyOn>).mock
+      .calls[0][0] as string;
+    const entry = JSON.parse(raw);
+    expect(entry).not.toHaveProperty("request_id");
+  });
+});
diff --git a/web/lib/logger.ts b/web/lib/logger.ts
new file mode 100644
index 0000000..5ea835b
--- /dev/null
+++ b/web/lib/logger.ts
@@ -0,0 +1,67 @@
+import { getRequestId } from "./request-context";
+
+export const LogComponent = {
+  S3: "s3",
+  Enrichment: "enrichment",
+  DB: "db",
+  Agent: "agent",
+  CLI: "cli",
+  API: "api",
+  Crypto: "crypto",
+} as const;
+
+interface LogEntry {
+  timestamp: string;
+  level: "debug" | "info" | "warn" | "error";
+  component: string;
+  message: string;
+  request_id?: string;
+  [key: string]: unknown;
+}
+
+export interface Logger {
+  debug(message: string, meta?: Record<string, unknown>): void;
+  info(message: string, meta?: Record<string, unknown>): void;
+  warn(message: string, meta?: Record<string, unknown>): void;
+  error(message: string, meta?: Record<string, unknown>): void;
+}
+
+export function createLogger(component: string): Logger {
+  function log(
+    level: LogEntry["level"],
+    message: string,
+    meta?: Record<string, unknown>,
+  ): void {
+    const entry: LogEntry = {
+      timestamp: new Date().toISOString(),
+      level,
+      component,
+      message,
+    };
+
+    const requestId = getRequestId();
+    if (requestId !== undefined) {
+      entry.request_id = requestId;
+    }
+
+    if (meta) {
+      for (const [key, value] of Object.entries(meta)) {
+        if (value instanceof Error) {
+          entry.error_message = value.message;
+          entry.error_stack = value.stack;
+        } else {
+          entry[key] = value;
+        }
+      }
+    }
+
+    console.error(JSON.stringify(entry));
+  }
+
+  return {
+    debug: (message, meta) => log("debug", message, meta),
+    info: (message, meta) => log("info", message, meta),
+    warn: (message, meta) => log("warn", message, meta),
+    error: (message, meta) => log("error", message, meta),
+  };
+}
diff --git a/web/lib/request-context.ts b/web/lib/request-context.ts
new file mode 100644
index 0000000..3e640ed
--- /dev/null
+++ b/web/lib/request-context.ts
@@ -0,0 +1,11 @@
+import { AsyncLocalStorage } from "async_hooks";
+
+const storage = new AsyncLocalStorage<string>();
+
+export function runWithRequestId<T>(requestId: string, fn: () => T): T {
+  return storage.run(requestId, fn);
+}
+
+export function getRequestId(): string | undefined {
+  return storage.getStore();
+}
