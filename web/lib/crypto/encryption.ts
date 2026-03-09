/**
 * Encryption utilities for S3 credentials
 * Uses AES-256-GCM encryption, compatible with Edge Function implementation
 */

export async function encryptSecret(plaintext: string): Promise<string> {
  const encryptionKey = process.env.ENCRYPTION_KEY;
  if (!encryptionKey) {
    throw new Error("ENCRYPTION_KEY environment variable not set");
  }

  const encoder = new TextEncoder();
  const data = encoder.encode(plaintext);
  const keyData = encoder.encode(encryptionKey);

  // Derive 256-bit key using SHA-256
  const keyBytes = await crypto.subtle.digest("SHA-256", keyData);

  // Import key for AES-GCM
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"]
  );

  // Generate random IV (12 bytes for GCM)
  const iv = crypto.getRandomValues(new Uint8Array(12));

  // Encrypt
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    data
  );

  // Combine IV + ciphertext and encode as base64
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), iv.length);

  return Buffer.from(combined).toString("base64");
}

export async function decryptSecret(ciphertext: string): Promise<string> {
  const encryptionKey = process.env.ENCRYPTION_KEY;
  if (!encryptionKey) {
    throw new Error("ENCRYPTION_KEY environment variable not set");
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const keyData = encoder.encode(encryptionKey);

  // Derive 256-bit key using SHA-256
  const keyBytes = await crypto.subtle.digest("SHA-256", keyData);

  // Import key for AES-GCM
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );

  // Decode base64
  const combined = Buffer.from(ciphertext, "base64");

  // Extract IV and ciphertext
  const iv = combined.slice(0, 12);
  const encrypted = combined.slice(12);

  // Decrypt
  let decrypted: ArrayBuffer;
  try {
    decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      encrypted
    );
  } catch (err) {
    throw new Error(
      "Failed to decrypt secret — the ENCRYPTION_KEY may have changed or the data was encrypted with a different key",
      { cause: err }
    );
  }

  return decoder.decode(decrypted);
}
