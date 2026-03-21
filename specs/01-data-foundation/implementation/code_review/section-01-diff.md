diff --git a/web/__tests__/encryption-versioned.test.ts b/web/__tests__/encryption-versioned.test.ts
index 5e822fb..ea0a1f3 100644
--- a/web/__tests__/encryption-versioned.test.ts
+++ b/web/__tests__/encryption-versioned.test.ts
@@ -5,6 +5,7 @@ import {
   getEncryptionVersion,
   needsMigration,
 } from "@/lib/crypto/encryption-versioned";
+import { encryptSecret } from "@/lib/crypto/encryption";
 
 describe("encryption-versioned", () => {
   const V1_KEY = "test-encryption-key-v1-for-unit-tests";
@@ -13,7 +14,6 @@ describe("encryption-versioned", () => {
   beforeEach(() => {
     vi.stubEnv("ENCRYPTION_KEY_PREVIOUS", V1_KEY);
     vi.stubEnv("ENCRYPTION_KEY_CURRENT", V2_KEY);
-    vi.stubEnv("ENCRYPTION_KEY", V2_KEY); // Fallback to V2
   });
 
   afterEach(() => {
@@ -21,7 +21,7 @@ describe("encryption-versioned", () => {
   });
 
   describe("encryptSecretVersioned", () => {
-    it("encrypts with current version (v2) and adds version prefix", async () => {
+    it("encrypts with current version and adds version prefix", async () => {
       const plaintext = "my-secret-access-key-12345";
       const encrypted = await encryptSecretVersioned(plaintext);
 
@@ -55,29 +55,25 @@ describe("encryption-versioned", () => {
   });
 
   describe("decryptSecretVersioned", () => {
-    it("decrypts v2-encrypted data", async () => {
+    it("decrypts current-encrypted data", async () => {
       const plaintext = "secret-data-v2";
       const encrypted = await encryptSecretVersioned(plaintext);
       const decrypted = await decryptSecretVersioned(encrypted);
       expect(decrypted).toBe(plaintext);
     });
 
-    it("decrypts legacy v1 data (no version prefix)", async () => {
-      // Simulate old data encrypted with V1 (no version prefix)
-      vi.stubEnv("ENCRYPTION_KEY", V1_KEY);
-      const { encryptSecret } = await import("@/lib/crypto/encryption");
-      const legacyEncrypted = await encryptSecret("legacy-secret");
+    it("decrypts legacy data (no version prefix)", async () => {
+      // Create legacy ciphertext using the base module directly with V1 key
+      const legacyEncrypted = await encryptSecret("legacy-secret", V1_KEY);
 
-      // Now decrypt with versioned function (should use V1 key)
+      // Now decrypt with versioned function (should try keys and find V1)
       const decrypted = await decryptSecretVersioned(legacyEncrypted);
       expect(decrypted).toBe("legacy-secret");
     });
 
-    it("decrypts explicitly versioned v1 data", async () => {
-      // Manually create v1-prefixed data
-      vi.stubEnv("ENCRYPTION_KEY", V1_KEY);
-      const { encryptSecret } = await import("@/lib/crypto/encryption");
-      const v1Ciphertext = await encryptSecret("v1-secret");
+    it("decrypts explicitly versioned previous data", async () => {
+      // Create ciphertext with V1 key and add previous: prefix
+      const v1Ciphertext = await encryptSecret("v1-secret", V1_KEY);
       const v1Versioned = `previous:${v1Ciphertext}`;
 
       const decrypted = await decryptSecretVersioned(v1Versioned);
@@ -107,6 +103,29 @@ describe("encryption-versioned", () => {
     });
   });
 
+  describe("no longer mutates process.env.ENCRYPTION_KEY", () => {
+    it("encryptSecretVersioned does not touch process.env.ENCRYPTION_KEY", async () => {
+      const sentinel = "sentinel-value-should-not-change";
+      process.env.ENCRYPTION_KEY = sentinel;
+
+      await encryptSecretVersioned("some-data");
+
+      expect(process.env.ENCRYPTION_KEY).toBe(sentinel);
+      delete process.env.ENCRYPTION_KEY;
+    });
+
+    it("decryptSecretVersioned does not touch process.env.ENCRYPTION_KEY", async () => {
+      const encrypted = await encryptSecretVersioned("some-data");
+      const sentinel = "sentinel-value-should-not-change";
+      process.env.ENCRYPTION_KEY = sentinel;
+
+      await decryptSecretVersioned(encrypted);
+
+      expect(process.env.ENCRYPTION_KEY).toBe(sentinel);
+      delete process.env.ENCRYPTION_KEY;
+    });
+  });
+
   describe("getEncryptionVersion", () => {
     it("returns 'current' for current-prefixed data", () => {
       expect(getEncryptionVersion("current:ciphertext")).toBe("current");
@@ -139,10 +158,11 @@ describe("encryption-versioned", () => {
 
   describe("roundtrip with multiple versions", () => {
     it("previous → current migration scenario", async () => {
-      // Step 1: Encrypt with PREVIOUS (simulate old data)
-      vi.stubEnv("ENCRYPTION_KEY", V1_KEY);
-      const { encryptSecret } = await import("@/lib/crypto/encryption");
-      const previousEncrypted = await encryptSecret("secret-to-migrate");
+      // Step 1: Create legacy ciphertext with V1 key (no prefix)
+      const previousEncrypted = await encryptSecret(
+        "secret-to-migrate",
+        V1_KEY,
+      );
 
       // Step 2: Verify it's old and needs migration
       expect(needsMigration(previousEncrypted)).toBe(true);
diff --git a/web/__tests__/encryption.test.ts b/web/__tests__/encryption.test.ts
index 99ce9d1..939367d 100644
--- a/web/__tests__/encryption.test.ts
+++ b/web/__tests__/encryption.test.ts
@@ -1,26 +1,18 @@
-import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
+import { describe, it, expect } from "vitest";
 import { encryptSecret, decryptSecret } from "@/lib/crypto/encryption";
 
 describe("encryption", () => {
   const TEST_KEY = "test-encryption-key-for-unit-tests";
 
-  beforeAll(() => {
-    vi.stubEnv("ENCRYPTION_KEY", TEST_KEY);
-  });
-
-  afterAll(() => {
-    vi.unstubAllEnvs();
-  });
-
   it("roundtrips encrypt → decrypt", async () => {
     const plaintext = "my-secret-access-key-12345";
-    const encrypted = await encryptSecret(plaintext);
-    const decrypted = await decryptSecret(encrypted);
+    const encrypted = await encryptSecret(plaintext, TEST_KEY);
+    const decrypted = await decryptSecret(encrypted, TEST_KEY);
     expect(decrypted).toBe(plaintext);
   });
 
   it("produces base64 output", async () => {
-    const encrypted = await encryptSecret("hello");
+    const encrypted = await encryptSecret("hello", TEST_KEY);
     expect(() => Buffer.from(encrypted, "base64")).not.toThrow();
     // IV (12 bytes) + ciphertext (>= 5 bytes plaintext + 16 bytes auth tag)
     const raw = Buffer.from(encrypted, "base64");
@@ -28,50 +20,56 @@ describe("encryption", () => {
   });
 
   it("produces different ciphertexts for same plaintext (random IV)", async () => {
-    const a = await encryptSecret("same-value");
-    const b = await encryptSecret("same-value");
+    const a = await encryptSecret("same-value", TEST_KEY);
+    const b = await encryptSecret("same-value", TEST_KEY);
     expect(a).not.toBe(b);
     // But both decrypt to the same thing
-    expect(await decryptSecret(a)).toBe("same-value");
-    expect(await decryptSecret(b)).toBe("same-value");
+    expect(await decryptSecret(a, TEST_KEY)).toBe("same-value");
+    expect(await decryptSecret(b, TEST_KEY)).toBe("same-value");
   });
 
-  it("throws without ENCRYPTION_KEY", async () => {
-    vi.stubEnv("ENCRYPTION_KEY", "");
-    delete process.env.ENCRYPTION_KEY;
-
-    await expect(encryptSecret("test")).rejects.toThrow(
-      "ENCRYPTION_KEY environment variable not set"
+  it("throws when key is empty string", async () => {
+    await expect(encryptSecret("test", "")).rejects.toThrow(
+      "Encryption key must be provided",
     );
-
-    // Restore
-    vi.stubEnv("ENCRYPTION_KEY", TEST_KEY);
   });
 
   it("fails to decrypt with wrong key and gives actionable message", async () => {
-    const encrypted = await encryptSecret("secret-data");
+    const encrypted = await encryptSecret("secret-data", TEST_KEY);
 
-    // Switch to a different key
-    vi.stubEnv("ENCRYPTION_KEY", "wrong-key-entirely-different");
+    await expect(
+      decryptSecret(encrypted, "wrong-key-entirely-different"),
+    ).rejects.toThrow(/key may have changed|different key/);
+  });
 
-    await expect(decryptSecret(encrypted)).rejects.toThrow(
-      /ENCRYPTION_KEY may have changed/
-    );
+  it("two concurrent encrypts with different keys produce correct ciphertext", async () => {
+    const keyA = "key-alpha-for-concurrent-test";
+    const keyB = "key-bravo-for-concurrent-test";
+
+    const [encA, encB] = await Promise.all([
+      encryptSecret("plaintext-A", keyA),
+      encryptSecret("plaintext-B", keyB),
+    ]);
+
+    // Each decrypts with its own key
+    expect(await decryptSecret(encA, keyA)).toBe("plaintext-A");
+    expect(await decryptSecret(encB, keyB)).toBe("plaintext-B");
 
-    // Restore
-    vi.stubEnv("ENCRYPTION_KEY", TEST_KEY);
+    // Cross-key decryption fails
+    await expect(decryptSecret(encA, keyB)).rejects.toThrow();
+    await expect(decryptSecret(encB, keyA)).rejects.toThrow();
   });
 
   it("handles empty string", async () => {
-    const encrypted = await encryptSecret("");
-    const decrypted = await decryptSecret(encrypted);
+    const encrypted = await encryptSecret("", TEST_KEY);
+    const decrypted = await decryptSecret(encrypted, TEST_KEY);
     expect(decrypted).toBe("");
   });
 
   it("handles unicode", async () => {
     const plaintext = "s3cr3t-with-unicode-🔑-키";
-    const encrypted = await encryptSecret(plaintext);
-    const decrypted = await decryptSecret(encrypted);
+    const encrypted = await encryptSecret(plaintext, TEST_KEY);
+    const decrypted = await decryptSecret(encrypted, TEST_KEY);
     expect(decrypted).toBe(plaintext);
   });
 });
diff --git a/web/lib/crypto/encryption-versioned.ts b/web/lib/crypto/encryption-versioned.ts
index 6050fb8..15e98f8 100644
--- a/web/lib/crypto/encryption-versioned.ts
+++ b/web/lib/crypto/encryption-versioned.ts
@@ -83,23 +83,8 @@ export async function encryptSecretVersioned(
     );
   }
 
-  // Temporarily set ENCRYPTION_KEY for the base encryptSecret function
-  const originalKey = process.env.ENCRYPTION_KEY;
-  process.env.ENCRYPTION_KEY = currentKey.key;
-
-  try {
-    const ciphertext = await encryptSecret(plaintext);
-
-    // Prepend label to ciphertext
-    return `${CURRENT_KEY_LABEL}:${ciphertext}`;
-  } finally {
-    // Restore original key
-    if (originalKey) {
-      process.env.ENCRYPTION_KEY = originalKey;
-    } else {
-      delete process.env.ENCRYPTION_KEY;
-    }
-  }
+  const ciphertext = await encryptSecret(plaintext, currentKey.key);
+  return `${CURRENT_KEY_LABEL}:${ciphertext}`;
 }
 
 /**
@@ -133,19 +118,7 @@ export async function decryptSecretVersioned(
       if (!keyConfig) continue;
 
       try {
-        const originalKey = process.env.ENCRYPTION_KEY;
-        process.env.ENCRYPTION_KEY = keyConfig.key;
-
-        try {
-          const plaintext = await decryptSecret(versionedCiphertext);
-          return plaintext;
-        } finally {
-          if (originalKey) {
-            process.env.ENCRYPTION_KEY = originalKey;
-          } else {
-            delete process.env.ENCRYPTION_KEY;
-          }
-        }
+        return await decryptSecret(versionedCiphertext, keyConfig.key);
       } catch {
         // Try next key
         continue;
@@ -171,23 +144,14 @@ export async function decryptSecretVersioned(
     );
   }
 
-  const originalKey = process.env.ENCRYPTION_KEY;
-  process.env.ENCRYPTION_KEY = keyConfig.key;
-
   try {
-    return await decryptSecret(ciphertext);
+    return await decryptSecret(ciphertext, keyConfig.key);
   } catch (err: unknown) {
     throw new Error(
       `Failed to decrypt secret with "${label}" key. ` +
         `The ENCRYPTION_KEY_${label.toUpperCase()} may be incorrect.`,
       { cause: err },
     );
-  } finally {
-    if (originalKey) {
-      process.env.ENCRYPTION_KEY = originalKey;
-    } else {
-      delete process.env.ENCRYPTION_KEY;
-    }
   }
 }
 
diff --git a/web/lib/crypto/encryption.ts b/web/lib/crypto/encryption.ts
index 37c6502..449a62f 100644
--- a/web/lib/crypto/encryption.ts
+++ b/web/lib/crypto/encryption.ts
@@ -3,21 +3,20 @@
  * Uses AES-256-GCM encryption, compatible with Edge Function implementation
  */
 
-export async function encryptSecret(plaintext: string): Promise<string> {
-  const encryptionKey = process.env.ENCRYPTION_KEY;
-  if (!encryptionKey) {
-    throw new Error("ENCRYPTION_KEY environment variable not set");
+export async function encryptSecret(plaintext: string, key: string): Promise<string> {
+  if (!key) {
+    throw new Error("Encryption key must be provided");
   }
 
   const encoder = new TextEncoder();
   const data = encoder.encode(plaintext);
-  const keyData = encoder.encode(encryptionKey);
+  const keyData = encoder.encode(key);
 
   // Derive 256-bit key using SHA-256
   const keyBytes = await crypto.subtle.digest("SHA-256", keyData);
 
   // Import key for AES-GCM
-  const key = await crypto.subtle.importKey(
+  const cryptoKey = await crypto.subtle.importKey(
     "raw",
     keyBytes,
     { name: "AES-GCM", length: 256 },
@@ -31,7 +30,7 @@ export async function encryptSecret(plaintext: string): Promise<string> {
   // Encrypt
   const encrypted = await crypto.subtle.encrypt(
     { name: "AES-GCM", iv },
-    key,
+    cryptoKey,
     data
   );
 
@@ -43,21 +42,20 @@ export async function encryptSecret(plaintext: string): Promise<string> {
   return Buffer.from(combined).toString("base64");
 }
 
-export async function decryptSecret(ciphertext: string): Promise<string> {
-  const encryptionKey = process.env.ENCRYPTION_KEY;
-  if (!encryptionKey) {
-    throw new Error("ENCRYPTION_KEY environment variable not set");
+export async function decryptSecret(ciphertext: string, key: string): Promise<string> {
+  if (!key) {
+    throw new Error("Encryption key must be provided");
   }
 
   const encoder = new TextEncoder();
   const decoder = new TextDecoder();
-  const keyData = encoder.encode(encryptionKey);
+  const keyData = encoder.encode(key);
 
   // Derive 256-bit key using SHA-256
   const keyBytes = await crypto.subtle.digest("SHA-256", keyData);
 
   // Import key for AES-GCM
-  const key = await crypto.subtle.importKey(
+  const cryptoKey = await crypto.subtle.importKey(
     "raw",
     keyBytes,
     { name: "AES-GCM", length: 256 },
@@ -77,12 +75,12 @@ export async function decryptSecret(ciphertext: string): Promise<string> {
   try {
     decrypted = await crypto.subtle.decrypt(
       { name: "AES-GCM", iv },
-      key,
+      cryptoKey,
       encrypted
     );
   } catch (err) {
     throw new Error(
-      "Failed to decrypt secret — the ENCRYPTION_KEY may have changed or the data was encrypted with a different key",
+      "Failed to decrypt secret — the encryption key may have changed or the data was encrypted with a different key",
       { cause: err }
     );
   }
