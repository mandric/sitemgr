import { describe, it, expect } from "vitest";
import { encryptSecret, decryptSecret } from "@/lib/crypto/encryption";

describe("encryption", () => {
  const TEST_KEY = "test-encryption-key-for-unit-tests";

  it("roundtrips encrypt → decrypt", async () => {
    const plaintext = "my-secret-access-key-12345";
    const encrypted = await encryptSecret(plaintext, TEST_KEY);
    const decrypted = await decryptSecret(encrypted, TEST_KEY);
    expect(decrypted).toBe(plaintext);
  });

  it("produces base64 output", async () => {
    const encrypted = await encryptSecret("hello", TEST_KEY);
    expect(() => Buffer.from(encrypted, "base64")).not.toThrow();
    // IV (12 bytes) + ciphertext (>= 5 bytes plaintext + 16 bytes auth tag)
    const raw = Buffer.from(encrypted, "base64");
    expect(raw.length).toBeGreaterThanOrEqual(12 + 5 + 16);
  });

  it("produces different ciphertexts for same plaintext (random IV)", async () => {
    const a = await encryptSecret("same-value", TEST_KEY);
    const b = await encryptSecret("same-value", TEST_KEY);
    expect(a).not.toBe(b);
    // But both decrypt to the same thing
    expect(await decryptSecret(a, TEST_KEY)).toBe("same-value");
    expect(await decryptSecret(b, TEST_KEY)).toBe("same-value");
  });

  it("encryptSecret throws when key is empty string", async () => {
    await expect(encryptSecret("test", "")).rejects.toThrow(
      "Encryption key must be provided",
    );
  });

  it("decryptSecret throws when key is empty string", async () => {
    const encrypted = await encryptSecret("test", TEST_KEY);
    await expect(decryptSecret(encrypted, "")).rejects.toThrow(
      "Encryption key must be provided",
    );
  });

  it("fails to decrypt with wrong key and gives actionable message", async () => {
    const encrypted = await encryptSecret("secret-data", TEST_KEY);

    await expect(
      decryptSecret(encrypted, "wrong-key-entirely-different"),
    ).rejects.toThrow(/key may have changed|different key/);
  });

  it("two concurrent encrypts with different keys produce correct ciphertext", async () => {
    const keyA = "key-alpha-for-concurrent-test";
    const keyB = "key-bravo-for-concurrent-test";

    const [encA, encB] = await Promise.all([
      encryptSecret("plaintext-A", keyA),
      encryptSecret("plaintext-B", keyB),
    ]);

    // Each decrypts with its own key
    expect(await decryptSecret(encA, keyA)).toBe("plaintext-A");
    expect(await decryptSecret(encB, keyB)).toBe("plaintext-B");

    // Cross-key decryption fails
    await expect(decryptSecret(encA, keyB)).rejects.toThrow();
    await expect(decryptSecret(encB, keyA)).rejects.toThrow();
  });

  it("handles empty string", async () => {
    const encrypted = await encryptSecret("", TEST_KEY);
    const decrypted = await decryptSecret(encrypted, TEST_KEY);
    expect(decrypted).toBe("");
  });

  it("handles unicode", async () => {
    const plaintext = "s3cr3t-with-unicode-🔑-키";
    const encrypted = await encryptSecret(plaintext, TEST_KEY);
    const decrypted = await decryptSecret(encrypted, TEST_KEY);
    expect(decrypted).toBe(plaintext);
  });
});
