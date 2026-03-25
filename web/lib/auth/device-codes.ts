import { randomBytes } from "node:crypto";

/**
 * Safe character set for user-facing codes (31 chars).
 * Excludes ambiguous characters: 0/O, 1/I/L
 */
export const SAFE_CHARSET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/**
 * Generate a human-readable user code in XXXX-XXXX format.
 * Uses 8 characters from SAFE_CHARSET (~39 bits of entropy).
 */
export function generateUserCode(): string {
  const bytes = randomBytes(8);
  let code = "";
  for (let i = 0; i < 8; i++) {
    // Slight modulo bias (256 % 31 != 0) — acceptable for short-lived user codes
    code += SAFE_CHARSET[bytes[i] % SAFE_CHARSET.length];
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * Generate a cryptographic device code (256-bit hex string).
 * This is the polling secret — never displayed to users.
 */
export function generateDeviceCode(): string {
  return randomBytes(32).toString("hex");
}
