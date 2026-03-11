import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  encryptSecretVersioned,
  decryptSecretVersioned,
  getEncryptionVersion,
  needsMigration,
} from "@/lib/crypto/encryption-versioned";

describe("encryption-versioned", () => {
  const V1_KEY = "test-encryption-key-v1-for-unit-tests";
  const V2_KEY = "test-encryption-key-v2-for-unit-tests";

  beforeEach(() => {
    vi.stubEnv("ENCRYPTION_KEY_V1", V1_KEY);
    vi.stubEnv("ENCRYPTION_KEY_V2", V2_KEY);
    vi.stubEnv("ENCRYPTION_KEY", V2_KEY); // Fallback to V2
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("encryptSecretVersioned", () => {
    it("encrypts with current version (v2) and adds version prefix", async () => {
      const plaintext = "my-secret-access-key-12345";
      const encrypted = await encryptSecretVersioned(plaintext);

      // Should start with version prefix
      expect(encrypted).toMatch(/^v2:/);

      // Should be valid base64 after the prefix
      const ciphertext = encrypted.split(":")[1];
      expect(() => Buffer.from(ciphertext, "base64")).not.toThrow();
    });

    it("produces different ciphertexts for same plaintext (random IV)", async () => {
      const a = await encryptSecretVersioned("same-value");
      const b = await encryptSecretVersioned("same-value");
      expect(a).not.toBe(b);

      // But both decrypt to the same thing
      expect(await decryptSecretVersioned(a)).toBe("same-value");
      expect(await decryptSecretVersioned(b)).toBe("same-value");
    });

    it("throws without ENCRYPTION_KEY_V2", async () => {
      vi.unstubAllEnvs();
      vi.stubEnv("ENCRYPTION_KEY_V1", V1_KEY);
      // V2 not set

      await expect(encryptSecretVersioned("test")).rejects.toThrow(
        /Encryption key version 2 not configured/
      );
    });
  });

  describe("decryptSecretVersioned", () => {
    it("decrypts v2-encrypted data", async () => {
      const plaintext = "secret-data-v2";
      const encrypted = await encryptSecretVersioned(plaintext);
      const decrypted = await decryptSecretVersioned(encrypted);
      expect(decrypted).toBe(plaintext);
    });

    it("decrypts legacy v1 data (no version prefix)", async () => {
      // Simulate old data encrypted with V1 (no version prefix)
      vi.stubEnv("ENCRYPTION_KEY", V1_KEY);
      const { encryptSecret } = await import("@/lib/crypto/encryption");
      const legacyEncrypted = await encryptSecret("legacy-secret");

      // Now decrypt with versioned function (should use V1 key)
      const decrypted = await decryptSecretVersioned(legacyEncrypted);
      expect(decrypted).toBe("legacy-secret");
    });

    it("decrypts explicitly versioned v1 data", async () => {
      // Manually create v1-prefixed data
      vi.stubEnv("ENCRYPTION_KEY", V1_KEY);
      const { encryptSecret } = await import("@/lib/crypto/encryption");
      const v1Ciphertext = await encryptSecret("v1-secret");
      const v1Versioned = `v1:${v1Ciphertext}`;

      const decrypted = await decryptSecretVersioned(v1Versioned);
      expect(decrypted).toBe("v1-secret");
    });

    it("throws when encryption key version is not available", async () => {
      vi.unstubAllEnvs();
      vi.stubEnv("ENCRYPTION_KEY_V2", V2_KEY);
      // V1 not available

      const v1Data = "v1:someciphertext";
      await expect(decryptSecretVersioned(v1Data)).rejects.toThrow(
        /Encryption key version 1 not available/
      );
    });

    it("throws actionable error when decryption fails", async () => {
      const encrypted = await encryptSecretVersioned("correct-data");

      // Change the key (simulate wrong key)
      vi.stubEnv("ENCRYPTION_KEY_V2", "wrong-key-entirely-different");

      await expect(decryptSecretVersioned(encrypted)).rejects.toThrow(
        /Failed to decrypt secret with version 2/
      );
    });
  });

  describe("getEncryptionVersion", () => {
    it("returns 2 for v2-prefixed data", () => {
      expect(getEncryptionVersion("v2:ciphertext")).toBe(2);
    });

    it("returns 1 for v1-prefixed data", () => {
      expect(getEncryptionVersion("v1:ciphertext")).toBe(1);
    });

    it("returns 1 for legacy data (no prefix)", () => {
      expect(getEncryptionVersion("ciphertext-without-version")).toBe(1);
    });
  });

  describe("needsMigration", () => {
    it("returns true for v1 data", () => {
      expect(needsMigration("v1:ciphertext")).toBe(true);
    });

    it("returns true for legacy data (no prefix)", () => {
      expect(needsMigration("ciphertext-without-version")).toBe(true);
    });

    it("returns false for v2 data", () => {
      expect(needsMigration("v2:ciphertext")).toBe(false);
    });
  });

  describe("roundtrip with multiple versions", () => {
    it("v1 → v2 migration scenario", async () => {
      // Step 1: Encrypt with V1 (simulate old data)
      vi.stubEnv("ENCRYPTION_KEY", V1_KEY);
      const { encryptSecret } = await import("@/lib/crypto/encryption");
      const v1Encrypted = await encryptSecret("secret-to-migrate");

      // Step 2: Verify it's old and needs migration
      expect(needsMigration(v1Encrypted)).toBe(true);

      // Step 3: Decrypt (should still work)
      const decrypted = await decryptSecretVersioned(v1Encrypted);
      expect(decrypted).toBe("secret-to-migrate");

      // Step 4: Re-encrypt with new version
      const v2Encrypted = await encryptSecretVersioned(decrypted);

      // Step 5: Verify new version
      expect(getEncryptionVersion(v2Encrypted)).toBe(2);
      expect(needsMigration(v2Encrypted)).toBe(false);

      // Step 6: Verify can still decrypt
      const finalDecrypted = await decryptSecretVersioned(v2Encrypted);
      expect(finalDecrypted).toBe("secret-to-migrate");
    });
  });

  describe("handles unicode and edge cases", () => {
    it("handles empty string", async () => {
      const encrypted = await encryptSecretVersioned("");
      const decrypted = await decryptSecretVersioned(encrypted);
      expect(decrypted).toBe("");
    });

    it("handles unicode characters", async () => {
      const plaintext = "s3cr3t-with-unicode-🔑-키";
      const encrypted = await encryptSecretVersioned(plaintext);
      const decrypted = await decryptSecretVersioned(encrypted);
      expect(decrypted).toBe(plaintext);
    });

    it("handles long strings", async () => {
      const plaintext = "x".repeat(1000);
      const encrypted = await encryptSecretVersioned(plaintext);
      const decrypted = await decryptSecretVersioned(encrypted);
      expect(decrypted).toBe(plaintext);
    });
  });
});
