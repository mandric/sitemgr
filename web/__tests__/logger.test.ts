import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createLogger, LogComponent } from "@/lib/logger";

describe("createLogger", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns an object with debug, info, warn, and error methods", () => {
    const logger = createLogger("test");
    expect(typeof logger.debug).toBe("function");
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.warn).toBe("function");
    expect(typeof logger.error).toBe("function");
  });

  it("info() writes to stderr via console.error", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = createLogger("test");
    logger.info("hello");

    expect(console.error).toHaveBeenCalledOnce();
    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it("error() writes to stderr via console.error", () => {
    const logger = createLogger("test");
    logger.error("boom");
    expect(console.error).toHaveBeenCalledOnce();
  });

  it("debug() and warn() also write to stderr", () => {
    const logger = createLogger("test");
    logger.debug("dbg");
    logger.warn("wrn");
    expect(console.error).toHaveBeenCalledTimes(2);
  });

  it("output is valid JSON", () => {
    const logger = createLogger("test");
    logger.info("test message");

    const raw = (console.error as ReturnType<typeof vi.spyOn>).mock
      .calls[0][0] as string;
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it("JSON entry includes timestamp that parses as a valid Date", () => {
    const logger = createLogger("test");
    logger.info("test");

    const raw = (console.error as ReturnType<typeof vi.spyOn>).mock
      .calls[0][0] as string;
    const entry = JSON.parse(raw);
    expect(entry.timestamp).toBeDefined();
    const d = new Date(entry.timestamp);
    expect(d.getTime()).not.toBeNaN();
  });

  it("JSON entry includes level field matching the method called", () => {
    const logger = createLogger("test");

    logger.info("a");
    logger.warn("b");
    logger.error("c");
    logger.debug("d");

    const calls = (console.error as ReturnType<typeof vi.spyOn>).mock.calls;
    expect(JSON.parse(calls[0][0] as string).level).toBe("info");
    expect(JSON.parse(calls[1][0] as string).level).toBe("warn");
    expect(JSON.parse(calls[2][0] as string).level).toBe("error");
    expect(JSON.parse(calls[3][0] as string).level).toBe("debug");
  });

  it("JSON entry includes component field matching createLogger argument", () => {
    const logger = createLogger("my-component");
    logger.info("test");

    const raw = (console.error as ReturnType<typeof vi.spyOn>).mock
      .calls[0][0] as string;
    expect(JSON.parse(raw).component).toBe("my-component");
  });

  it("JSON entry includes message field matching the string argument", () => {
    const logger = createLogger("test");
    logger.info("hello world");

    const raw = (console.error as ReturnType<typeof vi.spyOn>).mock
      .calls[0][0] as string;
    expect(JSON.parse(raw).message).toBe("hello world");
  });

  it("additional metadata fields are spread into the top-level JSON", () => {
    const logger = createLogger("test");
    logger.info("hello", { userId: "u1", count: 42 });

    const raw = (console.error as ReturnType<typeof vi.spyOn>).mock
      .calls[0][0] as string;
    const entry = JSON.parse(raw);
    expect(entry.userId).toBe("u1");
    expect(entry.count).toBe(42);
  });

  it("nested objects in metadata are preserved as-is", () => {
    const logger = createLogger("test");
    logger.info("test", { data: { nested: { deep: true } } });

    const raw = (console.error as ReturnType<typeof vi.spyOn>).mock
      .calls[0][0] as string;
    const entry = JSON.parse(raw);
    expect(entry.data).toEqual({ nested: { deep: true } });
  });

  it("Error object in meta includes error_message and error_stack", () => {
    const logger = createLogger("test");
    const err = new Error("something broke");
    logger.error("failure", { err });

    const raw = (console.error as ReturnType<typeof vi.spyOn>).mock
      .calls[0][0] as string;
    const entry = JSON.parse(raw);
    expect(entry.error_message).toBe("something broke");
    expect(entry.error_stack).toContain("something broke");
  });
});

describe("LogComponent", () => {
  it("has expected component name constants", () => {
    expect(LogComponent.S3).toBe("s3");
    expect(LogComponent.Enrichment).toBe("enrichment");
    expect(LogComponent.DB).toBe("db");
    expect(LogComponent.Agent).toBe("agent");
    expect(LogComponent.CLI).toBe("cli");
    expect(LogComponent.API).toBe("api");
    expect(LogComponent.Crypto).toBe("crypto");
  });
});
