/**
 * Versioned encryption - supports multiple encryption keys simultaneously
 *
 * Benefits:
 * - Zero-downtime key rotation
 * - Graceful migration from old to new keys
 * - No user impact during key changes
 *
 * Usage:
 *   // Encrypting (always uses current key)
 *   const encrypted = await encryptSecretVersioned("my-secret");
 *   // Result: "current:base64ciphertext..."
 *
 *   // Decrypting (auto-detects key)
 *   const plaintext = await decryptSecretVersioned(encrypted);
 *
 * Environment Variables:
 *   ENCRYPTION_KEY_PREVIOUS=<key>  (optional, old key for decryption during rotation)
 *   ENCRYPTION_KEY_CURRENT=<key>   (required, active key for new encryptions)
 *   ENCRYPTION_KEY_NEXT=<key>      (optional, for gradual rollout before making it current)
 *
 * Key Rotation Process:
 *   1. Set ENCRYPTION_KEY_NEXT in production (keep CURRENT active)
 *   2. Deploy (new encryptions still use CURRENT, but NEXT is ready)
 *   3. Rename: CURRENT → PREVIOUS, NEXT → CURRENT
 *   4. Lazy migration automatically re-encrypts PREVIOUS → CURRENT on access
 *   5. Once migration complete, remove ENCRYPTION_KEY_PREVIOUS
 */

import { encryptSecret, decryptSecret } from "./encryption";

interface EncryptionKeyConfig {
  label: string;
  key: string;
}

/**
 * Define available encryption keys
 * Keys are loaded from environment variables
 */
function getAvailableKeys(): EncryptionKeyConfig[] {
  const keys: EncryptionKeyConfig[] = [];

  // Previous key (for backward compatibility during rotation)
  if (process.env.ENCRYPTION_KEY_PREVIOUS) {
    keys.push({ label: "previous", key: process.env.ENCRYPTION_KEY_PREVIOUS });
  }

  // Current key (active for new encryptions)
  if (process.env.ENCRYPTION_KEY_CURRENT) {
    keys.push({ label: "current", key: process.env.ENCRYPTION_KEY_CURRENT });
  }

  // Next key (for gradual rollout before making it current)
  if (process.env.ENCRYPTION_KEY_NEXT) {
    keys.push({ label: "next", key: process.env.ENCRYPTION_KEY_NEXT });
  }

  return keys;
}

/**
 * Current encryption key label
 */
const CURRENT_KEY_LABEL = "current";

/**
 * Encrypt a secret with the current encryption key
 *
 * @param plaintext - The secret to encrypt
 * @returns Labeled ciphertext (format: "{label}:{base64}")
 */
export async function encryptSecretVersioned(
  plaintext: string,
): Promise<string> {
  const keys = getAvailableKeys();
  const currentKey = keys.find((k) => k.label === CURRENT_KEY_LABEL);

  if (!currentKey) {
    throw new Error(
      `Encryption key "${CURRENT_KEY_LABEL}" not configured. ` +
        `Set ENCRYPTION_KEY_CURRENT environment variable.`,
    );
  }

  const ciphertext = await encryptSecret(plaintext, currentKey.key);
  return `${CURRENT_KEY_LABEL}:${ciphertext}`;
}

/**
 * Decrypt a secret, auto-detecting the key label
 *
 * @param versionedCiphertext - Ciphertext with label prefix (or legacy without prefix)
 * @returns Decrypted plaintext
 */
export async function decryptSecretVersioned(
  versionedCiphertext: string,
): Promise<string> {
  const keys = getAvailableKeys();

  if (keys.length === 0) {
    throw new Error(
      "No encryption keys configured. Set ENCRYPTION_KEY_CURRENT, ENCRYPTION_KEY_PREVIOUS, or ENCRYPTION_KEY_NEXT.",
    );
  }

  // Parse label from ciphertext
  const labelMatch = versionedCiphertext.match(
    /^(previous|current|next):(.+)$/,
  );

  if (!labelMatch) {
    // Legacy format (no label prefix) - try all keys in priority order
    const attemptOrder = ["current", "previous", "next"];

    for (const label of attemptOrder) {
      const keyConfig = keys.find((k) => k.label === label);
      if (!keyConfig) continue;

      try {
        return await decryptSecret(versionedCiphertext, keyConfig.key);
      } catch {
        // Try next key
        continue;
      }
    }

    throw new Error(
      "Failed to decrypt secret with legacy format. " +
        "The encryption key may have changed or the data is corrupted.",
    );
  }

  const label = labelMatch[1];
  const ciphertext = labelMatch[2];

  const keyConfig = keys.find((k) => k.label === label);

  if (!keyConfig) {
    throw new Error(
      `Encryption key "${label}" not available. ` +
        `Set ENCRYPTION_KEY_${label.toUpperCase()} environment variable. ` +
        `Available keys: ${keys.map((k) => k.label).join(", ")}`,
    );
  }

  try {
    return await decryptSecret(ciphertext, keyConfig.key);
  } catch (err: unknown) {
    throw new Error(
      `Failed to decrypt secret with "${label}" key. ` +
        `The ENCRYPTION_KEY_${label.toUpperCase()} may be incorrect.`,
      { cause: err },
    );
  }
}

/**
 * Get the label of an encrypted value
 *
 * @param versionedCiphertext - Ciphertext (with or without label prefix)
 * @returns Label string, or "previous" if legacy format
 */
export function getEncryptionVersion(versionedCiphertext: string): string {
  const match = versionedCiphertext.match(/^(previous|current|next):/);
  return match ? match[1] : "previous"; // Legacy = previous
}

/**
 * Check if a ciphertext needs migration to current key
 *
 * @param versionedCiphertext - Ciphertext to check
 * @returns True if migration is needed
 */
export function needsMigration(versionedCiphertext: string): boolean {
  return getEncryptionVersion(versionedCiphertext) !== CURRENT_KEY_LABEL;
}
