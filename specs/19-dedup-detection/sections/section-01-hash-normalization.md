I have enough context now. Let me produce the section content.

# Section 1: Hash Normalization — S3 Upload Returns ETag

## Overview

This section fixes the hash mismatch between upload and scan events. Currently, scan events store `etag:${md5}` (from S3 ListObjectsV2 response) while upload events store `sha256:${hex}` (computed client-side). Since these are different algorithms, a file uploaded and then scanned produces two events with non-matching `content_hash` values, making dedup impossible.

The fix: capture the ETag from S3's PutObject response and store `etag:${s3Etag}` as `content_hash` for uploads, matching what scans already do.

## Dependencies

None. This section can be implemented independently.

## Files to Modify

1. `/home/user/sitemgr/web/lib/media/s3.ts` — `uploadS3Object()` function
2. `/home/user/sitemgr/web/app/api/buckets/[id]/upload/route.ts` — upload route handler

## Tests (Write First)

### Integration Test File: `/home/user/sitemgr/web/__tests__/integration/hash-normalization.test.ts`

This tests against real local Supabase and S3 (no mocks). Follow the same setup pattern as `media-lifecycle.test.ts` (create test user, seed bucket config, create S3 client).

**Test 1: `uploadS3Object` returns a string (the ETag)**

Call `uploadS3Object(s3Client, bucketName, "test.jpg", someBuffer, "image/jpeg")`. Assert the return value is a `string` and is non-empty (truthy).

**Test 2: `uploadS3Object` strips surrounding quotes from ETag**

S3 returns ETags wrapped in double quotes (e.g., `"abc123"`). Call `uploadS3Object` and assert the returned string does NOT contain quote characters. The value should be a bare hex string (32 hex chars for standard MD5 ETag).

**Test 3: Upload via API route stores `etag:` prefixed content_hash**

This test requires the Next.js dev server running (globalSetup handles this). POST a file to `/api/buckets/[id]/upload` with proper auth. Then query the `events` table for the returned `event_id` and assert `content_hash` starts with `"etag:"` (not `"sha256:"`).

**Test 4: Upload via API passes non-empty ETag to `upsertWatchedKey`**

After uploading via the API route, query the `watched_keys` table for the uploaded S3 key. Assert the `etag` column is non-empty (it was previously stored as `""`).

**Test 5 (key validation): Upload then list produces matching hashes**

Upload a file via `uploadS3Object`, capture the returned ETag. Then call `listS3Objects` on the same bucket. Find the uploaded key in the listing. Assert that the listed object's `etag` field matches the ETag returned by `uploadS3Object`. This proves the two code paths produce identical hash values.

### Test Setup Notes

Use the existing `setup.ts` helpers: `getAdminClient()`, `createTestUser()`, `getS3Config()`, `TINY_JPEG`. Create a dedicated test bucket (e.g., `test-hash-norm-${Date.now()}`). Clean up all created resources in `afterAll`.

For tests that hit the API route (tests 3-4), use `fetch()` against the local dev server with the user's access token as Bearer auth, same pattern used in other integration tests.

## Implementation Details

### Change 1: `uploadS3Object()` returns ETag

**File:** `/home/user/sitemgr/web/lib/media/s3.ts`

Current signature:

```typescript
export async function uploadS3Object(
  client: S3Client,
  bucket: string,
  key: string,
  body: Buffer,
  contentType?: string,
): Promise<void> {
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ...(contentType ? { ContentType: contentType } : {}),
    }),
  );
}
```

Change the return type from `Promise<void>` to `Promise<string>`. Capture the response from `client.send(...)`, extract `response.ETag`, strip surrounding quotes with `.replace(/"/g, "")` (same approach used in `listS3Objects` at line 102 of the current file), and return it.

If `response.ETag` is somehow undefined/null, throw an error — this would indicate an S3 provider issue and should not be silently ignored.

**Known limitation:** S3 multipart uploads produce ETags in the format `md5-N` (e.g., `abc123-3`). Since `uploadS3Object` uses `PutObjectCommand` (single-part), this is not a concern now.

### Change 2: Upload route uses ETag as content_hash

**File:** `/home/user/sitemgr/web/app/api/buckets/[id]/upload/route.ts`

Four changes in this file:

1. **Capture the ETag from `uploadS3Object`:** Change `await uploadS3Object(...)` to `const etag = await uploadS3Object(...)`.

2. **Use ETag as content_hash:** Replace the `sha256Bytes(fileBuffer)` call (line 57: `const contentHash = sha256Bytes(fileBuffer)`) with `const contentHash = \`etag:${etag}\``. This matches the format used by the scan path in `bucket-service.ts`.

3. **Pass ETag to `s3Metadata()`:** Change `s3Metadata(s3Key, fileBuffer.length, "")` to `s3Metadata(s3Key, fileBuffer.length, etag)`. The third argument is the etag field (currently passed as empty string `""`).

4. **Pass ETag to `upsertWatchedKey()`:** Change the empty string `""` in the `upsertWatchedKey()` call (the etag parameter, 4th positional arg) to `etag`. The current call is:
   ```typescript
   await upsertWatchedKey(
     auth.supabase, s3Key, eventId, "", fileBuffer.length, auth.user.id, config.id,
   );
   ```
   Change the `""` to `etag`.

5. **Remove unused import:** Remove `sha256Bytes` from the import of `@/lib/media/utils`. Keep all other imports from that module (`newEventId`, `detectContentType`, `getMimeType`, `s3Metadata`). The `sha256Bytes` function itself stays in `utils.ts` — only the import in this route file is removed.

### What is NOT changing

- **Scan path** (`bucket-service.ts`) — already stores `etag:${obj.etag}`, no modifications needed.
- **`sha256Bytes` utility** in `utils.ts` — stays, just no longer imported by the upload route.
- **Events schema** — `content_hash` column and `idx_events_content_hash` index already exist.
- **Other callers of `uploadS3Object`** — search the codebase for other call sites. If any exist and currently ignore the return value (`await uploadS3Object(...)`), they continue to work since the return value is simply unused. No changes needed at those sites.