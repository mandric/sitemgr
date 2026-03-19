# Section 03: Input Validation

**Depends on:** nothing
**Blocks:** section-04 (S3 hardening), section-05 (enrichment hardening)
**Can be implemented as an independent PR**

---

## What You Are Building

One new file: `web/lib/media/validation.ts`

Three exported functions:
- `validateImage(buffer, mimeType)` — validates a file buffer before passing it to the Claude API
- `validateS3Key(key)` — validates an S3 object key before use in SDK calls
- `validateBucketConfig(config)` — validates a bucket configuration object before creating an S3 client

All three return a `ValidationResult` — a plain object with `valid`, `errors`, and `warnings` fields. They never throw. Callers decide what to do with the result.

---

## Why This Section Exists

The pipeline currently passes files to the Claude API without any pre-flight checks. A 25MB TIFF will burn an API call and then fail at the API boundary. A zero-byte file will produce a confusing enrichment error. A bucket config with a malformed endpoint URL will cause an opaque SDK crash. This section adds a cheap, synchronous validation layer that catches those cases before any network call is made.

Section 05 (enrichment) calls `validateImage` before sending to Claude. Section 04 (S3 hardening) calls `validateS3Key` in `downloadS3Object`. Section 04 also calls `validateBucketConfig` in `createS3Client`.

---

## Tests First

### File: `web/__tests__/validation.test.ts`

Write these tests before implementing `web/lib/media/validation.ts`. Run `npm test` from `web/` — all tests should fail (red) until the implementation is complete.

#### Test setup helpers

Define these buffer builders at the top of the test file. They keep individual test cases short:

```typescript
function makeJpegBuffer(sizeBytes = 100): Buffer {
  const buf = Buffer.alloc(sizeBytes);
  buf[0] = 0xff; buf[1] = 0xd8; buf[2] = 0xff;
  return buf;
}

function makePngBuffer(sizeBytes = 100): Buffer {
  const buf = Buffer.alloc(sizeBytes);
  buf[0] = 0x89; buf[1] = 0x50; buf[2] = 0x4e; buf[3] = 0x47;
  return buf;
}

function makeGifBuffer(sizeBytes = 100): Buffer {
  const buf = Buffer.alloc(sizeBytes);
  buf[0] = 0x47; buf[1] = 0x49; buf[2] = 0x46; buf[3] = 0x38;
  return buf;
}

function makeWebpBuffer(sizeBytes = 100): Buffer {
  const buf = Buffer.alloc(sizeBytes);
  // RIFF header
  buf[0] = 0x52; buf[1] = 0x49; buf[2] = 0x46; buf[3] = 0x46;
  // WEBP marker at bytes 8-11
  buf[8] = 0x57; buf[9] = 0x45; buf[10] = 0x42; buf[11] = 0x50;
  return buf;
}
```

#### Image validation tests

```typescript
import { describe, it, expect } from "vitest";
import { validateImage, validateS3Key, validateBucketConfig } from "@/lib/media/validation";

describe("validateImage", () => {
  // === Valid images ===
  // Test: accepts a valid JPEG buffer (starts with FF D8 FF) with mimeType "image/jpeg"
  //       result.valid is true, result.errors is empty
  // Test: accepts a valid PNG buffer (starts with 89 50 4E 47) with mimeType "image/png"
  // Test: accepts a valid GIF buffer (starts with 47 49 46 38) with mimeType "image/gif"
  // Test: accepts a valid WebP buffer (RIFF at 0-3, WEBP at 8-11) with mimeType "image/webp"
  // Test: result.warnings is an empty array for a normal valid image

  // === File size ===
  // Test: rejects a buffer of 20MB + 1 byte — result.valid is false, error mentions size limit
  // Test: accepts a buffer of exactly 20MB (20 * 1024 * 1024 bytes) — valid (boundary)

  // === MIME type ===
  // Test: rejects mimeType "image/tiff" — result.valid is false, error mentions the type
  // Test: rejects mimeType "application/pdf" — result.valid is false
  // Test: rejects mimeType "image/bmp" — result.valid is false
  // Test: rejects empty string mimeType — result.valid is false
  // Test: accepts "image/jpg" with a JPEG magic-byte buffer — normalizes to "image/jpeg" internally
  //       result.valid is true (the normalization happens before the magic-byte check)

  // === Magic bytes / corrupt files ===
  // Test: rejects a PNG-header buffer paired with mimeType "image/jpeg"
  //       result.valid is false, error message mentions magic byte mismatch
  // Test: rejects a JPEG-header buffer paired with mimeType "image/png"
  // Test: rejects an all-zero buffer with mimeType "image/jpeg" — no matching header
  //       result.valid is false
  // Test: rejects an empty buffer (length 0) — result.valid is false, error mentions empty
  // Test: rejects a buffer of only 2 bytes with mimeType "image/jpeg"
  //       (not enough bytes to read the 3-byte JPEG header)
  //       result.valid is false
  // Test: rejects a buffer of 11 bytes with mimeType "image/webp"
  //       (needs 12 bytes to check the WEBP marker at offset 8-11)
  //       result.valid is false

  // === Multiple errors accumulate ===
  // Test: an oversized buffer with wrong magic bytes produces at least 2 errors
  //       (both size error AND magic byte error appear in result.errors)
});
```

#### S3 key validation tests

```typescript
describe("validateS3Key", () => {
  // Test: accepts "photos/2024/image.jpg" — result.valid is true
  // Test: accepts a key with spaces "my photos/holiday 2024.jpg" — valid (S3 allows spaces)
  // Test: accepts a key with unicode "photos/été/plage.jpg" — valid
  // Test: accepts a key with tilde, parentheses, dashes "photos/img-(1)~final.jpg" — valid
  // Test: accepts a key that is exactly 1024 bytes long (UTF-8 byte length) — valid (boundary)
  // Test: rejects an empty string — result.valid is false
  // Test: rejects a key of 1025 bytes — result.valid is false, error mentions byte limit
  // Test: rejects a key containing a null byte (\u0000) — result.valid is false
  // Test: rejects a key containing ASCII control character \u0001 — result.valid is false
  // Test: rejects a key containing control character \u001f — result.valid is false
  // Test: a key with both a null byte and excessive length produces errors for both violations
});
```

#### Bucket config validation tests

```typescript
describe("validateBucketConfig", () => {
  const validConfig = {
    bucket_name: "my-bucket",
    endpoint_url: "https://s3.example.com",
    region: "us-east-1",
    access_key_id: "AKIAIOSFODNN7EXAMPLE",
    secret_access_key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  };

  // === Valid configs ===
  // Test: accepts validConfig — result.valid is true, result.errors is empty
  // Test: accepts config with endpoint_url omitted — result.valid is true
  // Test: accepts config with region omitted — result.valid is true
  // Test: accepts config with both endpoint_url and region omitted — result.valid is true
  // Test: accepts endpoint_url "http://localhost:9000" — http is allowed (local dev)

  // === Required field failures ===
  // Test: rejects config where bucket_name is an empty string — result.valid is false
  // Test: rejects config where access_key_id is an empty string — result.valid is false
  // Test: rejects config where secret_access_key is an empty string — result.valid is false

  // === Optional field format checks ===
  // Test: rejects endpoint_url "not-a-url" — result.valid is false, error mentions endpoint_url
  // Test: rejects endpoint_url "ftp://example.com" — only http/https are valid
  // Test: rejects region that is an empty string (if provided, must be non-empty)
  //       result.valid is false

  // === Error accumulation ===
  // Test: config with empty bucket_name AND invalid endpoint_url produces 2 errors
});
```

---

## Implementation

### File: `web/lib/media/validation.ts`

No imports from the rest of the codebase. No external dependencies. This module is intentionally isolated — it can be tested without setting up any other module.

**Shared return type:**

```typescript
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}
```

`valid` is `true` when `errors` is empty. Warnings are informational and do not affect `valid`.

---

**`validateImage(buffer: Buffer, mimeType: string): ValidationResult`**

Signature:

```typescript
export function validateImage(buffer: Buffer, mimeType: string): ValidationResult
```

All checks accumulate into an `errors` array before returning — do not short-circuit on the first failure (except the empty-buffer guard which makes subsequent checks meaningless).

Implementation logic:

1. **Empty buffer guard.** If `buffer.length === 0`, return immediately with a single error `"Image buffer is empty"`. Do not run any further checks.

2. **File size check.** Constant: `const MAX_IMAGE_SIZE_BYTES = 20 * 1024 * 1024`. If `buffer.length > MAX_IMAGE_SIZE_BYTES`, push an error that includes the actual size in MB, e.g. `"Image exceeds maximum size of 20MB (actual: 23.4MB)"`.

3. **MIME type check.** Normalize `"image/jpg"` → `"image/jpeg"` before checking (store the normalized value, use it for the remainder of the function). Allowed set: `["image/jpeg", "image/png", "image/gif", "image/webp"]`. If not in set, push error `"Unsupported MIME type: <mimeType>. Supported formats: image/jpeg, image/png, image/gif, image/webp"`.

4. **Magic bytes check.** Only run this check if the MIME type is in the allowed set (skip if the type check above failed). Check that the buffer has enough bytes for the format, then verify the header bytes:

   | Format | Min bytes needed | Bytes to verify |
   |--------|-----------------|-----------------|
   | `image/jpeg` | 3 | offset 0-2: `FF D8 FF` |
   | `image/png` | 4 | offset 0-3: `89 50 4E 47` |
   | `image/gif` | 4 | offset 0-3: `47 49 46 38` |
   | `image/webp` | 12 | offset 0-3: `52 49 46 46`, offset 8-11: `57 45 42 50` |

   If `buffer.length < minBytesNeeded`, push error `"Buffer too short to verify file format (need at least N bytes, got M bytes)"`.

   If the buffer is long enough but the bytes don't match, push error `"Magic bytes do not match declared MIME type <normalizedMimeType>"`.

Return `{ valid: errors.length === 0, errors, warnings: [] }`.

Note: dimension-based warnings (>1568px) are omitted from this implementation. Checking pixel dimensions requires decoding the image format, which is outside scope for a synchronous validation utility.

---

**`validateS3Key(key: string): ValidationResult`**

Signature:

```typescript
export function validateS3Key(key: string): ValidationResult
```

Checks (all run; errors accumulate):

1. If `key.length === 0`, push error `"S3 key must not be empty"`.
2. If `Buffer.byteLength(key, "utf8") > 1024`, push error `"S3 key exceeds maximum length of 1024 bytes"`. Use byte length, not character count — a single unicode character can be multiple bytes.
3. If `key.includes("\u0000")`, push error `"S3 key must not contain null bytes"`.
4. Scan for ASCII control characters: characters with `charCodeAt(i) < 32` or `charCodeAt(i) === 127`. If any are found, push error `"S3 key must not contain control characters"` (push once, not once per character).

Return `{ valid: errors.length === 0, errors, warnings: [] }`.

---

**`validateBucketConfig(config: BucketConfig): ValidationResult`**

The `BucketConfig` type is already in the codebase. Import it:

```typescript
import type { BucketConfig } from "@/lib/media/db";
```

If this causes a circular import in tests, define a local interface in the test file with the same required shape:

```typescript
// In the test file only — not in validation.ts
interface BucketConfig {
  bucket_name: string;
  endpoint_url?: string | null;
  region?: string | null;
  access_key_id: string;
  secret_access_key: string;
}
```

Signature:

```typescript
export function validateBucketConfig(config: BucketConfig): ValidationResult
```

Checks (all run; errors accumulate):

1. If `!config.bucket_name || config.bucket_name.trim() === ""`, push error `"bucket_name is required"`.
2. If `config.access_key_id !== undefined && config.access_key_id.trim() === ""`, push error `"access_key_id must not be empty"`.
3. If `config.secret_access_key !== undefined && config.secret_access_key.trim() === ""`, push error `"secret_access_key must not be empty"`.
4. If `config.endpoint_url` is present and non-null and non-empty:
   - Try `new URL(config.endpoint_url)`. If the `URL` constructor throws, push error `"endpoint_url is not a valid URL: <value>"` and skip the protocol check.
   - If it parses successfully but `url.protocol` is neither `"http:"` nor `"https:"`, push error `"endpoint_url must use http or https protocol (got: <protocol>)"`.
5. If `config.region !== undefined && config.region !== null && config.region.trim() === ""`, push error `"region must not be empty when provided"`.

Return `{ valid: errors.length === 0, errors, warnings: [] }`.

---

## How Downstream Sections Use These Functions

Section 05 (enrichment hardening) — call before the Claude API:

```typescript
const validation = validateImage(imageBytes, mimeType);
if (!validation.valid) {
  logger.info("Skipping enrichment: image validation failed", {
    key: s3Key,
    errors: validation.errors,
  });
  return null; // null = skipped, caller counts it in batch result
}
```

Section 04 (S3 hardening) — call in `downloadS3Object` before the SDK request:

```typescript
const keyValidation = validateS3Key(key);
if (!keyValidation.valid) {
  throw new Error(`Invalid S3 key: ${keyValidation.errors.join(", ")}`);
}
```

Section 04 also calls `validateBucketConfig` at the top of `createS3Client()`, throwing on failure before the `S3Client` constructor runs.

---

## Acceptance Criteria

- `web/__tests__/validation.test.ts` passes with `npm test`
- `web/lib/media/validation.ts` exports `validateImage`, `validateS3Key`, `validateBucketConfig`, and `ValidationResult`
- No external runtime dependencies added to `package.json`
- No imports from `web/lib/logger.ts` or `web/lib/request-context.ts` inside `validation.ts` — the module must be self-contained
- All three functions return `ValidationResult` and never throw
- `npm test` passes with no new failures in other test files
