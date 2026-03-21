# Section 07: Media Storage Test Suite

## Overview

Rewrite `web/__tests__/integration/media-s3.test.ts` as `media-storage.test.ts` with BDD naming. The existing test is already clean and well-structured — minimal logic changes needed, primarily a rename and naming convention update.

## Context

The existing `media-s3.test.ts` (87 lines) tests S3-compatible storage operations using Supabase Storage. It uses the `TINY_JPEG` fixture (23-byte minimal valid JPEG), creates a dynamic test bucket, and tests upload, list, and download operations. The test is functionally correct — this rewrite adds BDD naming and aligns with the new file structure.

**Current test file being replaced:**
- `web/__tests__/integration/media-s3.test.ts` (87 lines)

**Prerequisites from earlier sections:**
- Section 02: `globalSetup.ts` validates Supabase connectivity
- Section 03 (existing exports): `getAdminClient()`, `getS3Config()`, `TINY_JPEG` from setup.ts

## What to Build

### File: `web/__tests__/integration/media-storage.test.ts`

### Setup

**`beforeAll`:**
1. Get admin client and S3 config from setup.ts
2. Create a test bucket with dynamic name: `test-storage-${Date.now()}`
3. Initialize `uploadedKeys: string[]` for cleanup tracking

**`afterAll`:**
1. Remove all tracked objects: `admin.storage.from(bucketName).remove(uploadedKeys)`
2. Delete test bucket: `admin.storage.deleteBucket(bucketName)`

### Test Group 1: Upload and list

```
describe('when uploading objects', () => {
  it('should upload an object and list it in the bucket')
    // 1. Upload TINY_JPEG with key "test/photo1.jpg"
    // 2. List objects with prefix "test/"
    // 3. Assert uploaded object appears in list
    // 4. Track key for cleanup
})
```

### Test Group 2: Download

```
describe('when downloading objects', () => {
  it('should download an uploaded object with correct content')
    // 1. Upload TINY_JPEG with key "test/download.jpg"
    // 2. Download the same key
    // 3. Assert downloaded content matches original TINY_JPEG bytes
})
```

### Test Group 3: Empty listing

```
describe('when listing nonexistent prefixes', () => {
  it('should return empty list for nonexistent prefix')
    // 1. List objects with prefix "nonexistent/"
    // 2. Assert empty array returned
})
```

### Test Group 4: Batch upload

```
describe('when uploading multiple objects', () => {
  it('should upload and list multiple objects')
    // 1. Upload 3 objects with keys "batch/photo1.jpg", "batch/photo2.jpg", "batch/photo3.jpg"
    // 2. List objects with prefix "batch/"
    // 3. Assert all 3 present
    // 4. Track all keys for cleanup
})
```

### Timeout

60s timeout (S3 operations can be slow).

### Migration from Existing Test

The existing `media-s3.test.ts` structure maps directly:
- Current "upload and list single object" → Group 1
- Current "download" → Group 2
- Current "empty prefix" → Group 3
- Current "upload multiple" → Group 4

Key changes:
- Rename file from `media-s3.test.ts` to `media-storage.test.ts`
- Add `describe('when ...')` wrappers for BDD naming
- Use `it('should ...')` pattern for test names
- Remove any `skipIf` guards (globalSetup handles this)
- Keep S3 client setup logic (it works correctly)

## Files to Create/Modify

| File | Action |
|------|--------|
| `web/__tests__/integration/media-storage.test.ts` | CREATE |

## Acceptance Criteria

1. All 4 test groups pass against a fresh `supabase start`
2. Upload, list, download, and batch operations all work
3. Dynamic bucket creation and cleanup work correctly
4. BDD naming throughout (`should ... when ...`)
5. No `describe.skipIf` — relies on globalSetup
6. Suite completes within 60s timeout
7. All uploaded objects cleaned up in afterAll
