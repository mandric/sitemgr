I have enough context. Let me now generate the section content.

# Section 02: Server-Side Helpers (Device Code Generation)

## Overview

This section creates the pure utility functions for generating device codes and user codes used throughout the device code auth flow. These helpers live in a new file `web/lib/auth/device-codes.ts` and have **no dependencies** on the database migration (section 01) or any API routes. They are pure functions using Node.js `crypto`.

## Files to Create

- `web/lib/auth/device-codes.ts` -- utility functions
- `web/__tests__/device-codes.test.ts` -- unit tests

## Tests (Write First)

**File:** `web/__tests__/device-codes.test.ts`

The test file covers two function groups: `generateUserCode()` and `generateDeviceCode()`.

```typescript
import { describe, it, expect } from "vitest";
import { generateUserCode, generateDeviceCode, SAFE_CHARSET } from "@/lib/auth/device-codes";

describe("generateUserCode()", () => {
  it("generates 8-character code in XXXX-XXXX format", () => {
    const code = generateUserCode();
    expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  });

  it("all characters are from safe charset (ABCDEFGHJKMNPQRSTUVWXYZ23456789)", () => {
    // Generate several codes and check every character
    for (let i = 0; i < 50; i++) {
      const code = generateUserCode();
      const chars = code.replace("-", "");
      for (const ch of chars) {
        expect(SAFE_CHARSET).toContain(ch);
      }
    }
  });

  it("contains no ambiguous characters (0, O, 1, I, l)", () => {
    const ambiguous = ["0", "O", "1", "I", "l"];
    for (let i = 0; i < 100; i++) {
      const code = generateUserCode();
      for (const ch of ambiguous) {
        expect(code).not.toContain(ch);
      }
    }
  });

  it("generates unique codes across 100 invocations (statistical uniqueness)", () => {
    const codes = new Set<string>();
    for (let i = 0; i < 100; i++) {
      codes.add(generateUserCode());
    }
    // With ~30^8 possibilities, 100 codes should all be unique
    expect(codes.size).toBe(100);
  });
});

describe("generateDeviceCode()", () => {
  it("generates 64-character hex string", () => {
    const code = generateDeviceCode();
    expect(code).toMatch(/^[0-9a-f]{64}$/);
    expect(code).toHaveLength(64);
  });

  it("uses cryptographically random bytes (verify length of underlying buffer)", () => {
    // 64 hex chars = 32 bytes of randomness
    const code = generateDeviceCode();
    // Convert back to buffer to verify 32 bytes
    const buf = Buffer.from(code, "hex");
    expect(buf).toHaveLength(32);
  });
});
```

**Test configuration:** These are unit tests. They live in `web/__tests__/` (not `web/__tests__/integration/`) so they run under the `unit` project in the existing vitest workspace config. No Supabase or environment variables needed.

## Implementation

**File:** `web/lib/auth/device-codes.ts`

This file exports three things:

1. **`SAFE_CHARSET`** -- the string `"ABCDEFGHJKMNPQRSTUVWXYZ23456789"` (30 characters). Excludes `0` (confused with `O`), `O` (confused with `0`), `1` (confused with `I`/`l`), `I` (confused with `1`/`l`), and `l` (confused with `1`/`I`). This is exported as a constant so tests can validate against it.

2. **`generateUserCode(): string`** -- picks 8 random characters from `SAFE_CHARSET` using `crypto.randomBytes()`, formats them as `XXXX-XXXX` (hyphen inserted between positions 4 and 5). Implementation approach:
   - Call `crypto.randomBytes(8)` to get 8 random bytes
   - For each byte, use modular arithmetic (`byte % SAFE_CHARSET.length`) to select a character from the charset
   - Note: since 256 is not a perfect multiple of 30, there is a very slight bias, which is acceptable for a short-lived user-facing code with ~39 bits of entropy
   - Insert a hyphen after the 4th character
   - Return the formatted string

3. **`generateDeviceCode(): string`** -- generates a 64-character lowercase hex string using `crypto.randomBytes(32).toString('hex')`. This produces 256 bits of entropy for the polling secret. This code is never displayed to users.

Both functions are synchronous (Node.js `crypto.randomBytes` with a length argument is synchronous).

**Imports needed:** Only `import { randomBytes } from "node:crypto"`.

## Dependencies

- **No dependencies on other sections.** This section is in Batch 1 and can be implemented in parallel with section-01 (DB migration).
- Sections 03 (initiate API), 04 (poll API), 05 (approve API), and 07 (CLI refactor) will import from this file.

## Verification

After implementation, run from the repo root:

```bash
cd /home/user/sitemgr/web && npm run typecheck && npm run lint && npm run test && npm run build
```

The new test file `web/__tests__/device-codes.test.ts` should be picked up automatically by the vitest `unit` project (it matches the default include pattern and is not in the `integration` or `e2e` directories).