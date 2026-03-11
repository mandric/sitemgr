/**
 * Versioned encryption - supports multiple encryption keys simultaneously
 *
 * Benefits:
 * - Zero-downtime key rotation
 * - Graceful migration from old to new keys
 * - No user impact during key changes
 *
 * Usage:
 *   // Encrypting (always uses current version)
 *   const encrypted = await encryptSecretVersioned("my-secret");
 *   // Result: "v2:base64ciphertext..."
 *
 *   // Decrypting (auto-detects version)
 *   const plaintext = await decryptSecretVersioned(encrypted);
 *
 * Environment Variables:
 *   ENCRYPTION_KEY_V1=<key>      (optional, for backward compatibility during rotation)
 *   ENCRYPTION_KEY_V2=<key>      (current - required)
 *   ENCRYPTION_KEY_V3=<key>      (optional, for gradual rollout)
 *
 * Key Rotation Process:
 *   1. Set ENCRYPTION_KEY_V2 in production (keep V1 active)
 *   2. Update CURRENT_VERSION to 2
 *   3. Deploy (new encryptions use V2, old ones still readable with V1)
 *   4. Run background migration to re-encrypt V1 → V2
 *   5. Once migration complete, remove ENCRYPTION_KEY_V1
 */

import { encryptSecret, decryptSecret } from "./encryption";

interface EncryptionKeyConfig {
  version: number;
  key: string;
}

/**
 * Define available encryption keys
 * Keys are loaded from environment variables
 */
function getAvailableKeys(): EncryptionKeyConfig[] {
  const keys: EncryptionKeyConfig[] = [];

  // V1: Original key (backward compatibility)
  if (process.env.ENCRYPTION_KEY_V1) {
    keys.push({ version: 1, key: process.env.ENCRYPTION_KEY_V1 });
  }

  // V2: Current key
  if (process.env.ENCRYPTION_KEY_V2) {
    keys.push({
      version: 2,
      key: process.env.ENCRYPTION_KEY_V2,
    });
  }

  // V3: Future key (for gradual rollout)
  if (process.env.ENCRYPTION_KEY_V3) {
    keys.push({ version: 3, key: process.env.ENCRYPTION_KEY_V3 });
  }

  return keys;
}

/**
 * Current version to use for new encryptions
 * Update this when rotating keys
 */
const CURRENT_VERSION = 2;

/**
 * Encrypt a secret with the current encryption key version
 *
 * @param plaintext - The secret to encrypt
 * @returns Versioned ciphertext (format: "v{version}:{base64}")
 */
export async function encryptSecretVersioned(
  plaintext: string,
): Promise<string> {
  const keys = getAvailableKeys();
  const currentKey = keys.find((k) => k.version === CURRENT_VERSION);

  if (!currentKey) {
    throw new Error(
      `Encryption key version ${CURRENT_VERSION} not configured. ` +
        `Set ENCRYPTION_KEY_V${CURRENT_VERSION} environment variable.`,
    );
  }

  // Temporarily set ENCRYPTION_KEY for the base encryptSecret function
  const originalKey = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = currentKey.key;

  try {
    const ciphertext = await encryptSecret(plaintext);

    // Prepend version to ciphertext
    return `v${CURRENT_VERSION}:${ciphertext}`;
  } finally {
    // Restore original key
    if (originalKey) {
      process.env.ENCRYPTION_KEY = originalKey;
    } else {
      delete process.env.ENCRYPTION_KEY;
    }
  }
}

/**
 * Decrypt a secret, auto-detecting the key version
 *
 * @param versionedCiphertext - Ciphertext with version prefix (or legacy without prefix)
 * @returns Decrypted plaintext
 */
export async function decryptSecretVersioned(
  versionedCiphertext: string,
): Promise<string> {
  const keys = getAvailableKeys();

  if (keys.length === 0) {
    throw new Error(
      "No encryption keys configured. Set ENCRYPTION_KEY or ENCRYPTION_KEY_V{N} environment variables.",
    );
  }

  // Parse version from ciphertext
  const versionMatch = versionedCiphertext.match(/^v(\d+):(.+)$/);

  if (!versionMatch) {
    // Legacy format (no version prefix) - try version 1 first, then fallback to current
    const attemptVersions = [1, CURRENT_VERSION].filter(
      (v, i, arr) => arr.indexOf(v) === i,
    );

    for (const version of attemptVersions) {
      const keyConfig = keys.find((k) => k.version === version);
      if (!keyConfig) continue;

      try {
        const originalKey = process.env.ENCRYPTION_KEY;
        process.env.ENCRYPTION_KEY = keyConfig.key;

        try {
          const plaintext = await decryptSecret(versionedCiphertext);
          return plaintext;
        } finally {
          if (originalKey) {
            process.env.ENCRYPTION_KEY = originalKey;
          } else {
            delete process.env.ENCRYPTION_KEY;
          }
        }
      } catch {
        // Try next version
        continue;
      }
    }

    throw new Error(
      "Failed to decrypt secret with legacy format. " +
        "The encryption key may have changed or the data is corrupted.",
    );
  }

  const version = parseInt(versionMatch[1], 10);
  const ciphertext = versionMatch[2];

  const keyConfig = keys.find((k) => k.version === version);

  if (!keyConfig) {
    throw new Error(
      `Encryption key version ${version} not available. ` +
        `Set ENCRYPTION_KEY_V${version} environment variable. ` +
        `Available versions: ${keys.map((k) => k.version).join(", ")}`,
    );
  }

  const originalKey = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = keyConfig.key;

  try {
    return await decryptSecret(ciphertext);
  } catch (err: unknown) {
    throw new Error(
      `Failed to decrypt secret with version ${version} key. ` +
        `The ENCRYPTION_KEY_V${version} may be incorrect.`,
      { cause: err },
    );
  } finally {
    if (originalKey) {
      process.env.ENCRYPTION_KEY = originalKey;
    } else {
      delete process.env.ENCRYPTION_KEY;
    }
  }
}

/**
 * Get the version of an encrypted value
 *
 * @param versionedCiphertext - Ciphertext (with or without version prefix)
 * @returns Version number, or 1 if legacy format
 */
export function getEncryptionVersion(versionedCiphertext: string): number {
  const match = versionedCiphertext.match(/^v(\d+):/);
  return match ? parseInt(match[1], 10) : 1; // Legacy = v1
}

/**
 * Check if a ciphertext needs migration to current version
 *
 * @param versionedCiphertext - Ciphertext to check
 * @returns True if migration is needed
 */
export function needsMigration(versionedCiphertext: string): boolean {
  return getEncryptionVersion(versionedCiphertext) < CURRENT_VERSION;
}
