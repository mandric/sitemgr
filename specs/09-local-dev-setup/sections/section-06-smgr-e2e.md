Now I have all the information needed. Here is the section content:

---

# Section 06: Fix `smgr-e2e.test.ts` Bucket Dependency

## Overview

`web/__tests__/integration/smgr-e2e.test.ts` is the optional end-to-end test suite that exercises the full smgr pipeline: uploads fixture images to S3, runs `smgr watch --once` to discover them, enriches with Ollama moondream:1.8b, and verifies full-text search. This test requires Ollama running locally and is skipped by passing `--skip-ollama` to `test-integration.sh`.

The problem: this test hardcodes `SMGR_S3_BUCKET: "media"` and assumes a bucket named `media` already exists in local Supabase Storage. With the changes from section-01-local-dev-sh, `local-dev.sh` no longer pre-creates the `media` bucket via `curl`. If `media` does not exist, the test fails immediately when attempting to upload fixture images.

All other integration tests (`media-storage.test.ts`, `media-lifecycle.test.ts`) use `admin.storage.createBucket()` in `beforeAll` to create a uniquely-named ephemeral bucket, then delete it in `afterAll`. This test must follow the same pattern for the `media` bucket.

## Dependencies

- **No section dependencies.** This section is parallelizable with sections 01, 03, 04, 05, and 09.
- Requires local Supabase running with a test user accessible via `getAdminClient()` from `./setup`.

## File to Modify

`/Users/mandric/dev/github.com/mandric/sitemgr/web/__tests__/integration/smgr-e2e.test.ts`

## Tests First

The following behaviors must hold after the change. These are described as vitest expectations — no new test file is needed; the changes live within the existing `beforeAll`/`afterAll` of `smgr-e2e.test.ts`.

```typescript
// Test: beforeAll creates 'media' bucket without error when it does not exist
// Test: beforeAll treats 'bucket already exists' error as non-fatal
//       (so the test is safe to re-run without manually deleting the bucket)
// Test: afterAll removes only the objects this test run uploaded (uploadedKeys)
// Test: afterAll does NOT delete the bucket itself
//       (preserving 'media' for any manual testing that may rely on it)
// Test: full E2E run passes when bucket did not pre-exist before the test —
//       i.e., the test is self-sufficient and does not require local-dev.sh
//       to have pre-created the bucket
```

Run the acceptance check after modifying:

```bash
./scripts/test-integration.sh  # with Ollama — no --skip-ollama flag
```

## Implementation

### What to Change

The existing `beforeAll` in `web/__tests__/integration/smgr-e2e.test.ts` (line 106) already handles: Ollama health check, test user creation, admin client setup, model_configs insert, fixture uploads to S3, and upload verification. It uses `admin` (the Supabase admin client, obtained from `getAdminClient()`).

**Add a bucket creation step** between step 2 (Create test user / Get admin client) and step 5 (Upload fixture images). Specifically, after obtaining `admin`, call `admin.storage.createBucket("media", { public: false })` and treat a "bucket already exists" error as non-fatal.

The Supabase Storage API returns an error object with a `message` that includes text like `"already exists"` or an error `code` of `"23505"` (Postgres unique-violation) when the bucket already exists. Inspect the error and re-throw only if it is not a pre-existing-bucket error.

Stub signature for the bucket creation logic to add inside `beforeAll`:

```typescript
// 3b. Ensure 'media' bucket exists (create if absent; ignore if already exists)
const { error: bucketErr } = await admin.storage.createBucket("media", {
  public: false,
});
if (bucketErr && !bucketErr.message.includes("already exists")) {
  throw new Error(`Failed to create media bucket: ${bucketErr.message}`);
}
```

**Do not change `afterAll`** for bucket deletion. The existing `afterAll` (lines 167–187) already:
1. Removes uploaded S3 objects: `admin.storage.from("media").remove(uploadedKeys)`
2. Cleans up model_configs and user data
3. Signs out clients

This cleanup is exactly correct — it removes only the objects this test uploaded (tracked in `uploadedKeys`) without deleting the `media` bucket itself. No change needed there.

### Existing Code Context

The `uploadedKeys` array (line 43) accumulates S3 object keys during `beforeAll`. The `afterAll` already passes this array to `admin.storage.from("media").remove(uploadedKeys)` (line 170). The bucket name `"media"` is the hardcoded constant used both in `E2E_ENV` (`SMGR_S3_BUCKET: "media"`) and in the upload/cleanup calls.

The `admin` variable is module-scoped (line 38), assigned during `beforeAll`. The bucket creation call must happen after `admin = getAdminClient()` (line 124).

### Ordering Within `beforeAll`

The `beforeAll` block currently has steps numbered 1–6. The bucket creation should be inserted as step 3.5 (between "Get admin client" and "Insert model_configs row"), but the exact position within the existing block does not matter as long as `admin` is assigned before the call. Inserting it just after `admin = getAdminClient()` is simplest:

```
1. Ollama health check
2. Create test user
3. Get admin client
   → 3b. Create 'media' bucket (new step)
4. Insert model_configs row
5. Upload fixture images to S3
6. Verify uploads are visible
```

## Acceptance Criteria

- The test suite runs to completion with Ollama active even when no `media` bucket was pre-created by `local-dev.sh`.
- Re-running the test suite immediately after a previous run (bucket already exists) does not error in `beforeAll`.
- After the test completes, the `media` bucket still exists (is not deleted by `afterAll`), but the test's uploaded objects under `test-e2e-<timestamp>/` are removed.