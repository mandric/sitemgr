Now I have all the context needed. Let me write the section.

# Section 4: CLI Dedup Command

## Overview

Add a `smgr dedup <bucket-name>` CLI command that resolves a bucket name to its ID, calls the `GET /api/dedup` route (from section 3), and displays duplicate file groups as a formatted table. This section modifies a single file: `web/bin/smgr.ts`.

## Dependencies

- **Section 3 (Dedup API Route)** must be completed first. The CLI command calls `GET /api/dedup?bucket_config_id=X` and expects the response shape `{ data: { groups, total_duplicate_groups } }`.

## Tests First

### CLI E2E Tests

**File: `web/__tests__/integration/smgr-cli.test.ts`**

Add a new `describe("smgr dedup", ...)` block inside the existing test file. The tests run the CLI as a subprocess (same pattern as the existing `smgr stats`, `smgr query` tests in this file).

The test setup needs a bucket config and duplicate events. The existing `beforeAll` seeds data with `withBucketConfig: false`. For dedup tests, either adjust the shared seed to include a bucket config, or insert additional seed data inside the `describe` block's own `beforeAll`. The latter is safer to avoid breaking existing tests.

```
# Test: `smgr dedup <bucket>` with no duplicates prints "No duplicates found." and exits 0
#   - Use the seeded bucket (which has no duplicate content_hash values)
#   - Assert stdout contains "No duplicates found."
#   - Assert exitCode is 0

# Test: `smgr dedup <bucket>` with duplicates prints table with hash, copies, paths columns
#   - Insert 3 events with identical content_hash (e.g. "etag:abc123") and different remote_path values tied to the test user and bucket
#   - Run the command
#   - Assert stdout contains "etag:abc123"
#   - Assert stdout contains "3" (copies)
#   - Assert stdout contains the path fragments (with s3://bucket/ prefix stripped)
#   - Assert stdout contains "duplicate group" in the summary line
#   - Assert stdout contains "extra copies" in the summary line
#   - Assert exitCode is 0

# Test: `smgr dedup <nonexistent>` prints bucket not found error and exits 1
#   - Run with a bucket name that doesn't exist
#   - Assert stderr contains "Bucket not found"
#   - Assert exitCode is 1

# Test: `smgr dedup` with no arguments prints usage/help
#   - Run with no bucket argument
#   - Assert stdout or stderr contains usage guidance (e.g. "Usage:" or the main help text)
#   - Assert exitCode is non-zero (1)
```

**Setup for dedup tests:** The describe block needs its own `beforeAll` that:
1. Creates a bucket config for the test user (insert into `bucket_configs` via the admin client, or use the API). Store the bucket name and config ID.
2. For the "with duplicates" test, insert multiple `create` events with the same `content_hash` value, each with a different `remote_path`, all tied to the test user's ID and the bucket config ID.

Use the `insertEvent` helper from `../../lib/media/db` (already imported in the existing test file) or direct admin client inserts to seed duplicate events.

**Cleanup:** Remove the inserted bucket config and events in `afterAll` (or rely on the existing `cleanupUserData` which already deletes by user_id).

## Implementation Details

### File: `web/bin/smgr.ts`

**1. Add `cmdDedup()` function**

Place it alongside the other command functions (after `cmdAdd` or wherever is logical). The function signature and behavior:

```typescript
async function cmdDedup(args: string[]) {
  // Parse positionals — first arg is bucket name
  // If no bucket name, print usage and exit 1
  // Call requireUserId()
  // Resolve bucket name to ID via resolveBucketId(name)
  // Call apiGet(`/api/dedup?bucket_config_id=${id}`)
  // If no groups (empty array or total_duplicate_groups === 0):
  //   Print "No duplicates found." and return
  // Otherwise, print the table and summary
}
```

**2. Table output format**

The table format follows the existing patterns in the CLI (see `cmdBucketList` and `cmdQuery` for reference). Use `padEnd()` for column alignment and the `─` character for the separator line.

```
Hash              Copies  Paths
─────────────────────────────────────────────────
etag:abc123       3       vacation/beach.jpg
                          exports/IMG_2023.jpg
                          backup/beach-copy.jpg
etag:def456       2       photos/sunset.jpg
                          archive/sunset-old.jpg

2 duplicate groups, 3 extra copies
```

Key formatting details:
- The `Hash` column shows the full `content_hash` value (e.g., `etag:abc123`)
- The `Copies` column shows the count
- The `Paths` column shows the first path on the same line as Hash/Copies, subsequent paths on continuation lines (indented to align with the Paths column)
- Strip the `s3://bucket-name/` prefix from paths for readability. The bucket context is already known from the command argument. Use a simple string replace or regex to remove `s3://<anything>/` prefix
- Summary line: `N duplicate groups, M extra copies` where M = `sum(group.copies - 1)` across all groups

**3. Response type**

The API returns:
```typescript
interface DedupResponse {
  data: {
    groups: Array<{
      content_hash: string;
      copies: number;
      event_ids: string[];
      paths: string[];
    }>;
    total_duplicate_groups: number;
  };
}
```

Use this as the type parameter for `apiGet<DedupResponse>(...)`.

**4. Error handling**

- Bucket not found: `resolveBucketId()` already calls `cliError("Bucket not found: ${name}")` with implicit exit code 1 (USER). No extra handling needed.
- API error: Wrap the `apiGet` call in try/catch and call `cliError(errorMessage, EXIT.SERVICE)` on failure. Follow the same pattern as `cmdStats`.

**5. Register the command**

Add `dedup` to the `commands` record (around line 646):

```typescript
const commands: Record<string, (args: string[]) => Promise<void>> = {
  // ... existing commands ...
  dedup: cmdDedup,
};
```

**6. Update the help text**

Add a `dedup` line to the usage string printed when no command is given (around line 660). Place it near `stats` and `query`:

```
  smgr dedup <bucket>           Find duplicate files in a bucket
```

## Key Files

- **Modify:** `/home/user/sitemgr/web/bin/smgr.ts` — add `cmdDedup()`, register in command dispatch, update help text
- **Modify:** `/home/user/sitemgr/web/__tests__/integration/smgr-cli.test.ts` — add CLI E2E tests for the dedup command

## Exit Codes

| Scenario | Exit Code | Constant |
|----------|-----------|----------|
| No duplicates found | 0 | EXIT.SUCCESS |
| Duplicates displayed | 0 | EXIT.SUCCESS |
| Bucket not found | 1 | EXIT.USER |
| No bucket argument | 1 | EXIT.USER |
| API call failure | 2 | EXIT.SERVICE |