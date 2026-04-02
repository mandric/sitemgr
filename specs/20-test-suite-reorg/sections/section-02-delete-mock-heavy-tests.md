Good -- some files mentioned in the plan don't exist on disk. Now I have full context. Here is the section content:

# Section 2: Delete Mock-Heavy Unit Tests

## Overview

This section removes ~15 mock-heavy unit test files whose code paths are now covered by the integration tests written in Section 1, plus existing integration tests (media-storage, device-auth, webhook-service-account, etc.). It also splits `device-approve-form.test.ts` to keep its pure-logic tests while removing mock-fetch tests, and deletes the shared mock helper `agent-test-setup.ts`.

**Dependency:** Section 1 (API route integration tests) must be complete and passing before this section begins. The integration tests provide the replacement coverage that justifies deleting these mock-heavy files.

## Pre-Deletion Verification

Before deleting any file, confirm that its code paths have equivalent or better coverage from integration tests. This is a manual review step, not automated.

### Verification checklist

Run each verification mentally or by grepping the integration test files:

```
# Verify: encryption-rotation.test.ts covers the same rotation scenarios as encryption-lifecycle.test.ts
# Verify: api-health-route.test.ts covers what health-route.test.ts tested
# Verify: api-bucket-routes.test.ts + api-events-routes.test.ts cover db-operations.test.ts paths
# Verify: media-storage integration test covers s3-actions.test.ts and s3-client.test.ts
# Verify: sitemgr-pipeline (E2E CLI) + api-enrichment-routes.test.ts cover enrichment.test.ts
# Verify: webhook-service-account integration test covers whatsapp-route.test.ts
# Verify: device-auth integration test covers device-approve-route, device-initiate-route, device-token-route
# Verify: remaining unit tests still pass after deletion (npm run test)
# Verify: no unique edge case logic that only the mock test exercised
```

## Files to Delete

All paths are relative to `/home/user/sitemgr/web/`. Absolute paths are provided for clarity.

### Mock-heavy test files (15 files)

| File | Reason for Deletion | Replacement Coverage |
|------|---------------------|---------------------|
| `__tests__/health-route.test.ts` | Mocks health check | `api-health-route.test.ts` (Section 1) |
| `__tests__/db-operations.test.ts` | Mocks Supabase queries | API route integration tests + schema-contract |
| `__tests__/s3-actions.test.ts` | Mocks S3 send/list/put | media-storage integration test |
| `__tests__/agent-core.test.ts` | Mocks entire agent flow | Integration + E2E CLI pipeline |
| `__tests__/agent-actions.test.ts` | Mocks agent action calls | Integration tests |
| `__tests__/enrichment.test.ts` | Mocks enrichment pipeline | E2E pipeline + `api-enrichment-routes.test.ts` |
| `__tests__/whatsapp-route.test.ts` | Mocks webhook handling | webhook-service-account integration test |
| `__tests__/device-approve-route.test.ts` | Mocks device auth | device-auth integration test |
| `__tests__/device-initiate-route.test.ts` | Mocks device auth | device-auth integration test |
| `__tests__/device-token-route.test.ts` | Mocks device auth | device-auth integration test |
| `__tests__/encryption-lifecycle.test.ts` | Mocks Supabase + uses `agent-test-setup` | `encryption-rotation.test.ts` (pure logic, kept) + DB roundtrip in integration |
| `__tests__/s3-client.test.ts` | Mocks `@supabase/supabase-js` createClient | media-storage integration test |
| `__tests__/supabase-client.test.ts` | Mocks `createClient` wiring | Tested indirectly by every integration test |
| `__tests__/instrumentation.test.ts` | Mocks OpenTelemetry | Low value, no replacement needed |
| `__tests__/phone-migration-app.test.ts` | Mocks Supabase for one-time migration | One-time script, not worth maintaining |

### Shared mock helper (1 file)

| File | Reason |
|------|--------|
| `__tests__/helpers/agent-test-setup.ts` | Mock infrastructure (`mockFrom`, `mockS3Send`, `mockBucketLookup`, etc.) used by deleted tests. No longer needed. |

## File to Modify: `device-approve-form.test.ts`

**Path:** `/home/user/sitemgr/web/__tests__/device-approve-form.test.ts`

This file contains two `describe` blocks:

1. **`parseCodeFromUrl`** -- Pure logic tests (string parsing, uppercase normalization, null handling). **Keep these.**
2. **`approveDevice`** -- Mock-fetch tests that spy on `globalThis.fetch` and verify call shapes. **Delete these.**

### After modification, the file should contain only:

```typescript
import { describe, it, expect } from "vitest";
import { parseCodeFromUrl } from "@/components/device-approve-form";

describe("parseCodeFromUrl", () => {
  it("extracts code from ?code=ABCD-1234", () => {
    expect(parseCodeFromUrl("?code=ABCD-1234")).toBe("ABCD-1234");
  });

  it("returns null when no code param", () => {
    expect(parseCodeFromUrl("?other=value")).toBeNull();
  });

  it("normalizes code to uppercase", () => {
    expect(parseCodeFromUrl("?code=abcd-1234")).toBe("ABCD-1234");
  });

  it("returns null for empty string", () => {
    expect(parseCodeFromUrl("")).toBeNull();
  });
});
```

The `vi`, `beforeEach` imports and the entire `describe("approveDevice", ...)` block are removed. The `approveDevice` import is also removed since it is no longer referenced.

## Files to Keep (no changes)

These unit test files are pure logic or light mocking and remain untouched:

- `__tests__/encryption.test.ts` -- Pure AES encryption logic
- `__tests__/encryption-rotation.test.ts` -- Pure key rotation logic with `vi.stubEnv()`
- `__tests__/encryption-versioned.test.ts` -- Pure versioned encryption logic
- `__tests__/validation.test.ts` -- Pure input validation
- `__tests__/retry.test.ts` -- Pure retry logic
- `__tests__/media-utils.test.ts` -- Pure content type detection
- `__tests__/device-codes.test.ts` -- Pure device code logic
- `__tests__/logger.test.ts` -- `vi.spyOn(console)`, tests formatting
- `__tests__/request-context.test.ts` -- AsyncLocalStorage patterns
- `__tests__/sitemgr-cli-auth.test.ts` -- Static analysis of source code

## Files Referenced in Plan but Not on Disk

The following files were mentioned in the implementation plan but do not exist in the repository. No action needed for these:

- `__tests__/cli-open-browser.test.ts`
- `__tests__/sitemgr-login-command.test.ts`
- `__tests__/api-auth.test.ts`
- `__tests__/cli-auth-device-flow.test.ts`

If any of these appear before this section is executed, evaluate them per the plan: delete if mock-heavy with integration coverage, keep if pure logic.

## Implementation Steps

1. **Verify Section 1 is complete.** Run `cd /home/user/sitemgr/web && npm run test:integration` and confirm all new API route integration tests pass.

2. **Run the pre-deletion verification checklist** above. For each file to be deleted, confirm that at least one integration test exercises the same code path.

3. **Delete the 15 mock-heavy test files.** Execute from `/home/user/sitemgr/web`:
   ```
   rm __tests__/health-route.test.ts
   rm __tests__/db-operations.test.ts
   rm __tests__/s3-actions.test.ts
   rm __tests__/agent-core.test.ts
   rm __tests__/agent-actions.test.ts
   rm __tests__/enrichment.test.ts
   rm __tests__/whatsapp-route.test.ts
   rm __tests__/device-approve-route.test.ts
   rm __tests__/device-initiate-route.test.ts
   rm __tests__/device-token-route.test.ts
   rm __tests__/encryption-lifecycle.test.ts
   rm __tests__/s3-client.test.ts
   rm __tests__/supabase-client.test.ts
   rm __tests__/instrumentation.test.ts
   rm __tests__/phone-migration-app.test.ts
   ```

4. **Delete the shared mock helper:**
   ```
   rm __tests__/helpers/agent-test-setup.ts
   ```
   After deletion, check if `__tests__/helpers/` directory is empty. If so, remove it. If other helpers exist (e.g., test utilities used by kept tests), leave the directory.

5. **Modify `device-approve-form.test.ts`.** Remove the `approveDevice` describe block and its imports as described above. Keep only the `parseCodeFromUrl` tests.

6. **Run unit tests to confirm no breakage:**
   ```
   cd /home/user/sitemgr/web && npm run test
   ```
   All remaining unit tests must pass. If any test imports from a deleted file (e.g., `agent-test-setup.ts`), that test was missed in the deletion list -- investigate and fix.

7. **Run typecheck to confirm no dangling imports:**
   ```
   cd /home/user/sitemgr/web && npm run typecheck
   ```

8. **Run lint:**
   ```
   cd /home/user/sitemgr/web && npm run lint
   ```

## Edge Cases and Risks

**Risk:** A deleted test covered an edge case that no integration test exercises (e.g., a specific error code path in `approveDevice`).
**Mitigation:** The device-auth integration test exercises the real `/api/auth/device/*` routes end-to-end. Mock tests for these routes verified mock wiring, not actual behavior. If a real edge case is discovered later, add it as an integration test -- do not resurrect the mock test.

**Risk:** `encryption-lifecycle.test.ts` tested encrypt-store-retrieve-decrypt roundtrip.
**Mitigation:** `encryption-rotation.test.ts` covers the pure crypto rotation lifecycle. The DB roundtrip aspect (store encrypted value, retrieve, decrypt) is covered by integration tests that create bucket configs with encrypted secrets and read them back.

**Risk:** Deleting `agent-test-setup.ts` breaks a test not in the deletion list.
**Mitigation:** Grep for imports of `agent-test-setup` across all remaining test files before deleting. If any non-deleted test imports it, either delete that test too (if it's mock-heavy) or refactor it to remove the dependency.