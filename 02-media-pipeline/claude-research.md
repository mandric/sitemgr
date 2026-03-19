# Research Findings — 02-media-pipeline

## Part 1: Codebase Research

### 1. PROJECT STRUCTURE & OVERVIEW

**sitemgr** is a cloud-based media management system that:
- Watches S3-compatible buckets for new photos/videos
- Enriches media with Claude AI vision descriptions
- Indexes content in Postgres with full-text search
- Exposes queries via WhatsApp bot, CLI, and web UI

**Tech Stack:**
- **Frontend**: Next.js 15, React 19, Tailwind CSS, Radix UI
- **Backend**: Next.js API routes (Vercel), Supabase PostgREST
- **Database**: Supabase Postgres (cloud-based, not local-first)
- **Storage**: Supabase Storage (S3-compatible)
- **Auth**: Supabase Auth (email/password)
- **LLM**: Anthropic Claude (Haiku for enrichment, Sonnet for agent)
- **Messaging**: Twilio WhatsApp Business API
- **CLI**: TypeScript with tsx runner
- **Testing**: Vitest (unit/integration), Playwright (E2E)

**Project Organization:**
```
web/                    # Main Next.js application
├── lib/
│   ├── media/          # Media pipeline (S3, enrichment, DB)
│   ├── crypto/         # Encryption (AES-256-GCM)
│   ├── agent/          # Claude agent logic
│   └── supabase/       # DB client helpers
├── __tests__/          # Vitest unit/integration tests (2583 lines)
├── app/
│   ├── api/            # API routes (WhatsApp, health, media)
│   ├── auth/           # Auth pages (login, signup, password reset)
│   ├── buckets/        # S3 bucket configuration UI
│   ├── profile/        # User profile page
│   └── media/          # Media gallery/search UI
└── bin/                # CLI tool (smgr.ts)

supabase/
├── migrations/         # 12 migration files (schema, RLS, RPC)
└── config.toml        # Supabase CLI config

docs/                   # Documentation
01-data-foundation/     # Database schema and encryption (fully implemented)
02-media-pipeline/      # S3 watching, enrichment (fully implemented)
03-agent-messaging/     # Agent core, WhatsApp (fully implemented)
04-web-application/     # UI (partially implemented)
05-cli/                 # Command-line tool (mostly implemented)
```

---

### 2. MEDIA PIPELINE FILES & ARCHITECTURE

#### **2.1 Core Media Library** (`web/lib/media/`)

**Key Files:**
- `s3.ts` (150 lines) - S3 client operations
- `enrichment.ts` (72 lines) - Claude vision API integration
- `db.ts` (331 lines) - Database operations and search interface
- `utils.ts` (61 lines) - Pure utility functions for media handling
- `constants.ts` (29 lines) - Shared constants
- `index.ts` (6 lines) - Barrel export

**`s3.ts` — S3 Client Operations**

Core Functions:
- `createS3Client(config)` - Creates AWS SDK client with optional custom endpoint + path-style URLs (required for Supabase/MinIO)
- `listS3Objects(client, bucket, prefix)` - Lists objects with v2→v1 API fallback; implements pagination with ContinuationToken (v2) and Marker (v1)
- `downloadS3Object(client, bucket, key)` - Downloads object as Buffer
- `uploadS3Object(client, bucket, key, body, contentType)` - Uploads with optional Content-Type

Interfaces:
```typescript
interface S3Object {
  key: string;
  size: number;
  etag: string;
  lastModified: string;
}

interface S3Config {
  endpoint?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}
```

Key Design Patterns:
- **Multi-provider support**: Uses `forcePathStyle: true` for non-AWS providers
- **V2→V1 fallback**: Gracefully falls back to ListObjectsV1 for Supabase Storage/MinIO
- **ETag normalization**: Strips quotes from ETags (`replace(/"/g, "")`)
- **Error discrimination**: Checks error message for "not implemented"/"unsupported"/"404"

**`enrichment.ts` — Claude Vision Enrichment**

```typescript
interface EnrichmentResult {
  description: string;
  objects: string[];
  context: string;
  suggested_tags: string[];
  provider: string;
  model: string;
  raw_response: string;
}
```

Core Function:
```typescript
export async function enrichImage(
  imageBytes: Buffer,
  mimeType: string
): Promise<EnrichmentResult>
```

Implementation Details:
- Uses `claude-haiku-4-5-20251001` model (cost-effective for vision)
- Accepts both `image/jpeg` and `image/jpg` MIME types (normalizes to `image/jpeg`)
- Encodes image as base64
- Sends structured JSON prompt to get deterministic output
- Parses JSON response, strips markdown fences if present
- Returns all fields: description, objects, context, suggested_tags + provider/model metadata

**`db.ts` — Database Operations & Search Interface**

Two Client Constructors (with RLS support):
```typescript
getAdminClient()     // Uses SUPABASE_SECRET_KEY (service role, bypasses RLS)
getUserClient()      // Uses NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (respects RLS)
```

Core Query Operations:
1. **Search (`queryEvents`)** - Full-text search via RPC (`search_events`)
2. **Show Event (`showEvent`)** - Fetch single event with enrichments
3. **Stats (`getStats`)** - Database statistics via RPC
4. **Enrichment Status (`getEnrichStatus`)** - Count pending enrichments

Write Operations (Admin-only):
1. **Insert Event (`insertEvent`)** - Create event record
2. **Insert Enrichment (`insertEnrichment`)** - Store AI enrichment results
3. **Upsert Watched Key (`upsertWatchedKey`)** - Track S3 objects to avoid re-processing
4. **Get Watched Keys (`getWatchedKeys`)** - Returns Set<string> of processed keys
5. **Find Event by Hash (`findEventByHash`)** - Deduplication check
6. **Get Pending Enrichments (`getPendingEnrichments`)** - For batch enrichment

---

### 3. DATABASE SCHEMA & DATA MODEL

**events** Table:
```sql
id              TEXT PRIMARY KEY           -- ULID or truncated UUID
timestamp       TIMESTAMPTZ NOT NULL       -- Chronological sort key
device_id       TEXT NOT NULL              -- Source device identifier
type            TEXT NOT NULL              -- "create", "enrich", "enrich_failed", etc.
content_type    TEXT                       -- "photo", "video", "audio", "file"
content_hash    TEXT                       -- "sha256:{hex}" content-addressed blob
local_path      TEXT                       -- Original file path
remote_path     TEXT                       -- S3 URI (s3://bucket/key)
metadata        JSONB                      -- S3 metadata, MIME type, size
parent_id       TEXT FK → events(id)       -- Update/delete chains
bucket_config_id TEXT FK → bucket_configs  -- Which bucket this came from
user_id         UUID NOT NULL FK → auth.users
```

**enrichments** Table:
```sql
event_id    TEXT PRIMARY KEY FK → events(id)
description TEXT                           -- "A photo of..."
objects     TEXT[]                         -- ["person", "dog", "park"]
context     TEXT                           -- "outdoor recreation"
tags        TEXT[]                         -- ["travel", "friends"]
fts         TSVECTOR GENERATED ALWAYS     -- Full-text search index
user_id     UUID NOT NULL FK → auth.users
```

FTS GIN Index (weighted): Description (A) > Context (B) > Tags & Objects (C)

**watched_keys** Table:
```sql
s3_key      TEXT NOT NULL
bucket_config_id TEXT NOT NULL
first_seen  TIMESTAMPTZ NOT NULL
event_id    TEXT FK → events(id)
etag        TEXT
size_bytes  BIGINT
user_id     UUID NOT NULL FK → auth.users
PRIMARY KEY: (s3_key, bucket_config_id)
```

**bucket_configs** Table:
```sql
id                          TEXT PRIMARY KEY
user_id                     UUID NOT NULL FK → auth.users
bucket_name                 TEXT NOT NULL
endpoint_url                TEXT
region                      TEXT
access_key_id               TEXT
secret_access_key           TEXT                -- Encrypted with versioned key
encryption_key_version      INT
created_at                  TIMESTAMPTZ
last_synced_key             TEXT
UNIQUE (user_id, bucket_name)
```

#### Full-Text Search RPC Function

```sql
CREATE FUNCTION search_events(
    p_user_id UUID,
    query_text TEXT,
    content_type_filter TEXT DEFAULT NULL,
    since_filter TEXT DEFAULT NULL,
    until_filter TEXT DEFAULT NULL,
    result_limit INT DEFAULT 20
) RETURNS TABLE(...)
```

Uses `plainto_tsquery('english', query_text)` against GIN-indexed `enrichments.fts`, ranks by `ts_rank()`.

---

### 4. ENCRYPTION & KEY ROTATION

- AES-256-GCM encryption for S3 secret keys at rest
- Labeled ciphertext format: `{label}:{base64}` where label ∈ {previous, current, next}
- Lazy migration on access: if ciphertext != current label, re-encrypt transparently
- Environment variables: `ENCRYPTION_KEY_CURRENT` (required), `_PREVIOUS`, `_NEXT` (optional)

---

### 5. TESTING STRATEGY & PATTERNS

**Framework:** Vitest (unit/integration), Playwright (E2E)

**Test Configuration:**
- `vitest.config.ts` - Environment: node, excludes E2E/RLS/migration tests
- `vitest.integration.config.ts` - Includes RLS + RPC tests, 30s timeout

**Run Commands:**
```bash
npm test                    # Unit/integration
npm test:integration       # RLS + RPC isolation tests
npm test:e2e               # Playwright browser tests
```

**Mock Setup Pattern:** (`helpers/agent-test-setup.ts`)
- Mocks Supabase client chains (from→eq→maybeSingle, etc.)
- Uses `vi.stubEnv()` for encryption keys (fixture values, not real secrets)
- Mock S3 send via `mockS3Send`

**Key Test Files:**
- `s3-actions.test.ts` (443 lines) - S3 integration tests
- `media-utils.test.ts` (144 lines) - Content type detection
- `encryption*.test.ts` - Encryption/key rotation tests
- `rls-policies.test.ts` - Row Level Security (22 tests)
- `rpc-user-isolation.test.ts` - RPC function isolation (6 tests)

**Key Dependencies:**
```json
{
  "@anthropic-ai/sdk": "^0.78.0",
  "@aws-sdk/client-s3": "^3.700.0",
  "@supabase/supabase-js": "latest",
  "vitest": "^4.0.18",
  "@playwright/test": "^1.58.2"
}
```

---

### 6. KEY DESIGN PATTERNS

1. **Discriminated unions** for result types (`{ ok: true; client } | { ok: false; errorJson }`)
2. **Fire-and-forget** for non-blocking background work (`void (async () => { ... })()`)
3. **RLS everywhere** with `(SELECT auth.uid()) = user_id` pattern
4. **Console logging** (no structured logging library)
5. **Content-addressed blobs** with SHA-256 (`sha256:{hex}` format)
6. **ULID event IDs** with monotonic factory

---

## Part 2: Web Research

### Topic 1: S3 Multi-Provider Patterns

#### Path-Style vs Virtual-Hosted-Style URLs

- **AWS deprecation**: AWS deprecated path-style access for new S3 buckets (Sep 2023), but virtual-hosted-style is the default
- **MinIO**: Supports both, but path-style is recommended for custom deployments
- **Supabase Storage**: S3 compatibility layer uses path-style only
- **AWS SDK v3**: Use `forcePathStyle: true` in S3Client config for non-AWS providers

**Best Practice:** The codebase already uses `forcePathStyle: true` when a custom endpoint is configured — this is the correct approach.

#### ListObjectsV2 vs ListObjects Fallback

- **ListObjectsV2** is the modern API with `ContinuationToken` pagination (preferred)
- **ListObjects (v1)** uses `Marker`-based pagination (required for some providers)
- **Supabase Storage**: Supports ListObjectsV2 as of recent updates, but older versions require v1 fallback
- **MinIO**: Full ListObjectsV2 support
- **Cloudflare R2**: Full ListObjectsV2 support

**Best Practice:** The v2→v1 fallback pattern in `s3.ts` is the right approach. Error detection via message string matching ("not implemented"/"unsupported") is pragmatic.

#### Supabase Storage S3 Compatibility

Supported operations: ListBuckets, HeadBucket, CreateBucket, DeleteBucket, GetBucketLocation, HeadObject, GetObject, PutObject, CopyObject, DeleteObject, ListObjectsV2, ListObjects, CreateMultipartUpload, UploadPart, CompleteMultipartUpload, AbortMultipartUpload, ListParts.

Key limitation: Must use path-style URLs; virtual-hosted-style not supported.

---

### Topic 2: Claude Vision API Batch Processing

#### API Capabilities

- **Supported image formats**: JPEG, PNG, GIF, WebP
- **Max image size**: 20MB per image
- **Max images per request**: 20 images in a single message
- **Resolution**: Images automatically resized if needed; optimal under 1568px on longest side
- **Base64 vs URL**: Base64 is the primary method; URL-based requires publicly accessible images

#### Batch Processing API

Anthropic offers a dedicated **Batch API** for high-volume processing:
- Submit up to 100,000 requests per batch
- **50% cost reduction** compared to standard API
- 24-hour processing window
- Results retrieved via polling or webhook

#### Rate Limits & Retry Strategy

Rate limits vary by tier (from Anthropic docs):
- **Tier 1**: 50 RPM, 40K input TPM, 8K output TPM
- **Tier 2**: 1,000 RPM, 80K input TPM, 16K output TPM
- **Tier 3**: 2,000 RPM, 160K input TPM, 32K output TPM
- **Tier 4**: 4,000 RPM, 400K input TPM, 80K output TPM

Response headers: `anthropic-ratelimit-requests-limit`, `anthropic-ratelimit-requests-remaining`, `anthropic-ratelimit-requests-reset`, `retry-after`

**Recommended retry strategy**: Exponential backoff with jitter. Check `retry-after` header on 429 responses.

#### Cost Optimization

- **Model selection**: Claude Haiku is the most cost-effective for vision tasks (already used in codebase)
- **Image optimization**: Resize images before sending to reduce token consumption. Images >1568px are auto-resized, consuming more tokens for the original processing
- **Batch API**: Use for non-real-time processing (50% cost savings)
- **Prompt engineering**: Keep prompts concise; structured JSON output minimizes wasted tokens

#### Error Handling

- **Overloaded errors (529)**: Temporary server overload, retry with backoff
- **Rate limit errors (429)**: Check `retry-after` header
- **Invalid image errors**: Validate image format/size before API call
- **JSON parse failures**: The codebase's markdown fence stripping is a good pattern

---

### Topic 3: PostgreSQL Full-Text Search Optimization

#### Weighted Search with setweight() and ts_rank_cd()

The codebase uses generated columns with weighted tsvector:
```sql
fts TSVECTOR GENERATED ALWAYS AS (
  setweight(to_tsvector('english', coalesce(description, '')), 'A') ||
  setweight(to_tsvector('english', coalesce(context, '')), 'B') ||
  setweight(to_tsvector('english', immutable_array_to_string(coalesce(tags, '{}'), ' ')), 'C') ||
  setweight(to_tsvector('english', immutable_array_to_string(coalesce(objects, '{}'), ' ')), 'C')
) STORED
```

**Best practice**: `ts_rank_cd()` (cover density) gives better results than `ts_rank()` for phrase queries. The codebase uses `ts_rank()` which is simpler but adequate.

#### GIN Index Performance

- **GIN indexes** are optimized for containment queries (`@@` operator)
- Index build is slower than GiST but query performance is faster
- Ideal for read-heavy workloads (which this is — writes are batch, reads are user queries)
- `gin_pending_list_limit` controls the pending list size for fast inserts

#### Generated Column vs Trigger

The codebase uses **GENERATED ALWAYS AS ... STORED** — this is the recommended approach:
- Automatically maintained by PostgreSQL
- Cannot become stale (unlike trigger-based approaches)
- Requires IMMUTABLE functions in the expression

#### Immutable Function Requirement

The `immutable_array_to_string()` function exists because PostgreSQL requires all functions in GENERATED column expressions to be IMMUTABLE. The built-in `array_to_string()` is only STABLE (not IMMUTABLE), so a wrapper was created:

```sql
CREATE OR REPLACE FUNCTION immutable_array_to_string(arr TEXT[], sep TEXT)
RETURNS TEXT LANGUAGE SQL IMMUTABLE AS $$
  SELECT array_to_string(arr, sep);
$$;
```

This is the correct pattern.

#### Combining FTS with Other Filters

**Best practice for composite queries** (FTS + date range + content type):
- Use a GIN index on the tsvector column (already done)
- Add B-tree indexes on frequently filtered columns (timestamp, content_type)
- PostgreSQL's query planner will combine bitmap scans from multiple indexes
- For very selective filters (specific date + type), the B-tree index may be used alone

The existing index set (GIN on `fts`, B-tree on `timestamp`, `content_type`, etc.) is well-designed for this pattern.
