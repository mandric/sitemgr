# Code Review: Section 01 -- Eliminate process.env.ENCRYPTION_KEY Race Condition

## Summary

This diff refactors `encryption.ts` to accept the encryption key as an explicit function parameter instead of reading `process.env.ENCRYPTION_KEY` at call time. The versioned layer (`encryption-versioned.ts`) previously mutated `process.env.ENCRYPTION_KEY` in a save/restore pattern around each call, creating a concurrency race condition when multiple encrypt/decrypt operations ran in parallel (e.g., via `Promise.all`). The fix passes the key directly, eliminating all process.env mutation.

**Files changed:** 4 (2 library, 2 test)

The refactor is clean, well-scoped, and correct. All call sites within the diff are updated, and no remaining references to the bare `process.env.ENCRYPTION_KEY` exist in the `web/` source tree.

## Findings

### Critical (must fix)

None.

### Important (should fix)

1. **Deno edge function tests still use bare `ENCRYPTION_KEY` pattern.**
   `tests/edge_function_bucket_test.ts` (line 9) and `tests/edge_function_scan_test.ts` read `Deno.env.get("ENCRYPTION_KEY")` and define their own standalone `encryptSecret()` that closes over that value. While these are self-contained Deno test helpers (not importing the refactored module), they represent a divergent copy of the encryption logic. If these tests are kept, they should be updated to use `ENCRYPTION_KEY_CURRENT` for naming consistency with the project convention documented in CLAUDE.md ("DO NOT USE: ENCRYPTION_KEY"). This is not a runtime bug but a hygiene/consistency issue that could cause confusion during key rotation.

2. **Mock in `s3-actions.test.ts` still mocks `@/lib/crypto/encryption` with the old zero-arg signature.**
   Lines 38-41 of `web/__tests__/s3-actions.test.ts` mock `encryptSecret` and `decryptSecret` as zero-arg stubs (`vi.fn().mockResolvedValue(...)`). Because `vi.fn()` ignores extra arguments by default, the mock works today. However, the mock signature is misleading -- it obscures the fact that callers should now be providing a key argument. If anyone writes a new test that checks `.toHaveBeenCalledWith(...)` on these mocks, the missing second argument would be confusing. Consider updating the mocks to accept the expected parameters:
   ```ts
   encryptSecret: vi.fn().mockImplementation((_plaintext: string, _key: string) => Promise.resolve("encrypted")),
   ```

3. **No test for `decryptSecret` with empty key.**
   The test file covers `encryptSecret("test", "")` throwing `"Encryption key must be provided"`, but there is no corresponding test for `decryptSecret("ciphertext", "")`. The guard exists in production code (line 7-8 of `encryption.ts` for encrypt, line 46-48 for decrypt), but only encrypt is tested. Add a symmetric test for decrypt.

### Minor (nice to have)

1. **Sentinel tests use `delete process.env.ENCRYPTION_KEY` for cleanup.**
   In the new "no longer mutates process.env.ENCRYPTION_KEY" test block (lines 73-92 of the diff), the tests set `process.env.ENCRYPTION_KEY = sentinel` and clean up with `delete process.env.ENCRYPTION_KEY`. This works, but using vitest's `vi.stubEnv` / `vi.unstubAllEnvs` would be more idiomatic and consistent with the rest of the test file. If a test fails before reaching the `delete` line, the sentinel value leaks into subsequent tests.

2. **Error message regex in "wrong key" test is loose.**
   The test at diff line 188 uses `/key may have changed|different key/` to match the error. The production error message is a single known string: `"Failed to decrypt secret -- the encryption key may have changed or the data was encrypted with a different key"`. A more specific regex (or `toThrow("encryption key may have changed")`) would catch unintended message changes.

3. **Variable shadowing: `key` renamed to `cryptoKey` is good.**
   The rename from the parameter-shadowing `key` (which collided with the function parameter name `key`) to `cryptoKey` for the `CryptoKey` object is a welcome clarity improvement. No action needed, just noting it was well done.

4. **Consider adding a concurrency test at the versioned layer too.**
   The new concurrency test (two concurrent encrypts with different keys) exists in `encryption.test.ts`, which validates the base module. A similar test in `encryption-versioned.test.ts` -- running `encryptSecretVersioned` and `decryptSecretVersioned` concurrently with different env key configurations -- would further prove the race condition is resolved end-to-end. This is lower priority since the versioned layer no longer does any env mutation.

## Verdict

**Approve with minor suggestions.** The core refactor is correct and eliminates the race condition cleanly. The function signatures are now pure (key as parameter, no side effects), the versioned layer passes keys through without mutation, and all `web/` call sites are updated. The important findings (Deno test naming inconsistency, mock signature hygiene, missing decrypt-empty-key test) are non-blocking but should be addressed in a follow-up.
