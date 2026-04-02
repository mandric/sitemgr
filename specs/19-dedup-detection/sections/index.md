<!-- PROJECT_CONFIG
runtime: typescript-npm
test_command: npm test
END_PROJECT_CONFIG -->

<!-- SECTION_MANIFEST
section-01-hash-normalization
section-02-dedup-rpc
section-03-dedup-api
section-04-cli-dedup
END_MANIFEST -->

# Implementation Sections Index

## Dependency Graph

| Section | Depends On | Blocks | Parallelizable |
|---------|------------|--------|----------------|
| section-01-hash-normalization | - | - | Yes |
| section-02-dedup-rpc | - | section-03 | Yes |
| section-03-dedup-api | section-02 | section-04 | No |
| section-04-cli-dedup | section-03 | - | No |

## Execution Order

1. section-01-hash-normalization, section-02-dedup-rpc (parallel — no dependencies between them)
2. section-03-dedup-api (after section-02)
3. section-04-cli-dedup (after section-03)

## Section Summaries

### section-01-hash-normalization
Modify `uploadS3Object()` to return ETag. Update upload route to store `etag:${s3Etag}` as `content_hash` instead of `sha256:${hex}`. Update `s3Metadata()` and `upsertWatchedKey()` calls to use actual ETag. Integration test verifying upload events have etag-prefixed content_hash.

### section-02-dedup-rpc
New Supabase migration with `find_duplicate_groups` RPC function (LANGUAGE sql STABLE, SECURITY INVOKER). New `findDuplicateGroups()` function and `DuplicateGroup` interface in db.ts. Integration tests against real Supabase.

### section-03-dedup-api
New `GET /api/dedup?bucket_config_id=X` route. Authenticated via Bearer token. Returns duplicate groups with content_hash, copies, event_ids, paths. Integration tests against dev server.

### section-04-cli-dedup
New `smgr dedup <bucket>` command. Resolves bucket name, calls dedup API, displays table output. Summary line with extra_copies = sum(copies - 1). CLI E2E test.
