import { describe, it, expect, vi, beforeEach } from "vitest";
import { approveDevice, parseCodeFromUrl } from "@/components/device-approve-form";

describe("parseCodeFromUrl", () => {
  it("extracts code from ?code=ABCD-1234", () => {
    expect(parseCodeFromUrl("?code=ABCD-1234")).toBe("ABCD-1234");
  });

  it("returns null when no code param", () => {
    expect(parseCodeFromUrl("?other=value")).toBeNull();
  });

  it("normalizes code to uppercase", () => {
    expect(parseCodeFromUrl("?code=abcd-1234")).toBe("ABCD-1234");
  });

  it("returns null for empty string", () => {
    expect(parseCodeFromUrl("")).toBeNull();
  });
});

describe("approveDevice", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("calls fetch with correct URL and body", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    );

    await approveDevice("ABCD-1234");

    expect(fetchSpy).toHaveBeenCalledWith("/api/auth/device/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_code: "ABCD-1234" }),
    });
  });

  it("returns success on 200 response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    );

    const result = await approveDevice("ABCD-1234");
    expect(result).toEqual({ success: true });
  });

  it("returns error message on 404 response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ error: "Code not found or expired" }),
        { status: 404 },
      ),
    );

    const result = await approveDevice("ABCD-1234");
    expect(result).toEqual({
      success: false,
      error: "Code not found or expired",
    });
  });

  it("returns unauthorized on 401 response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401 },
      ),
    );

    const result = await approveDevice("ABCD-1234");
    expect(result).toEqual({
      success: false,
      error: "Unauthorized",
      unauthorized: true,
    });
  });

  it("returns error on network failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("Network error"),
    );

    const result = await approveDevice("ABCD-1234");
    expect(result).toEqual({
      success: false,
      error: "Network error. Please try again.",
    });
  });
});
