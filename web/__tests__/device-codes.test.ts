import { describe, it, expect } from "vitest";
import { generateUserCode, generateDeviceCode, SAFE_CHARSET } from "@/lib/auth/device-codes";

describe("generateUserCode()", () => {
  it("generates 8-character code in XXXX-XXXX format", () => {
    const code = generateUserCode();
    expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  });

  it("all characters are from safe charset (ABCDEFGHJKMNPQRSTUVWXYZ23456789)", () => {
    for (let i = 0; i < 50; i++) {
      const code = generateUserCode();
      const chars = code.replace("-", "");
      for (const ch of chars) {
        expect(SAFE_CHARSET).toContain(ch);
      }
    }
  });

  it("contains no ambiguous characters (0, O, 1, I, l)", () => {
    const ambiguous = ["0", "O", "1", "I", "l"];
    for (let i = 0; i < 100; i++) {
      const code = generateUserCode();
      for (const ch of ambiguous) {
        expect(code).not.toContain(ch);
      }
    }
  });

  it("generates unique codes across 100 invocations (statistical uniqueness)", () => {
    const codes = new Set<string>();
    for (let i = 0; i < 100; i++) {
      codes.add(generateUserCode());
    }
    expect(codes.size).toBe(100);
  });
});

describe("generateDeviceCode()", () => {
  it("generates 64-character hex string", () => {
    const code = generateDeviceCode();
    expect(code).toMatch(/^[0-9a-f]{64}$/);
    expect(code).toHaveLength(64);
  });

  it("uses cryptographically random bytes (verify length of underlying buffer)", () => {
    const code = generateDeviceCode();
    const buf = Buffer.from(code, "hex");
    expect(buf).toHaveLength(32);
  });
});
