# RLS Policy Documentation

Row Level Security policies for all tables in sitemgr. Policies enforce tenant isolation using `user_id`-only authentication after the phone-to-user_id migration.

All policies use two performance optimizations:
- **`(SELECT auth.uid())`** wrapping — Postgres evaluates `auth.uid()` once per statement via initPlan caching, rather than once per row
- **`TO authenticated`** — Blocks anon-role connections entirely, preventing policy evaluation overhead for unauthenticated requests

## Tables

### events

| Policy | Operation | Expression |
|--------|-----------|------------|
| Users can view own events | SELECT | `USING ((SELECT auth.uid()) = user_id)` |
| Users can insert own events | INSERT | `WITH CHECK ((SELECT auth.uid()) = user_id)` |

**Auth model:** `user_id UUID NOT NULL` — references `auth.users(id)`. After migration, all events must have a user_id.

**Columns:** `id TEXT PK`, `timestamp TIMESTAMPTZ`, `device_id TEXT`, `type TEXT`, `content_type TEXT`, `content_hash TEXT`, `local_path TEXT`, `remote_path TEXT`, `metadata JSONB`, `parent_id TEXT`, `user_id UUID NOT NULL`, `bucket_config_id UUID`

### enrichments

| Policy | Operation | Expression |
|--------|-----------|------------|
| Users can view own enrichments | SELECT | `USING ((SELECT auth.uid()) = user_id)` |
| Users can manage own enrichments | ALL | `USING/WITH CHECK ((SELECT auth.uid()) = user_id)` |

**Auth model:** `user_id UUID NOT NULL`

**Columns:** `id UUID PK`, `event_id TEXT`, `description TEXT`, `objects TEXT[]`, `context TEXT`, `tags TEXT[]`, `fts TSVECTOR`, `user_id UUID NOT NULL`

### watched_keys

| Policy | Operation | Expression |
|--------|-----------|------------|
| Users can view own watched keys | SELECT | `USING ((SELECT auth.uid()) = user_id)` |
| Users can manage own watched keys | ALL | `USING/WITH CHECK ((SELECT auth.uid()) = user_id)` |

**Auth model:** `user_id UUID NOT NULL`

**Columns:** `s3_key TEXT`, `bucket_config_id UUID`, `event_id TEXT`, `etag TEXT`, `size_bytes BIGINT`, `user_id UUID NOT NULL`. Primary key: `(s3_key, bucket_config_id)`

### bucket_configs

| Policy | Operation | Expression |
|--------|-----------|------------|
| Users can view own bucket configs | SELECT | `USING ((SELECT auth.uid()) = user_id)` |
| Users can insert own bucket configs | INSERT | `WITH CHECK ((SELECT auth.uid()) = user_id)` |
| Users can update own bucket configs | UPDATE | `USING ((SELECT auth.uid()) = user_id)` |
| Users can delete own bucket configs | DELETE | `USING ((SELECT auth.uid()) = user_id)` |

**Auth model:** `user_id UUID NOT NULL`. `phone_number` column dropped after migration.

**Columns:** `id UUID PK`, `user_id UUID NOT NULL`, `bucket_name TEXT`, `region TEXT`, `endpoint_url TEXT`, `access_key_id TEXT`, `secret_access_key TEXT` (encrypted), `encryption_key_version TEXT`, `last_synced_key TEXT`, `created_at TIMESTAMPTZ`

**Unique constraint:** `(user_id, bucket_name)`

### conversations

| Policy | Operation | Expression |
|--------|-----------|------------|
| Users can view own conversations | SELECT | `USING ((SELECT auth.uid()) = user_id)` |
| Users can manage own conversations | ALL | `USING/WITH CHECK ((SELECT auth.uid()) = user_id)` |

**Auth model:** `user_id UUID NOT NULL` (primary key after migration). `phone_number` retained as a display column for WhatsApp but is no longer used for auth.

**Columns:** `user_id UUID PK`, `phone_number TEXT`, `history JSONB`, `updated_at TIMESTAMPTZ`

### user_profiles

| Policy | Operation | Expression |
|--------|-----------|------------|
| Users can view own profile | SELECT | `USING (auth.uid() = id)` |
| Users can update own profile | UPDATE | `USING (auth.uid() = id)` |
| Users can insert own profile | INSERT | `WITH CHECK (auth.uid() = id)` |

**Note:** These policies do not use `(SELECT auth.uid())` wrapping or `TO authenticated` restriction — they predate the optimization pass and use the direct `auth.uid() = id` pattern. Since `user_profiles` is a low-volume table (one row per user), the performance impact is negligible.

**Columns:** `id UUID PK` (references `auth.users`), `phone_number TEXT UNIQUE`, `display_name TEXT`, `created_at TIMESTAMPTZ`

## Client Key Usage

### `getAdminClient()` — Service Role (bypasses RLS)

Used by server-side code that operates across tenants or performs background work:
- `resolveUserId()` — Looks up `user_profiles` to map phone numbers to user IDs
- `addBucket()` / `listBuckets()` / `removeBucket()` / `getBucketConfig()` — Bucket management via WhatsApp (admin client needed because the WhatsApp webhook doesn't have a Supabase auth session)
- `getConversationHistory()` / `saveConversationHistory()` — WhatsApp conversation persistence
- `indexBucket()` — Background S3 indexing and enrichment pipeline
- Health check endpoint (`/api/health`)

### `getUserClient()` — Publishable Key (RLS enforced)

Used by code paths where Supabase auth context is available:
- `queryEvents()` — User-facing event queries
- `showEvent()` — Single event retrieval
- `getStats()` / `getEnrichStatus()` — Dashboard statistics
- `findEventByHash()` — Deduplication check

## RPC Function Security

### search_events(p_user_id UUID, ...)

- **Security:** SECURITY INVOKER (default)
- **Isolation:** Filters by `e.user_id = p_user_id` in the query body
- **Parameters:** `p_user_id UUID`, `query_text TEXT`, `content_type_filter TEXT`, `since_filter TEXT`, `until_filter TEXT`, `result_limit INT`
- **Language:** SQL STABLE

### stats_by_content_type(p_user_id UUID)

- **Security:** SECURITY INVOKER
- **Isolation:** Filters by `user_id = p_user_id`
- **Returns:** `TABLE(content_type TEXT, count BIGINT)`

### stats_by_event_type(p_user_id UUID)

- **Security:** SECURITY INVOKER
- **Isolation:** Filters by `user_id = p_user_id`
- **Returns:** `TABLE(type TEXT, count BIGINT)`

### get_user_id_from_phone(TEXT)

- **Security:** SECURITY INVOKER
- **Access restriction:** `REVOKE EXECUTE FROM PUBLIC, anon, authenticated; GRANT EXECUTE TO service_role`
- Only callable by admin/service-role connections

## Index Coverage

Indexes supporting RLS policy evaluation:

| Table | Index | Supports |
|-------|-------|----------|
| events | `idx_events_user_id` | RLS policy on `user_id` |
| bucket_configs | `bucket_configs_user_id_bucket_name_key` (unique) | RLS policy + unique constraint |
| watched_keys | `idx_watched_keys_user_id` | RLS policy on `user_id` |
| enrichments | `idx_enrichments_user_id` | RLS policy on `user_id` |
| conversations | Primary key on `user_id` | RLS policy |
| user_profiles | Primary key on `id` | RLS policy |

## Testing

The RLS test suite is in `web/__tests__/rls-policies.test.ts` (22 tests, integration, requires local Supabase).

Tests verify:
- **Cross-tenant isolation:** User A cannot see User B's records
- **Anon blocking:** Anonymous connections are rejected
- **Insert restrictions:** Users can only insert records with their own `user_id`
- **NULL safety:** NULL `user_id` records are inaccessible
- **SECURITY DEFINER restrictions:** `get_user_id_from_phone` only callable by service_role

Additional RPC isolation tests in `web/__tests__/rpc-user-isolation.test.ts` (6 tests).
