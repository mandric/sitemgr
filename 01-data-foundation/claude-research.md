# Research Findings — 01-data-foundation

## Part 1: Codebase Research

### Project Structure

The sitemgr codebase is organized into **5 modular splits**:

- **01-data-foundation** — Database schema, encryption, auth, RLS, migrations (Fully implemented)
- **02-media-pipeline** — S3 watching, media enrichment, FTS indexing (Fully implemented)
- **03-agent-messaging** — Agent core, WhatsApp bot, conversation management (Mostly complete)
- **04-web-application** — Next.js UI with auth, bucket config, chat (Partially complete)
- **05-cli** — Command-line tool `smgr` (Mostly complete)

```
/home/user/sitemgr/
├── supabase/migrations/     # 8 migration files
├── web/
│   ├── lib/crypto/          # Encryption implementations
│   ├── lib/supabase/        # Supabase client setup
│   ├── lib/media/           # S3, database, enrichment operations
│   ├── lib/agent/           # Agent core logic
│   ├── app/                 # Next.js App Router
│   ├── __tests__/           # Vitest unit/integration tests
│   ├── e2e/                 # Playwright E2E tests
│   └── bin/                 # CLI entry point (smgr)
├── docs/                    # ENV_VARS.md, TESTING.md, etc.
└── 01-data-foundation/ through 05-cli/  # Split spec files
```

### Database Schema

8 migration files in `supabase/migrations/`:

| File | Purpose |
|------|---------|
| `20260305000000_initial_schema.sql` | Core tables: events, enrichments, watched_keys, conversations, storage bucket |
| `20260305000001_rpc_functions.sql` | RPC: search_events, stats_by_content_type, stats_by_event_type |
| `20260306000000_fix_enrichments_fts.sql` | Fix FTS issues, re-create RPC with quoted reserved words |
| `20260306000001_bucket_configs.sql` | Bucket configurations table for S3 credentials |
| `20260306000002_add_user_id_to_bucket_configs.sql` | Add user_id column for web auth |
| `20260306000003_migrate_to_user_id.sql` | Add user_profiles table, migrate to user_id |
| `20260306000005_add_rls_policies.sql` | Enable RLS on all tables |
| `20260312000000_add_encryption_key_version.sql` | Add encryption_key_version for key rotation |

#### Key Tables

**events** — Immutable append-only log with TEXT PRIMARY KEY (ULID-style), event types (create/sync/enrich/enrich_failed/delete/publish), content types (photo/video/audio/note/bookmark), SHA-256 content_hash, parent_id for event chains, bucket_config_id and user_id foreign keys. Indexed on type, content_type, content_hash, timestamp, device_id, remote_path, parent_id, bucket_config_id, user_id.

**enrichments** — AI-generated metadata with event_id PRIMARY KEY, description, objects[], context, tags[], and a GENERATED tsvector with weighted search (A: description, B: context, C: tags+objects). GIN index on fts.

**watched_keys** — S3 sync tracking with s3_key PRIMARY KEY, event_id, etag, bucket_config_id, user_id.

**bucket_configs** — Per-user S3 credentials with UUID PRIMARY KEY, encrypted secret_access_key (AES-GCM), encryption_key_version, unique constraints on (phone_number, bucket_name) and (user_id, bucket_name).

**conversations** — WhatsApp chat history with phone_number PRIMARY KEY, user_id, JSONB history.

**user_profiles** — Phone-to-user mapping with id referencing auth.users, unique phone_number.

#### RLS Policies

All tables have RLS enabled with dual auth model:
- Web: `auth.uid() = user_id`
- WhatsApp: `phone_number = auth.jwt()->>'phone'` (fallback for NULL user_id)

#### RPC Functions

- `search_events(query_text, content_type_filter, since_filter, until_filter, result_limit)` — FTS with ts_rank ranking
- `stats_by_content_type()` / `stats_by_event_type()` — Aggregate counts
- `get_user_id_from_phone(p_phone_number)` — Phone→user_id mapping

### Encryption System

**Base layer** (`web/lib/crypto/encryption.ts`):
- AES-256-GCM via Web Crypto API (crypto.subtle)
- Key derivation: SHA-256(env var) → 256-bit key
- Format: base64(12-byte IV || ciphertext || auth_tag)
- Random IV per encryption (GCM standard)

**Versioned layer** (`web/lib/crypto/encryption-versioned.ts`):
- Status-based keys: ENCRYPTION_KEY_CURRENT / _PREVIOUS / _NEXT
- Label-prefixed format: `current:base64ciphertext`
- Legacy format (no prefix) assumed "previous"
- `needsMigration()` — true if not encrypted with CURRENT key
- Lazy migration: re-encrypt on access, non-blocking background update

**Key rotation**: Add NEXT → Validate → Promote NEXT→CURRENT (save old as PREVIOUS) → Deploy → Monitor lazy migration → Remove PREVIOUS

### Supabase Client Setup

Three client implementations:
- **Browser** (`client.ts`): `createBrowserClient` with public anon key
- **Server** (`server.ts`): `createServerClient` with cookie-based auth, new client per request
- **Middleware** (`proxy.ts`): Session validation, redirect unauthenticated to /auth/login
- **Admin** (`lib/media/db.ts`): `getSupabaseClient()` with service key fallback

### Testing Setup

**Framework**: Vitest (globals, node environment, path aliases)

**Scripts**: `npm run test` (vitest run), `npm run test:watch`, `npm run test:e2e` (Playwright)

**Core testing pattern**: `vi.stubEnv()` with fixture values, never production secrets.

```typescript
beforeEach(() => {
  vi.stubEnv("ENCRYPTION_KEY_CURRENT", "test-fixture-key");
});
afterEach(() => { vi.unstubAllEnvs(); });
```

**Mocking**: `vi.mock()` for modules, shared helpers in `__tests__/helpers/agent-test-setup.ts` with `mockFrom`, `mockS3Send`, `mockBucketLookup`, `mockBucketInsertCapture`.

**Test files**:
| File | Coverage |
|------|----------|
| `encryption.test.ts` | Base AES-GCM roundtrip, key derivation, random IVs, error handling |
| `encryption-versioned.test.ts` | Multi-key encryption, legacy format, migration detection |
| `encryption-lifecycle.test.ts` | Full roundtrip: encrypt → store → retrieve → decrypt |
| `agent-core.test.ts` | Agent message handling, API key validation |
| `s3-actions.test.ts` | S3 bucket operations with mocked encryption |
| `media-utils.test.ts` | Content type detection, event ID generation, hashing |
| `whatsapp-route.test.ts` | WhatsApp webhook handler |

### Dependencies

Key packages: `@supabase/supabase-js`, `@supabase/ssr`, `@aws-sdk/client-s3`, `@anthropic-ai/sdk`, `vitest`, `@playwright/test`, `typescript ^5`, `tsx`.

No external crypto library — uses built-in `crypto.subtle` (Web Crypto API).

### TypeScript Conventions

- Target ES2017, strict mode, path alias `@/*`
- Named exports (no default exports)
- Async functions throw (no try/catch in library code)
- Environment vars validated at function entry with `.trim()` / `.replace(/\s+/g, "")`
- Types: `EventRow`, `EnrichmentResult`, `QueryOptions` interfaces

---

## Part 2: Web Research

### 1. PostgreSQL Row Level Security (RLS) Best Practices

#### Performance Optimization

- **Index columns used in RLS policies**: For policies like `auth.uid() = user_id`, add a btree index on `user_id`. Improvements of over 100x on large tables. Missing indexes are the #1 performance killer.

- **Wrap functions in SELECT for caching**: Instead of `auth.uid() = user_id`, use `(SELECT auth.uid()) = user_id`. This creates an `initPlan` that caches the result per-statement rather than calling the function per-row.

- **Optimize joins in policies**: `team_id in (select team_id from team_user where user_id = auth.uid())` is much faster than the reverse join direction. Consider moving join queries to security definer functions.

- **Add client-side filters alongside RLS**: Always add `.eq('user_id', userId)` even with RLS — helps the query planner use indexes effectively.

- **Use the TO clause**: `TO authenticated` prevents policies from running for anon users. Never rely solely on `auth.uid()` to rule out anon role.

#### Common Pitfalls

- `LIMIT`/`OFFSET` queries must scan all rows for ordering, compounding RLS cost
- Non-LEAKPROOF functions in RLS policies **prevent index usage** — catastrophic for FTS
- Multiple RLS policies on same table are AND-combined, increasing evaluation cost
- Functions used in RLS can be called from the API — secure them in alternate schemas

#### Supabase-Specific Patterns

- Enable RLS on **every table** in public schema
- Never use `service_role` key in frontend
- Use Supabase's built-in Security Advisor and Performance Advisor
- Use `.explain()` modifier on Supabase client for query analysis

**Sources:**
- [Supabase RLS Performance and Best Practices](https://supabase.com/docs/guides/troubleshooting/rls-performance-and-best-practices-Z5Jjwv)
- [Supabase RLS Best Practices (MakerKit)](https://makerkit.dev/blog/tutorials/supabase-rls-best-practices)
- [GitHub Discussion #14576](https://github.com/orgs/supabase/discussions/14576)
- [Optimizing RLS Performance (AntStack)](https://medium.com/@antstack/optimizing-rls-performance-with-supabase-postgres-fa4e2b6e196d)
- [Common Postgres RLS Footguns (Bytebase)](https://www.bytebase.com/blog/postgres-row-level-security-footguns/)

### 2. AES-GCM Key Rotation Patterns

#### Zero-Downtime Rotation Strategy

The sitemgr approach (label-prefixed ciphertext with status-based keys) aligns with industry best practices:
- Tag each ciphertext with its key identifier (e.g., `current:base64...`)
- Maintain multiple active decryption keys during rotation window
- Re-encrypt lazily on read (non-blocking background update)

#### IV/Nonce Safety

- AES-GCM requires unique IV per encryption per key (96-bit recommended)
- After 2^48 messages with same key, 50% chance of IV collision
- NIST recommends max 2^32 messages per key for safety
- Random IVs are standard; no counter-mode needed for moderate volumes

#### Key Wear-Out

- AES keys vulnerable after ~4GB of data encrypted with single key
- Envelope encryption (Cloud KMS) reduces this risk by using data encryption keys (DEKs) wrapped by key encryption keys (KEKs)
- For sitemgr's use case (encrypting S3 secret keys, not bulk data), wear-out is not a concern — volume is extremely low

#### Web Crypto API in Node.js

- `crypto.subtle` is available natively in Node.js (no external packages needed)
- Same API works in browser and server
- Key import via `crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt', 'decrypt'])`

**Sources:**
- [Node.js Web Crypto API Documentation](https://nodejs.org/api/webcrypto.html)
- [MDN AesGcmParams](https://developer.mozilla.org/en-US/docs/Web/API/AesGcmParams)
- [CipherStash: Encryption in TypeScript Backends](https://cipherstash.com/blog/encryption-in-use-3-ways-to-protect-sensitive-data-in-typescript-backends)

### 3. Supabase Event Store / Append-Only Log Patterns

#### Event Store Design in PostgreSQL

- Single unified events table (not per-aggregate tables) with JSONB payload provides flexibility
- Append-only semantics: no UPDATE/DELETE (enforced via RLS policies or triggers)
- Optimistic locking via CTE-based guards checking expected max sequence

#### ULID vs UUID for Ordering

- **ULIDs** are preferable for event stores: lexicographically sortable by time, monotonically increasing within same millisecond
- UUID v7 (time-ordered) is an alternative but less compact than ULID
- sitemgr uses TEXT PRIMARY KEY with ULID-style IDs — good choice for ordering and B-tree index locality

#### Content Hashing for Deduplication

- SHA-256 content hash enables deduplication and content-addressed storage
- Index on `content_hash` allows fast duplicate detection via `findEventByHash()`
- Consider partial indexes if only certain event types need dedup checks

#### Trade-offs

- No built-in event sourcing framework in Supabase — manual implementation required
- Supabase real-time subscriptions can provide change feeds, but not a full event bus
- For high-volume event stores, consider partitioning by time range

**Sources:**
- [PostgreSQL Event Sourcing Patterns](https://gist.github.com/rjz/15baffeab434b8125ca4d783f4116d81)
- [Event Store Schema Design (various)](https://dev.to/search?q=event+sourcing+postgresql)

### 4. PostgreSQL Full-Text Search with tsvector

#### tsvector Column Strategies

Two approaches:
1. **Generated columns** (recommended, used by sitemgr): `GENERATED ALWAYS AS (setweight(...) || setweight(...)) STORED` — automatic, no triggers needed
2. **Trigger-maintained columns**: More flexible but requires manual trigger management

sitemgr uses approach #1 with weighted search:
- Weight A: description (highest priority)
- Weight B: context
- Weight C: tags + objects (lowest priority)

#### GIN Index Best Practices

- Always create GIN index on tsvector column: `CREATE INDEX ... USING GIN (fts)`
- For write-heavy workloads: `WITH (fastupdate = on, gin_pending_list_limit = 4096)`
- Monitor with `pg_stat_user_indexes` for fragmentation
- Periodic `REINDEX INDEX CONCURRENTLY` for maintenance

#### Combining FTS with RLS

**Critical gotcha**: Non-LEAKPROOF functions in RLS policies can prevent PostgreSQL from using GIN indexes for FTS queries. This can turn fast index lookups into full table scans.

**Mitigation**:
- Mark RLS policy functions as LEAKPROOF where possible
- Wrap `auth.uid()` in `(SELECT auth.uid())` for initPlan caching
- Always add explicit user_id filters in application queries alongside RLS
- Use `EXPLAIN ANALYZE` to verify GIN index is being used

#### Performance Tuning

- Use `ts_rank()` for relevance ranking (sitemgr does this)
- `ts_headline()` for highlighted snippets (not currently used by sitemgr)
- Pagination via `result_limit` parameter (sitemgr uses this)
- Consider partial indexes for specific content types if query patterns warrant it

**Sources:**
- [PostgreSQL Documentation: Text Search Types](https://www.postgresql.org/docs/current/datatype-textsearch.html)
- [Speeding Up PG FTS with Persistent TSVectors](https://danielabaron.me/blog/speed-up-pg-fts-with-persistent-ts-vectors/)
- [Supabase Row Level Security Docs](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Common Postgres RLS Footguns](https://www.bytebase.com/blog/postgres-row-level-security-footguns/)
- [PostgreSQL FTS as Elasticsearch Alternative](https://iniakunhuda.medium.com/postgresql-full-text-search-a-powerful-alternative-to-elasticsearch-for-small-to-medium-d9524e001fe0)
