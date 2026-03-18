import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  encryptSecretVersioned,
  decryptSecretVersioned,
  getEncryptionVersion,
  needsMigration,
} from "@/lib/crypto/encryption-versioned";
import { encryptSecret } from "@/lib/crypto/encryption";

describe("encryption-versioned", () => {
  const V1_KEY = "test-encryption-key-v1-for-unit-tests";
  const V2_KEY = "test-encryption-key-v2-for-unit-tests";

  beforeEach(() => {
    vi.stubEnv("ENCRYPTION_KEY_PREVIOUS", V1_KEY);
    vi.stubEnv("ENCRYPTION_KEY_CURRENT", V2_KEY);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("encryptSecretVersioned", () => {
    it("encrypts with current version and adds version prefix", async () => {
      const plaintext = "my-secret-access-key-12345";
      const encrypted = await encryptSecretVersioned(plaintext);

      // Should start with version prefix
      expect(encrypted).toMatch(/^current:/);

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

    it("throws without ENCRYPTION_KEY_CURRENT", async () => {
      vi.unstubAllEnvs();
      vi.stubEnv("ENCRYPTION_KEY_PREVIOUS", V1_KEY);
      // CURRENT not set

      await expect(encryptSecretVersioned("test")).rejects.toThrow(
        /Encryption key "current" not configured/,
      );
    });
  });

  describe("decryptSecretVersioned", () => {
    it("decrypts current-encrypted data", async () => {
      const plaintext = "secret-data-v2";
      const encrypted = await encryptSecretVersioned(plaintext);
      const decrypted = await decryptSecretVersioned(encrypted);
      expect(decrypted).toBe(plaintext);
    });

    it("decrypts legacy data (no version prefix)", async () => {
      // Create legacy ciphertext using the base module directly with V1 key
      const legacyEncrypted = await encryptSecret("legacy-secret", V1_KEY);

      // Now decrypt with versioned function (should try keys and find V1)
      const decrypted = await decryptSecretVersioned(legacyEncrypted);
      expect(decrypted).toBe("legacy-secret");
    });

    it("decrypts explicitly versioned previous data", async () => {
      // Create ciphertext with V1 key and add previous: prefix
      const v1Ciphertext = await encryptSecret("v1-secret", V1_KEY);
      const v1Versioned = `previous:${v1Ciphertext}`;

      const decrypted = await decryptSecretVersioned(v1Versioned);
      expect(decrypted).toBe("v1-secret");
    });

    it("throws when encryption key is not available", async () => {
      vi.unstubAllEnvs();
      vi.stubEnv("ENCRYPTION_KEY_CURRENT", V2_KEY);
      // PREVIOUS not available

      const previousData = "previous:someciphertext";
      await expect(decryptSecretVersioned(previousData)).rejects.toThrow(
        /Encryption key "previous" not available/,
      );
    });

    it("throws actionable error when decryption fails", async () => {
      const encrypted = await encryptSecretVersioned("correct-data");

      // Change the key (simulate wrong key)
      vi.stubEnv("ENCRYPTION_KEY_CURRENT", "wrong-key-entirely-different");

      await expect(decryptSecretVersioned(encrypted)).rejects.toThrow(
        /Failed to decrypt secret with "current" key/,
      );
    });
  });

  describe("no longer mutates process.env.ENCRYPTION_KEY", () => {
    it("encryptSecretVersioned does not touch process.env.ENCRYPTION_KEY", async () => {
      const sentinel = "sentinel-value-should-not-change";
      process.env.ENCRYPTION_KEY = sentinel;

      await encryptSecretVersioned("some-data");

      expect(process.env.ENCRYPTION_KEY).toBe(sentinel);
      delete process.env.ENCRYPTION_KEY;
    });

    it("decryptSecretVersioned does not touch process.env.ENCRYPTION_KEY", async () => {
      const encrypted = await encryptSecretVersioned("some-data");
      const sentinel = "sentinel-value-should-not-change";
      process.env.ENCRYPTION_KEY = sentinel;

      await decryptSecretVersioned(encrypted);

      expect(process.env.ENCRYPTION_KEY).toBe(sentinel);
      delete process.env.ENCRYPTION_KEY;
    });
  });

  describe("getEncryptionVersion", () => {
    it("returns 'current' for current-prefixed data", () => {
      expect(getEncryptionVersion("current:ciphertext")).toBe("current");
    });

    it("returns 'previous' for previous-prefixed data", () => {
      expect(getEncryptionVersion("previous:ciphertext")).toBe("previous");
    });

    it("returns 'previous' for legacy data (no prefix)", () => {
      expect(getEncryptionVersion("ciphertext-without-version")).toBe(
        "previous",
      );
    });
  });

  describe("needsMigration", () => {
    it("returns true for previous data", () => {
      expect(needsMigration("previous:ciphertext")).toBe(true);
    });

    it("returns true for legacy data (no prefix)", () => {
      expect(needsMigration("ciphertext-without-version")).toBe(true);
    });

    it("returns false for current data", () => {
      expect(needsMigration("current:ciphertext")).toBe(false);
    });
  });

  describe("roundtrip with multiple versions", () => {
    it("previous → current migration scenario", async () => {
      // Step 1: Create legacy ciphertext with V1 key (no prefix)
      const previousEncrypted = await encryptSecret(
        "secret-to-migrate",
        V1_KEY,
      );

      // Step 2: Verify it's old and needs migration
      expect(needsMigration(previousEncrypted)).toBe(true);

      // Step 3: Decrypt (should still work)
      const decrypted = await decryptSecretVersioned(previousEncrypted);
      expect(decrypted).toBe("secret-to-migrate");

      // Step 4: Re-encrypt with new version
      const currentEncrypted = await encryptSecretVersioned(decrypted);

      // Step 5: Verify new version
      expect(getEncryptionVersion(currentEncrypted)).toBe("current");
      expect(needsMigration(currentEncrypted)).toBe(false);

      // Step 6: Verify can still decrypt
      const finalDecrypted = await decryptSecretVersioned(currentEncrypted);
      expect(finalDecrypted).toBe("secret-to-migrate");
    });
  });

  describe("legacy format migration", () => {
    it("legacy format is tried with current key first, then previous, then next", async () => {
      const V3_KEY = "test-encryption-key-v3-for-next";
      // Create legacy ciphertext encrypted with V3 (the "next" key)
      const legacyCiphertext = await encryptSecret("next-era-secret", V3_KEY);

      // Set up all three keys — the legacy data was encrypted with V3
      vi.stubEnv("ENCRYPTION_KEY_CURRENT", V2_KEY);
      vi.stubEnv("ENCRYPTION_KEY_PREVIOUS", V1_KEY);
      vi.stubEnv("ENCRYPTION_KEY_NEXT", V3_KEY);

      // Should succeed by trying current (V2, fails), then previous (V1, fails), then next (V3, succeeds)
      const decrypted = await decryptSecretVersioned(legacyCiphertext);
      expect(decrypted).toBe("next-era-secret");
    });

    it("re-encrypting legacy ciphertext produces current:-prefixed format", async () => {
      const legacyCiphertext = await encryptSecret("old-data", V1_KEY);
      // No prefix — this is legacy format
      expect(legacyCiphertext).not.toMatch(/^(current|previous|next):/);

      const decrypted = await decryptSecretVersioned(legacyCiphertext);
      const reEncrypted = await encryptSecretVersioned(decrypted);

      expect(reEncrypted).toMatch(/^current:/);
      expect(await decryptSecretVersioned(reEncrypted)).toBe("old-data");
    });
  });

  describe("edge cases (extended)", () => {
    it("10KB plaintext encrypts and decrypts without truncation", async () => {
      const plaintext = "A".repeat(10 * 1024);
      const encrypted = await encryptSecretVersioned(plaintext);
      const decrypted = await decryptSecretVersioned(encrypted);
      expect(decrypted).toHaveLength(10 * 1024);
      expect(decrypted).toBe(plaintext);
    });

    it("corrupted ciphertext throws actionable error", async () => {
      const corrupted = "current:not-valid-base64-!!!@@@";
      await expect(decryptSecretVersioned(corrupted)).rejects.toThrow(
        /Failed to decrypt secret with "current" key/,
      );
    });

    it("concurrent encrypt/decrypt calls don't interfere (post-fix)", async () => {
      const plaintexts = Array.from({ length: 20 }, (_, i) => `secret-${i}`);

      // Encrypt all concurrently
      const encrypted = await Promise.all(
        plaintexts.map((p) => encryptSecretVersioned(p)),
      );

      // Decrypt all concurrently
      const decrypted = await Promise.all(
        encrypted.map((e) => decryptSecretVersioned(e)),
      );

      // Verify each matches
      for (let i = 0; i < plaintexts.length; i++) {
        expect(decrypted[i]).toBe(plaintexts[i]);
      }
    });
  });

  describe("encryption_key_version reconciliation", () => {
    it("getEncryptionVersion returns 'current' for current-labeled data", () => {
      // The DB column encryption_key_version is an integer audit trail (1, 2, etc.)
      // The runtime label prefix is "current", "previous", or "next"
      // Version 1 = original key era (maps to "previous" after rotation)
      // After rotation, new data gets "current" label
      expect(getEncryptionVersion("current:base64data")).toBe("current");
    });

    it("needsMigration aligns with version labeling", () => {
      // "current" label = no migration needed
      expect(needsMigration("current:xxx")).toBe(false);
      // "previous" label = migration needed
      expect(needsMigration("previous:xxx")).toBe(true);
      // Legacy (no prefix) = migration needed
      expect(needsMigration("plainbase64nolabel")).toBe(true);
      // "next" label = migration needed (not yet promoted to current)
      expect(needsMigration("next:xxx")).toBe(true);
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
