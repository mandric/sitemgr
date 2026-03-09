import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { encryptSecret, decryptSecret } from "@/lib/crypto/encryption";

describe("encryption", () => {
  const TEST_KEY = "test-encryption-key-for-unit-tests";

  beforeAll(() => {
    vi.stubEnv("ENCRYPTION_KEY", TEST_KEY);
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it("roundtrips encrypt → decrypt", async () => {
    const plaintext = "my-secret-access-key-12345";
    const encrypted = await encryptSecret(plaintext);
    const decrypted = await decryptSecret(encrypted);
    expect(decrypted).toBe(plaintext);
  });

  it("produces base64 output", async () => {
    const encrypted = await encryptSecret("hello");
    expect(() => Buffer.from(encrypted, "base64")).not.toThrow();
    // IV (12 bytes) + ciphertext (>= 5 bytes plaintext + 16 bytes auth tag)
    const raw = Buffer.from(encrypted, "base64");
    expect(raw.length).toBeGreaterThanOrEqual(12 + 5 + 16);
  });

  it("produces different ciphertexts for same plaintext (random IV)", async () => {
    const a = await encryptSecret("same-value");
    const b = await encryptSecret("same-value");
    expect(a).not.toBe(b);
    // But both decrypt to the same thing
    expect(await decryptSecret(a)).toBe("same-value");
    expect(await decryptSecret(b)).toBe("same-value");
  });

  it("throws without ENCRYPTION_KEY", async () => {
    vi.stubEnv("ENCRYPTION_KEY", "");
    delete process.env.ENCRYPTION_KEY;

    await expect(encryptSecret("test")).rejects.toThrow(
      "ENCRYPTION_KEY environment variable not set"
    );

    // Restore
    vi.stubEnv("ENCRYPTION_KEY", TEST_KEY);
  });

  it("fails to decrypt with wrong key and gives actionable message", async () => {
    const encrypted = await encryptSecret("secret-data");

    // Switch to a different key
    vi.stubEnv("ENCRYPTION_KEY", "wrong-key-entirely-different");

    await expect(decryptSecret(encrypted)).rejects.toThrow(
      /ENCRYPTION_KEY may have changed/
    );

    // Restore
    vi.stubEnv("ENCRYPTION_KEY", TEST_KEY);
  });

  it("handles empty string", async () => {
    const encrypted = await encryptSecret("");
    const decrypted = await decryptSecret(encrypted);
    expect(decrypted).toBe("");
  });

  it("handles unicode", async () => {
    const plaintext = "s3cr3t-with-unicode-🔑-키";
    const encrypted = await encryptSecret(plaintext);
    const decrypted = await decryptSecret(encrypted);
    expect(decrypted).toBe(plaintext);
  });
});
