Now I have all the context needed. Let me produce the section content.

# Section 8: Refactor Integration Tests to Use App Layer

## Goal

Refactor `web/__tests__/integration/media-lifecycle.test.ts` so that test assertions and data operations go through the app-layer functions exported by `web/lib/media/db.ts` (such as `queryEvents()`, `getStats()`, `getEnrichStatus()`) instead of making raw Supabase SDK calls like `admin.from("events").select(...)` or `admin.rpc("search_events", ...)`. The test for tenant isolation (`tenant-isolation.test.ts`) is intentionally left unchanged because it tests RLS at the raw database level.

## Dependencies

- **Section 07 (env-var-rename):** The env var rename from `SUPABASE_SECRET_KEY` to `SUPABASE_SERVICE_ROLE_KEY` in `setup.ts` must be complete before this section, since `media-lifecycle.test.ts` imports from `setup.ts`.

## Background

The current `media-lifecycle.test.ts` already imports and uses several `db.ts` functions:

- `insertEvent()` -- used for all event creation
- `insertEnrichment()` -- used for all enrichment creation
- `upsertWatchedKey()` -- used for watched key operations

However, the test still makes raw SDK calls in several places:

1. **Search tests** (lines 146, 160): `admin.rpc("search_events", {...})` -- should use `queryEvents()` with the `search` option
2. **Stats tests** (lines 217, 229): `admin.rpc("stats_by_content_type", {...})` and `admin.rpc("stats_by_event_type", {...})` -- should use `getStats()`
3. **Enrichment progress** (lines 244-253): raw `admin.from("events").select(...)` and `admin.from("enrichments").select(...)` count queries -- should use `getEnrichStatus()`
4. **Watched key verification** (lines 280-283): `admin.from("watched_keys").select("*").eq("s3_key", testKey)` -- this is a specific row lookup for test verification; can use `getWatchedKeys()` or remain raw since it is verifying a single row by key (acceptable either way)
5. **Cross-user isolation** (line 293): `userClient.from("events").select("*")` -- should use `queryEvents()`

## Principle

Test assertions should call app-layer code (`db.ts` functions). Test **setup and teardown** (creating users, seeding data, deleting data) may continue to use the admin SDK directly since there are no app-layer equivalents for `auth.admin.createUser()` or bulk delete operations. The `setup.ts` helpers are explicitly for this purpose.

**Exception:** `tenant-isolation.test.ts` intentionally uses raw SDK calls to prove RLS works at the database level. It must remain unchanged and must NOT import from `@/lib/media/db`.

## Tests (the deliverable IS the refactored test file)

Since this section refactors an existing test file, the tests themselves are the deliverable. The verification criteria are:

### File: `web/__tests__/integration/media-lifecycle.test.ts`

```
# Verify: event creation uses insertEvent() from db.ts (not admin.from("events").insert()) -- ALREADY DONE
# Verify: enrichment insert uses insertEnrichment() from db.ts -- ALREADY DONE
# Verify: search assertions use queryEvents() from db.ts (not admin.rpc("search_events"))
# Verify: stats assertions use getStats() from db.ts (not admin.rpc("stats_by_content_type") or admin.rpc("stats_by_event_type"))
# Verify: enrichment progress check uses getEnrichStatus() from db.ts (not raw count queries)
# Verify: cross-user event isolation check uses queryEvents() from db.ts (not userClient.from("events"))
# Verify: no raw client.from("events") calls remain in assertions (setup/teardown excluded)
# Verify: all assertions still go through app-layer functions and produce the same logical checks
```

### Verification: `tenant-isolation.test.ts` unchanged

```
# Verify: tenant-isolation.test.ts still uses raw SDK calls (intentional -- tests RLS, not app layer)
# Verify: no imports from @/lib/media/db in tenant-isolation.test.ts
```

## Implementation Details

### File to modify: `web/__tests__/integration/media-lifecycle.test.ts`

#### 1. Add new imports from `db.ts`

Add `queryEvents`, `getStats`, and `getEnrichStatus` to the existing import block from `../../lib/media/db`:

```typescript
import {
  insertEvent,
  insertEnrichment,
  upsertWatchedKey,
  queryEvents,
  getStats,
  getEnrichStatus,
} from "../../lib/media/db";
```

#### 2. Replace search test assertions

In the "when uploading and searching for media" describe block:

**"should find uploaded photo via full-text search matching enrichment description"** -- Replace the raw `admin.rpc("search_events", {...})` call with `queryEvents(admin, { userId, search: "sunset" })`. The `queryEvents` function calls `search_events` RPC internally when the `search` option is provided. Assert on `data` from the returned `{ data, count, error }` shape.

**"should not return results for non-matching search query"** -- Replace `admin.rpc("search_events", {...})` with `queryEvents(admin, { userId, search: "xyznonexistent" })`. Assert `data` is empty.

#### 3. Replace stats test assertions

In the "when requesting statistics" describe block:

**"should return correct counts by content type"** -- Replace `admin.rpc("stats_by_content_type", {...})` with `getStats(admin, { userId })`. Assert on `data.by_content_type["image/jpeg"]` being >= 2 (the `getStats` function returns a `by_content_type` record keyed by content type string).

**"should return correct counts by event type"** -- Replace `admin.rpc("stats_by_event_type", {...})` with `getStats(admin, { userId })`. Assert on `data.by_event_type["create"]` being >= 3.

Note: Both stats tests can share a single `getStats()` call or make separate calls -- either approach works. The key is that the raw RPC calls are removed.

#### 4. Replace enrichment progress check

In the "when checking enrichment progress" describe block:

**"should show correct pending and enriched counts"** -- Replace the parallel raw `admin.from("events").select(...)` and `admin.from("enrichments").select(...)` count queries with `getEnrichStatus(admin, userId)`. Assert that `data.enriched >= 2`, `data.pending >= 1`, and `data.total_media === data.enriched + data.pending`.

Note: `getEnrichStatus` filters events by `type = "create"` and `content_type = "photo"`. The current raw query filters by `type = "create"` only. If the test seeds events with `content_type: "image/jpeg"` (not `"photo"`), the counts will differ. Check the seeded `content_type` values and adjust either the test expectations or use `getStats()` instead, which does not filter by `content_type = "photo"`. The existing seeded events use `content_type: "image/jpeg"`, so `getStats()` is the better fit here -- use `data.total_events` minus `data.enriched` for pending count.

#### 5. Replace cross-user isolation check

In the "when another user has media" describe block:

**"should not include other user's events in query results"** -- Replace `userClient.from("events").select("*")` with `queryEvents(userClient, { userId })`. The `queryEvents` function filters by `userId` and returns `{ data, count, error }`. Assert that all returned events have `user_id === userId` and that none of user B's event IDs appear.

Note: `queryEvents` adds `.eq("type", "create")` and ordering by default. The existing raw query selects all event types. Since all seeded events use `type: "create"`, this is functionally equivalent. If the test needs to query all event types, use the raw call -- but given all seeded data is `type: "create"`, `queryEvents` works.

#### 6. Watched key verification (optional change)

The watched key row lookup (`admin.from("watched_keys").select("*").eq("s3_key", testKey)`) in the "when re-scanning a watched key" test is a specific row lookup for test verification. There is no `getWatchedKeyByS3Key()` function in `db.ts` -- only `getWatchedKeys()` which returns all keys for a user. This raw query can remain as-is since it is verifying test setup behavior (checking a specific row's etag and size_bytes values), not testing app-layer logic. Alternatively, wrap it in a `getWatchedKeys()` call and filter client-side, but this adds no value.

### What NOT to change

- **Setup and teardown code** -- `admin.from("bucket_configs").insert(...)`, `admin.from("user_profiles").insert(...)`, `admin.storage.createBucket(...)`, and all cleanup/delete operations stay as raw SDK calls. These are test infrastructure, not app-layer assertions.
- **`tenant-isolation.test.ts`** -- Do not modify. Do not add `db.ts` imports. This file intentionally tests RLS at the raw SDK level.

### Key function signatures from `db.ts` for reference

```typescript
queryEvents(client: SupabaseClient, opts: QueryOptions)
// Returns: { data: EventRow[], count: number, error }
// When opts.search is set, calls search_events RPC internally

getStats(client: SupabaseClient, opts?: { userId?: string; deviceId?: string })
// Returns: { data: { total_events, by_content_type, by_event_type, enriched, ... }, error }

getEnrichStatus(client: SupabaseClient, userId?: string)
// Returns: { data: { total_media, enriched, pending }, error }
// Note: filters events by type="create" AND content_type="photo"
```

### Verification after implementation

Run the integration test suite to confirm all tests still pass:

```bash
cd /home/user/sitemgr/web && npm run test:integration -- media-lifecycle
```

Additionally, confirm `tenant-isolation.test.ts` has no `db.ts` imports:

```bash
grep -c "from.*lib/media/db" /home/user/sitemgr/web/__tests__/integration/tenant-isolation.test.ts
# Expected: 0
```

Confirm no raw `client.from("events")` assertion calls remain in `media-lifecycle.test.ts` (setup/teardown excluded):

```bash
grep "\.from(\"events\")" /home/user/sitemgr/web/__tests__/integration/media-lifecycle.test.ts
# Expected: only in afterAll cleanup block, not in test assertions
```