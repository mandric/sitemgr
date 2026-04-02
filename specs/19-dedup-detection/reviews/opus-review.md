# Review: Spec 19 Duplicate Detection Implementation Plan

## Overall Assessment

The plan is well-structured, correctly scoped, and faithfully implements the spec. The four sections map cleanly to the spec requirements. The technical approach (capturing S3 ETag from PutObject) is sound and minimal.

## Critical Issues

### 1. RPC function SECURITY DEFINER vs SECURITY INVOKER not specified
The RPC must use SECURITY INVOKER (the default) to match existing patterns. If someone accidentally adds SECURITY DEFINER, the p_user_id filter becomes the sole tenant isolation barrier.

### 2. Index effectiveness for the GROUP BY query
The claim that idx_events_content_hash covers the GROUP BY efficiently is misleading. The query has additional WHERE predicates (type, user_id) not in the index. At expected scale (<100 groups, <10K events), sequential scan is fine.

## Moderate Issues

### 3. Multipart upload ETags break the dedup assumption
S3 multipart uploads produce ETags in format md5-N, not plain MD5. Not an immediate problem (uploadS3Object uses PutObjectCommand), but should be documented.

### 4. s3Metadata call still passes empty string for etag
The plan mentions updating upsertWatchedKey but not updating s3Metadata(s3Key, fileBuffer.length, "") to pass the actual ETag.

### 5. No test plan in claude-plan.md
(Addressed separately in claude-plan-tdd.md)

### 6. Missing LANGUAGE and STABLE markers in RPC spec

## Minor Issues

### 7. Remove contentHash variable assignment (not just import)
### 8. CLI summary formula not specified: extra_copies = sum(group.copies - 1)
### 9. ETag quote stripping should match listS3Objects pattern: .replace(/"/g, "")
