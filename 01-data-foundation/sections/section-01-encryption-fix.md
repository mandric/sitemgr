Now I have all the context needed. Let me produce the section content.

# Section 01: Encryption Fix — Refactor `encryption.ts` to Accept Key as Parameter

## Background

The base encryption module at `/home/user/sitemgr/web/lib/crypto/encryption.ts` reads `process.env.ENCRYPTION_KEY` internally on every call. The versioned wrapper at `/home/user/sitemgr/web/lib/crypto/encryption-versioned.ts` mutates `process.env.ENCRYPTION_KEY` as a side-channel to pass the correct key to the base module, then restores it in a `finally` block.

This pattern is a **data corruption bug** in any concurrent environment (Vercel serverless, Next.js API routes). Between the `process.env.ENCRYPTION_KEY = key` assignment and the `await encryptSecret()` call, another async operation can overwrite the value. The `try/finally` does not protect against async interleaving. The result: ciphertext labeled `current:` but actually encrypted with a different request's key, causing silent data corruption that surfaces as decryption failures later.

## Dependencies

None. This section has no prerequisites and can be implemented immediately. It blocks section-05 (encryption tests).

## Files to Modify

- `/home/user/sitemgr/web/lib/crypto/encryption.ts` — Change function signatures to accept `key: string` parameter
- `/home/user/sitemgr/web/lib/crypto/encryption-versioned.ts` — Pass resolved key directly instead of mutating `process.env`
- `/home/user/sitemgr/web/__tests__/encryption.test.ts` — Update tests for new signatures
- `/home/user/sitemgr/web/__tests__/encryption-versioned.test.ts` — Update tests, remove `process.env.ENCRYPTION_KEY` stubs
- `/home/user/sitemgr/web/__tests__/encryption-lifecycle.test.ts` — No changes expected (uses versioned API which keeps its signature)

## Tests (Write First)

### Test file: `/home/user/sitemgr/web/__tests__/encryption.test.ts`

Rewrite the existing test file. The key change is that `encryptSecret` and `decryptSecret` now require an explicit `key` parameter instead of reading `process.env.ENCRYPTION_KEY`. Remove all `vi.stubEnv("ENCRYPTION_KEY", ...)` calls. Pass the key directly.

Tests to include:

```
# Test: encryptSecret accepts key parameter and encrypts correctly
#   - Call encryptSecret("my-secret", TEST_KEY), verify it returns a base64 string
#   - Decrypt with decryptSecret(ciphertext, TEST_KEY), verify roundtrip

# Test: decryptSecret accepts key parameter and decrypts correctly
#   - Encrypt then decrypt, verify plaintext matches

# Test: two concurrent encryptSecret calls with different keys produce correct ciphertext
#   - Launch two encrypt calls in parallel with different keys (key_A, key_B)
#   - Await both, then decrypt each with its respective key
#   - Verify each decrypts to the correct plaintext
#   - This is THE concurrency regression test

# Test: encryptSecret throws when key is empty string
#   - Call encryptSecret("data", ""), expect a clear error

# Test: decryptSecret with wrong key gives actionable error
#   - Encrypt with key A, decrypt with key B, expect error matching /key may have changed|different key/

# Test: handles empty plaintext
# Test: handles unicode
# Test: produces different ciphertexts for same plaintext (random IV)
```

### Test file: `/home/user/sitemgr/web/__tests__/encryption-versioned.test.ts`

The versioned module's public API (`encryptSecretVersioned`, `decryptSecretVersioned`, etc.) does NOT change its signature. But the tests must be updated to:

1. Remove all `vi.stubEnv("ENCRYPTION_KEY", ...)` lines (the base module no longer reads this).
2. Keep `vi.stubEnv("ENCRYPTION_KEY_CURRENT", ...)` and `vi.stubEnv("ENCRYPTION_KEY_PREVIOUS", ...)` since the versioned module still reads those.
3. Remove any `await import("@/lib/crypto/encryption")` dynamic imports that were used to get the base `encryptSecret` for creating legacy ciphertext. Instead, import `encryptSecret` directly and call it with the key parameter to create test fixtures.

Add a new test:

```
# Test: encryption-versioned.ts no longer mutates process.env.ENCRYPTION_KEY
#   - Set process.env.ENCRYPTION_KEY to a sentinel value before calling encryptSecretVersioned
#   - After the call completes, verify process.env.ENCRYPTION_KEY is unchanged
#   - This confirms the race condition fix
```

## Implementation Details

### Step 1: Refactor `encryption.ts`

Change both function signatures to accept the key as a required parameter. Remove all `process.env.ENCRYPTION_KEY` reads.

Before:
```typescript
export async function encryptSecret(plaintext: string): Promise<string>
export async function decryptSecret(ciphertext: string): Promise<string>
```

After:
```typescript
export async function encryptSecret(plaintext: string, key: string): Promise<string>
export async function decryptSecret(ciphertext: string, key: string): Promise<string>
```

Inside each function:
- Remove the `const encryptionKey = process.env.ENCRYPTION_KEY` line and the guard clause that throws when it is unset.
- Use the `key` parameter where `encryptionKey` was previously used (passed to `encoder.encode(key)` for SHA-256 derivation).
- Add a guard for empty/falsy `key` parameter: throw `new Error("Encryption key must be provided")` or similar.
- All other logic (AES-GCM, IV generation, base64 encoding) remains identical.

### Step 2: Refactor `encryption-versioned.ts`

Remove the `process.env.ENCRYPTION_KEY` mutation pattern. In all three locations where the pattern appears (once in `encryptSecretVersioned`, twice in `decryptSecretVersioned`), replace:

```typescript
// REMOVE this pattern entirely:
const originalKey = process.env.ENCRYPTION_KEY;
process.env.ENCRYPTION_KEY = keyConfig.key;
try {
  const result = await encryptSecret(plaintext);
  ...
} finally {
  if (originalKey) {
    process.env.ENCRYPTION_KEY = originalKey;
  } else {
    delete process.env.ENCRYPTION_KEY;
  }
}
```

With direct parameter passing:

```typescript
// REPLACE with:
const result = await encryptSecret(plaintext, keyConfig.key);
```

The same change applies to all `decryptSecret` calls — pass `keyConfig.key` as the second argument.

This eliminates all `process.env.ENCRYPTION_KEY` references from `encryption-versioned.ts`. The module still reads `ENCRYPTION_KEY_CURRENT`, `ENCRYPTION_KEY_PREVIOUS`, and `ENCRYPTION_KEY_NEXT` via `getAvailableKeys()` — that is correct and unchanged.

### Step 3: Verify No Other Direct Callers

The base `encryptSecret`/`decryptSecret` from `encryption.ts` should only be imported by `encryption-versioned.ts`. All application code uses the versioned wrappers. Confirm by checking imports:

- `/home/user/sitemgr/web/lib/agent/core.ts` — imports from `encryption-versioned` (no change needed)
- `/home/user/sitemgr/web/components/buckets/actions.ts` — imports from `encryption-versioned` (no change needed)
- `/home/user/sitemgr/web/__tests__/encryption.test.ts` — imports base module directly (update tests)
- `/home/user/sitemgr/web/__tests__/encryption-versioned.test.ts` — dynamically imports base module for fixture creation (update tests)
- `/home/user/sitemgr/web/__tests__/s3-actions.test.ts` — imports from `encryption-versioned` via mock (no change needed)
- `/home/user/sitemgr/tests/edge_function_bucket_test.ts` and `edge_function_scan_test.ts` — check if these import the base module; if so, update the call sites.

### Step 4: Update Lifecycle Tests

`/home/user/sitemgr/web/__tests__/encryption-lifecycle.test.ts` does not mock encryption (comment on line 42: "encryption is NOT mocked — we use the real implementation"). It calls `executeAction` which internally calls the versioned API. Since the versioned API signature is unchanged, this test file should pass without modification. Verify this by running the test suite after the refactor.

## Verification

After implementation, run:
- `npx vitest run web/__tests__/encryption.test.ts` — base module tests
- `npx vitest run web/__tests__/encryption-versioned.test.ts` — versioned wrapper tests
- `npx vitest run web/__tests__/encryption-lifecycle.test.ts` — integration lifecycle tests
- `npx vitest run web/__tests__/s3-actions.test.ts` — S3 actions that use encryption

All must pass. The concurrency test (two parallel encrypts with different keys) is the critical regression test that would have failed before this fix and must pass after.