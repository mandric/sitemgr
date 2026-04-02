import { describe, it, expect } from "vitest";
import { parseCodeFromUrl } from "@/components/device-approve-form";

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
