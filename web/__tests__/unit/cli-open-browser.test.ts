import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("node:child_process", () => ({
  exec: vi.fn(),
}));

import { exec } from "node:child_process";
import { openBrowser } from "@/lib/auth/cli-auth";

const mockExec = vi.mocked(exec);

describe("openBrowser()", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls 'open' on macOS", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    openBrowser("https://example.com");
    expect(mockExec).toHaveBeenCalledWith(
      'open "https://example.com"',
      expect.any(Function),
    );
  });

  it("calls 'xdg-open' on Linux", () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    openBrowser("https://example.com");
    expect(mockExec).toHaveBeenCalledWith(
      'xdg-open "https://example.com"',
      expect.any(Function),
    );
  });

  it("calls 'start' on Windows", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    openBrowser("https://example.com");
    expect(mockExec).toHaveBeenCalledWith(
      'start "https://example.com"',
      expect.any(Function),
    );
  });

  it("prints URL to stderr if exec fails", () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    mockExec.mockImplementation((_cmd, callback) => {
      (callback as (err: Error | null) => void)(new Error("no browser"));
      return {} as ReturnType<typeof exec>;
    });

    openBrowser("https://example.com/test");
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("https://example.com/test"),
    );
  });
});
