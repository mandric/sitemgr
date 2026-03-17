I have all the context needed. Here is the section content:

# Section 09: Event ID Format -- Replace Truncated UUID with ULID

## Overview

This section replaces the current `newEventId()` function in `web/lib/media/utils.ts`, which generates 26-character truncated UUIDs, with ULID (Universally Unique Lexicographically Sortable Identifier) generation. This is an application-code-only change with no database migration required.

**Dependencies:** None. This section can be implemented in parallel with any other section.

**Blocks:** Nothing. No other section depends on this.

## Background

The `events` table uses `TEXT PRIMARY KEY`. The current `newEventId()` function in `web/lib/media/utils.ts` generates IDs by stripping hyphens from a random UUID and taking the first 26 characters:

```typescript
export function newEventId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 26);
}
```

These IDs are random with no time component, which means B-tree index inserts scatter across the index rather than appending sequentially.

ULIDs are 26 characters in Crockford Base32 encoding (same length as current IDs), encode a millisecond timestamp in the first 10 characters, and include 80 bits of randomness. This provides B-tree insert locality for new events without affecting existing data.

**Important:** After this change, the events table will contain mixed ID formats. Old events retain their hex-based truncated UUIDs; new events get Crockford Base32 ULIDs. Sorting by `id` will NOT produce chronological order across all events. The `timestamp` column remains the correct column for chronological queries.

## Callers of `newEventId()`

All callers treat the return value as an opaque string passed directly to `insertEvent()`. No caller parses, slices, or validates the format of the returned ID. The callers are:

- `/home/user/sitemgr/web/lib/agent/core.ts` -- used at lines 634 and 670 to generate IDs for new events
- `/home/user/sitemgr/web/bin/smgr.ts` -- used at line 271 to generate IDs during S3 sync

No other code in the codebase assumes a specific ID format (no regex matching against `[a-f0-9]{26}`, no length checks, no slicing of event IDs).

## Tests First

The existing test file at `/home/user/sitemgr/web/__tests__/media-utils.test.ts` contains a `newEventId` describe block that must be updated. The current tests assert hex format (`/^[a-f0-9]{26}$/`), which will no longer be valid after the ULID change.

Replace the existing `newEventId` test block and add the new ULID-specific tests. The test file location remains `/home/user/sitemgr/web/__tests__/media-utils.test.ts`.

### Test stubs to implement

```typescript
describe("newEventId", () => {
  // Test: newEventId() generates valid ULID format (26 chars, Crockford Base32)
  // ULID charset: 0123456789ABCDEFGHJKMNPQRSTVWXYZ
  // Assert length is 26
  // Assert matches /^[0-9A-HJKMNP-TV-Z]{26}$/
  it("generates valid ULID format (26 chars, Crockford Base32)", () => {
    // Call newEventId(), verify length === 26 and matches Crockford Base32 regex
  });

  // Test: newEventId() IDs are monotonically increasing within same millisecond
  // Generate multiple IDs in tight loop (same ms), verify each is >= previous
  it("IDs are monotonically increasing within same millisecond", () => {
    // Generate ~10 IDs in rapid succession, verify id[n] > id[n-1] lexicographically
  });

  // Test: newEventId() IDs generated 1ms apart sort correctly lexicographically
  // Generate ID, wait 1ms, generate another, verify second > first
  it("IDs generated 1ms apart sort correctly lexicographically", () => {
    // Generate id1, await small delay, generate id2, verify id2 > id1
  });

  // Test: old truncated-UUID IDs still work as event primary keys
  // This is a documentation-level assertion: old IDs are plain strings, the
  // column is TEXT, no migration changes them. Just verify a hex-style string
  // is a valid TEXT value (trivially true).
  it("old truncated-UUID format IDs remain valid strings", () => {
    // Verify that a sample old-format ID like "a1b2c3d4e5f6a1b2c3d4e5f6ab" is
    // still a valid string (typeof === 'string', length 26). This confirms no
    // code rejects old-format IDs.
  });

  // Test: uniqueness across 1000 generated IDs
  it("is unique across many IDs", () => {
    // Generate 1000 IDs into a Set, verify Set.size === 1000
  });
});
```

The fifth test from the TDD plan -- "no code in codebase assumes specific ID format" -- is a manual search verification, not an automated test. Perform this by searching the codebase for patterns like `/[a-f0-9]{26}/`, `.slice(0, 26)`, `.length === 26` applied to event IDs. The search results above confirm no such assumptions exist outside the test file itself.

## Implementation

### Step 1: Add `ulid` dependency

Install the `ulid` npm package in the `web/` directory:

```
cd /home/user/sitemgr/web && npm install ulid
```

The `ulid` package exports a `ulid()` function that returns a 26-character Crockford Base32 string. It handles monotonic ordering within the same millisecond via its built-in monotonic factory.

### Step 2: Update `newEventId()` in `/home/user/sitemgr/web/lib/media/utils.ts`

Replace the current implementation. Use the monotonic factory from the `ulid` package to guarantee monotonically increasing IDs even within the same millisecond:

```typescript
// Replace: import { createHash, randomUUID } from "crypto";
// With:    import { createHash } from "crypto";
// Add:     import { monotonicFactory } from "ulid";

// At module level, create a monotonic ULID generator
// const generateUlid = monotonicFactory();

// Replace the function body:
export function newEventId(): string {
  // return generateUlid();
}
```

Key points:
- Use `monotonicFactory()` rather than the bare `ulid()` export, because the factory maintains internal state to ensure monotonic ordering within the same millisecond
- The factory is created once at module level so the monotonic counter persists across calls
- The `randomUUID` import from `crypto` can be removed since no other function in this file uses it
- The function signature remains unchanged: `() => string`

### Step 3: Update the existing test

In `/home/user/sitemgr/web/__tests__/media-utils.test.ts`, replace the existing `newEventId` describe block (lines 74-85) with the new test stubs described above. The key change is the regex: from `/^[a-f0-9]{26}$/` (hex) to `/^[0-9A-HJKMNP-TV-Z]{26}$/` (Crockford Base32).

### Step 4: Verify no format assumptions exist

Run a codebase search for any code that might break with the new format. Patterns to search:
- Regex matching hex-only characters against event IDs
- Length checks specific to 26 characters on event IDs
- Any parsing or substring operations on event IDs

The audit above confirms the only place that asserts hex format is the test file itself (line 78: `expect(id).toMatch(/^[a-f0-9]{26}$/)`), which will be updated in Step 3.

## Files Modified

| File | Change |
|------|--------|
| `/home/user/sitemgr/web/package.json` | Add `ulid` dependency |
| `/home/user/sitemgr/web/lib/media/utils.ts` | Replace `newEventId()` implementation with ULID generation |
| `/home/user/sitemgr/web/__tests__/media-utils.test.ts` | Update `newEventId` tests for ULID format |

## Verification Checklist

1. All existing tests in `media-utils.test.ts` pass (other describe blocks unchanged)
2. The new `newEventId` tests pass
3. `npm test` passes across the full test suite (no other tests depend on hex event ID format)
4. The `ulid` package is listed in `package.json` dependencies (not devDependencies, since it is used at runtime)