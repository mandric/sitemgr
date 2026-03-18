Now I have all the context needed. Let me produce the section content.

# Section 05: Encryption Tests

## Overview

This section adds a comprehensive encryption test suite covering key rotation end-to-end flows, legacy format migration, edge cases, and `encryption_key_version` column reconciliation. It depends on section-01 (encryption-fix), which refactors `encryption.ts` to accept the key as a parameter rather than reading `process.env.ENCRYPTION_KEY` internally.

**Dependency:** section-01-encryption-fix must be completed first. After that fix, `encryptSecret(plaintext, key)` and `decryptSecret(ciphertext, key)` accept an explicit key parameter, and `encryption-versioned.ts` passes keys directly instead of mutating `process.env.ENCRYPTION_KEY`.

## File Locations

All test files live under `/home/user/sitemgr/web/__tests__/`:

| File | Purpose |
|------|---------|
| `encryption-rotation.test.ts` | **New.** Key rotation end-to-end lifecycle tests |
| `encryption-versioned.test.ts` | **Modify.** Add legacy format and edge case tests to existing file |
| `encryption.test.ts` | **Modify.** Add post-fix concurrency and large-plaintext tests |

Source files under test (read-only for this section -- modified by section-01):

- `/home/user/sitemgr/web/lib/crypto/encryption.ts`
- `/home/user/sitemgr/web/lib/crypto/encryption-versioned.ts`

Migration file (read-only for this section):

- `/home/user/sitemgr/supabase/migrations/20260312000000_add_encryption_key_version.sql`

## Background: Encryption Architecture

The encryption system has two layers:

1. **Base layer** (`encryption.ts`): AES-256-GCM encrypt/decrypt using Web Crypto API. After the section-01 fix, these functions accept the key as an explicit parameter rather than reading from `process.env.ENCRYPTION_KEY`.

2. **Versioned layer** (`encryption-versioned.ts`): Wraps the base layer with label-prefixed ciphertext (`current:base64...`, `previous:base64...`) and key resolution from environment variables (`ENCRYPTION_KEY_CURRENT`, `ENCRYPTION_KEY_PREVIOUS`, `ENCRYPTION_KEY_NEXT`).

Key facts:
- Ciphertext format: 12-byte random IV prepended to AES-GCM ciphertext, then base64-encoded
- Label prefix: `{label}:` prepended by the versioned layer (e.g., `current:SGVsbG8...`)
- Legacy format: base64 ciphertext with no label prefix, assumed to be "previous" era
- `needsMigration(ciphertext)` returns `true` if the label is anything other than `"current"`
- `getEncryptionVersion(ciphertext)` returns the label string, or `"previous"` for legacy format
- `bucket_configs.encryption_key_version` (integer column) is a DB-level audit trail, separate from the runtime label prefix mechanism

## Tests

All tests use Vitest with `vi.stubEnv()` for fixture keys. No real secrets are needed.

### Test File 1: `encryption-rotation.test.ts` (New)

Create `/home/user/sitemgr/web/__tests__/encryption-rotation.test.ts`.

This file tests the full key rotation lifecycle. The core scenario is:

1. Encrypt data with key A as "current"
2. Rotate: key A becomes "previous", key B becomes "current"
3. Decrypt old data -- verifies it still works via "previous" key
4. Lazy migration: re-encrypt the decrypted data with the new "current" key
5. Verify re-encrypted data decrypts with key B
6. Remove "previous" key (A) entirely
7. Verify all data still accessible

```
# Test: encrypt with key A, rotate to key B, decrypt old data succeeds via "previous"
# Test: lazy migration re-encrypts data from key A to key B
# Test: after migration, data decrypts with key B only
# Test: removing "previous" key after full migration doesn't break access
# Test: full rotation lifecycle (A->B) preserves all data
```

Test structure (stubs):

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  encryptSecretVersioned,
  decryptSecretVersioned,
  getEncryptionVersion,
  needsMigration,
} from "@/lib/crypto/encryption-versioned";

describe("key rotation end-to-end", () => {
  const KEY_A = "rotation-test-key-alpha-aaaaaa";
  const KEY_B = "rotation-test-key-bravo-bbbbbb";

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("full rotation lifecycle A -> B preserves all data", async () => {
    // Phase 1: encrypt with A as current
    // Phase 2: rotate (A=previous, B=current)
    // Phase 3: decrypt old data (uses previous key A)
    // Phase 4: re-encrypt with B (lazy migration)
    // Phase 5: verify migrated data has "current" label
    // Phase 6: remove previous key, verify still accessible
  });

  it("decrypt old data succeeds via previous key after rotation", async () => {
    // Encrypt with A as current, then swap keys, decrypt should succeed
  });

  it("lazy migration re-encrypts from key A to key B", async () => {
    // Encrypt with A, rotate, decrypt, re-encrypt, verify new label is "current"
    // Verify the re-encrypted ciphertext is different from original
  });

  it("after migration data decrypts with key B only", async () => {
    // After re-encryption, remove key A, decrypt should still work
  });

  it("removing previous key after full migration does not break access", async () => {
    // Complete the full lifecycle, unset ENCRYPTION_KEY_PREVIOUS, decrypt migrated data
  });
});
```

### Test File 2: Additions to `encryption-versioned.test.ts` (Modify)

Add the following test groups to the existing file at `/home/user/sitemgr/web/__tests__/encryption-versioned.test.ts`.

#### Legacy Format Migration Tests

```
# Test: ciphertext without label prefix decrypts using "previous" key assumption
# Test: needsMigration() returns true for legacy format ciphertext
# Test: re-encrypting legacy ciphertext produces "current:" prefixed format
# Test: legacy format tried with current key first, then previous, then next
```

The existing file already has a test for decrypting legacy data (the "decrypts legacy v1 data" test) and a roundtrip migration scenario. Add these additional cases:

```typescript
describe("legacy format migration", () => {
  it("legacy format is tried with current key first, then previous, then next", async () => {
    // Encrypt with KEY_NEXT (via base encryption), then set up env with all three keys
    // Verify decryptSecretVersioned succeeds by trying keys in priority order
    // This confirms the try-order: current -> previous -> next
  });

  it("re-encrypting legacy ciphertext produces current:-prefixed format", async () => {
    // Create legacy ciphertext (no prefix), decrypt it, re-encrypt
    // Verify result starts with "current:"
  });
});
```

#### Edge Case Tests

```
# Test: missing ENCRYPTION_KEY_CURRENT throws clear error message
# Test: corrupted ciphertext throws actionable error with diagnostic info
# Test: empty string encrypts and decrypts to empty string
# Test: 10KB plaintext encrypts and decrypts without truncation
# Test: concurrent encrypt/decrypt calls don't interfere (post-fix)
```

The existing file already covers empty string, unicode, and long (1000 char) strings. Add these:

```typescript
describe("edge cases (extended)", () => {
  it("10KB plaintext encrypts and decrypts without truncation", async () => {
    const plaintext = "A".repeat(10 * 1024);
    // encrypt, decrypt, verify length and content match exactly
  });

  it("corrupted ciphertext throws actionable error with diagnostic info", async () => {
    const corrupted = "current:not-valid-base64-!!!@@@";
    // Should throw with message indicating the "current" key or data corruption
  });

  it("concurrent encrypt/decrypt calls don't interfere (post-fix)", async () => {
    // Launch multiple concurrent encrypt operations with the same key
    // Verify all produce valid ciphertext that decrypts correctly
    // This validates the section-01 fix eliminated the process.env race
    const plaintexts = Array.from({ length: 20 }, (_, i) => `secret-${i}`);
    // Promise.all encrypt, then Promise.all decrypt, verify each matches
  });
});
```

### Test File 3: Additions to `encryption.test.ts` (Modify)

Add to the existing file at `/home/user/sitemgr/web/__tests__/encryption.test.ts`.

After section-01, the base `encryptSecret` and `decryptSecret` accept a key parameter. Add tests for the new signature:

```
# Test: encryptSecret accepts key parameter and encrypts correctly
# Test: decryptSecret accepts key parameter and decrypts correctly
# Test: two concurrent encryptSecret calls with different keys produce correct ciphertext
```

```typescript
describe("explicit key parameter (post-fix)", () => {
  it("encryptSecret accepts key parameter and encrypts correctly", async () => {
    // Call encryptSecret("plaintext", "explicit-key") without setting process.env
    // Verify it returns valid base64 ciphertext
  });

  it("decryptSecret accepts key parameter and decrypts correctly", async () => {
    // Encrypt with explicit key, then decrypt with same explicit key
    // Verify roundtrip
  });

  it("two concurrent calls with different keys produce correct ciphertext", async () => {
    // Encrypt "data-a" with key-a and "data-b" with key-b concurrently
    // Decrypt each with its respective key
    // Verify data-a decrypts correctly with key-a and data-b with key-b
    // This is the core concurrency regression test for the process.env fix
  });
});
```

### Test Group 4: `encryption_key_version` Reconciliation

Add to `encryption-versioned.test.ts`:

```
# Test: encryption_key_version column value matches label prefix for "current"
# Test: needsMigration() result aligns with encryption_key_version check
```

These are unit-level tests that verify the relationship between the integer column and label prefix system. They do not hit the database.

```typescript
describe("encryption_key_version reconciliation", () => {
  it("encryption_key_version column value matches label prefix for current", () => {
    // The DB column encryption_key_version defaults to 1.
    // When data is encrypted with the "current" key, getEncryptionVersion returns "current".
    // Document: the column is an audit trail. Version 1 = original key era.
    // After rotation, application code should update the column to 2.
    // Verify getEncryptionVersion("current:xxx") returns "current"
    // This is a design-level assertion, not crypto-functional.
  });

  it("needsMigration result aligns with encryption_key_version check", () => {
    // If encryption_key_version == latest version number, needsMigration should return false.
    // If encryption_key_version < latest, needsMigration should return true.
    // Since the column is integer and the prefix is string, the reconciliation
    // is application-level: version 1 -> "previous" label era, version 2+ -> "current".
    // Verify needsMigration("current:xxx") === false
    // Verify needsMigration("previous:xxx") === true
    // Verify needsMigration("plainbase64nolabel") === true
  });
});
```

## Implementation Notes

### What to implement

1. **Create** `/home/user/sitemgr/web/__tests__/encryption-rotation.test.ts` with the full rotation lifecycle tests described above. Each test should exercise the versioned encryption API by swapping `vi.stubEnv()` values between phases to simulate key rotation.

2. **Add** the legacy format, edge case, and reconciliation test groups to `/home/user/sitemgr/web/__tests__/encryption-versioned.test.ts`. Integrate into the existing describe tree.

3. **Add** the explicit-key-parameter tests to `/home/user/sitemgr/web/__tests__/encryption.test.ts`. These tests validate the section-01 refactored API and must use the new function signatures (`encryptSecret(plaintext, key)` instead of relying on `process.env.ENCRYPTION_KEY`).

### Testing conventions

- Use `vi.stubEnv()` and `vi.unstubAllEnvs()` for all environment variable manipulation. Never set `process.env` directly.
- Use `beforeEach`/`afterEach` (not `beforeAll`/`afterAll`) for env stubs so tests are isolated.
- Follow existing patterns in the test files (import paths use `@/lib/crypto/...`, use `describe`/`it` nesting).
- Fixture key values should be descriptive strings (e.g., `"rotation-test-key-alpha-aaaaaa"`) -- they do not need to be cryptographically strong since the SHA-256 derivation in `encryption.ts` handles key stretching.

### Concurrency test details

The concurrency test is the most important regression test for the section-01 fix. The test should:

1. Create an array of 20 plaintext values
2. Use `Promise.all` to encrypt all 20 concurrently
3. Use `Promise.all` to decrypt all 20 concurrently
4. Assert each decrypted value matches its original plaintext

For the two-key variant (in `encryption.test.ts`), encrypt half with key-a and half with key-b in a single `Promise.all`, then decrypt each with its respective key.

### What NOT to implement

- Do not modify the encryption source files (`encryption.ts`, `encryption-versioned.ts`) -- that is section-01's scope.
- Do not write database integration tests for `encryption_key_version` -- the reconciliation tests are unit-level assertions about the design relationship between the column and the label prefix system.
- Do not test the `encryption-lifecycle.test.ts` file (the agent/bucket integration test) -- that file already exists and covers its scope independently.