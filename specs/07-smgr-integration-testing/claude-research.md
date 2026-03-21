# Research: smgr Integration Testing

## Part 1: Codebase Research

### Existing Test Infrastructure

**Location:** `web/__tests__/integration/`

| File | Purpose | Lines |
|------|---------|-------|
| `setup.ts` | Shared helpers, seeding utilities | 286 |
| `globalSetup.ts` | Validates Supabase is running | 37 |
| `smgr-cli.test.ts` | CLI integration tests | 362 |
| `media-storage.test.ts` | S3 storage operations | 106 |
| `media-lifecycle.test.ts` | End-to-end media journey | 303 |
| `schema-contract.test.ts` | DB schema validation | — |
| `tenant-isolation.test.ts` | Multi-tenant RLS | — |

### setup.ts Helpers

**Supabase:**
- `getSupabaseConfig()` → URL, anonKey, serviceKey for local Supabase
- `getAdminClient()` → Supabase client with service role key (bypasses RLS)
- `createTestUser(email?)` → Creates auth user, returns `{ userId, client }`
- `cleanupTestData(userId)` → Deletes all user data in dependency order
- `cleanupUserData(admin, userId)` → Non-throwing cleanup with warnings

**S3/Storage:**
- `getS3Config()` → endpoint (`${SUPABASE_URL}/storage/v1/s3`), region, accessKeyId, secretAccessKey
- `TINY_JPEG` → Minimal valid JPEG buffer (22 bytes)

**Data Seeding:**
- `seedUserData(admin, userId, opts?)` → Creates complete test dataset with options:
  `eventCount`, `withEnrichments`, `withWatchedKeys`, `withBucketConfig`, `withConversation`, `withUserProfile`
- Returns `SeedResult` with arrays of IDs for cleanup
- Inserts in strict dependency order: profiles → events → enrichments → watched_keys → bucket_configs → conversations

### CLI Invocation Pattern (from smgr-cli.test.ts)

```typescript
const CLI_PATH = resolve(__dirname, "../../bin/smgr.ts");
const TSX_PATH = resolve(__dirname, "../../node_modules/.bin/tsx");

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runCli(args: string[], extraEnv: Record<string, string> = {}): Promise<CliResult>
```

- Uses `execFile` (promisified), spawns `tsx bin/smgr.ts <args>`
- Returns even on non-zero exit (doesn't throw)
- Timeout: 30 seconds
- Working directory: `/web`

**CLI Environment Setup:**
```typescript
function cliEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const cfg = getSupabaseConfig();
  return {
    ...process.env,
    NEXT_PUBLIC_SUPABASE_URL: cfg.url,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: cfg.anonKey,
    SUPABASE_SECRET_KEY: cfg.serviceKey,
    SMGR_USER_ID: userId,
    SMGR_DEVICE_ID: "test-cli",
    NODE_NO_WARNINGS: "1",
    ...extra,
  };
}
```

**Required env vars:** `SMGR_USER_ID` (UUID), `SMGR_DEVICE_ID`, Supabase config

### CLI Commands

| Command | Output | Key Flags |
|---------|--------|-----------|
| `query` | Table (default) or JSON | `--search Q`, `--type`, `--format json`, `--limit N`, `--offset N`, `--device D` |
| `show <id>` | JSON event + enrichment | — |
| `stats` | JSON stats | — |
| `enrich` | JSON result `{ enriched, failed, skipped, total }` | `--pending`, `--status`, `--dry-run`, `--concurrency N`, `<event_id>` |
| `watch` | Polls S3 for new objects | `--once`, `--interval N`, `--max-errors N` |
| `add <file>` | Upload file to S3 | `--prefix path/`, `--no-enrich` |

**Exit codes:** 0=success, 1=user error, 2=service error, 3=internal error

### Enrichment System

**File:** `web/lib/media/enrichment.ts`

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

async function enrichImage(imageBytes: Buffer, mimeType: string): Promise<EnrichmentResult>
async function batchEnrichImages(items: BatchEnrichmentItem[], options?: { concurrency?: number }): Promise<BatchEnrichmentResult>
```

- Currently hardcoded to Anthropic Claude Haiku (`claude-haiku-4-5-20251001`)
- Image validation: checks size, format, MIME type
- Skipped images return empty EnrichmentResult (no error thrown)

**DB functions (from `web/lib/media/db.ts`):**
- `queryEvents(opts)` → full-text search and filtering, returns `{ data, count, error }`
- `insertEvent(event)` → create new event record
- `insertEnrichment(eventId, result, userId?)` → save enrichment to DB
- `upsertWatchedKey(s3Key, eventId, etag, sizeBytes, userId?)` → tracks S3 files
- All functions return Supabase `{ data, error }` shape as-is

### Vitest Configuration

**File:** `web/vitest.config.ts`

```typescript
projects: [
  {
    name: "unit",
    exclude: ["__tests__/integration/**"],
  },
  {
    name: "integration",
    include: ["__tests__/integration/**/*.test.ts"],
    testTimeout: 60000,      // 60s per test
    hookTimeout: 30000,      // 30s for hooks
    globalSetup: ["__tests__/integration/globalSetup.ts"],
    fileParallelism: false,  // Sequential
  },
]
```

**Scripts:** `npm run test:integration` → `vitest run --project integration`

### CI Pipeline

**File:** `.github/workflows/ci.yml`

1. `supabase start` → local Postgres, Auth, Storage
2. Extract config via `supabase status -o json`
3. Create storage bucket
4. Configure: `SMGR_S3_ENDPOINT`, `SMGR_S3_BUCKET=media`, `SMGR_AUTO_ENRICH=false`
5. `npm run test:integration`
6. `supabase stop`

### Docker Compose

```yaml
services:
  minio:
    image: minio/minio:latest
    ports: ["9000:9000", "9001:9001"]
  smgr:
    depends_on: [minio-setup]
    environment:
      SMGR_S3_BUCKET: smgr-test
      SMGR_S3_ENDPOINT: http://minio:9000
      SMGR_AUTO_ENRICH: "false"
```

---

## Part 2: Web Research — Ollama Vision Models in CI

### Moondream Model

- Moondream 2 is a "tiny vision language model" (~1.8B params) that runs on CPU
- Requires Ollama 0.1.33+
- 2025-01 release (rev 2025-1-9) described as "incredibly good for its size"
- Supports bbox and gaze detection in addition to description
- Known issue: some versions return empty answers — test carefully

### Running Ollama in GitHub Actions

**Basic setup pattern:**
1. Install Ollama: `curl -fsSL https://ollama.com/install.sh | sh`
2. Start server: `ollama serve &` (background)
3. Wait for ready: `sleep 5` or poll health endpoint
4. Pull model: `ollama pull moondream` (or `llava`)
5. Run tests against `http://localhost:11434`

**Model caching:** Cache `~/.ollama/models/` between CI runs using `actions/cache`. Key on model name + version.

**Resource considerations:**
- Standard GitHub runners (2 CPU, 7GB RAM) can run moondream (~1.8B) on CPU
- For llava (~4B), may need larger runner or accept slower inference (~30-60s per image)
- GPU runners (actuated, self-hosted) dramatically faster but costly

### Ollama OpenAI-Compatible API for Vision

**Endpoint:** `http://localhost:11434/v1/chat/completions`

**Critical: Must use data URI format for images:**
```json
{
  "model": "moondream",
  "messages": [{
    "role": "user",
    "content": [
      { "type": "text", "text": "Describe this image" },
      { "type": "image_url", "url": "data:image/jpeg;base64,<BASE64>" }
    ]
  }]
}
```

Pure base64 without `data:image/...;base64,` prefix returns 400 error.

**Client setup (OpenAI SDK):**
```typescript
import OpenAI from "openai";
const client = new OpenAI({
  baseURL: "http://localhost:11434/v1/",
  apiKey: "ollama", // required but ignored
});
```

**Sources:**
- [Ollama OpenAI Compatibility Docs](https://docs.ollama.com/api/openai-compatibility)
- [Ollama Blog: OpenAI Compatibility](https://ollama.com/blog/openai-compatibility)
- [Moondream on Ollama](https://ollama.com/library/moondream)
- [Running Ollama in GitHub Actions (actuated)](https://actuated.com/blog/ollama-in-github-actions)

---

## Part 3: Web Research — Semantic Search Testing Strategies

### Golden Test Patterns for AI Output

**What golden tests are:** Curated sets of inputs with known-correct expected outputs that catch subtle degradation in AI pipelines. Unlike unit tests, they validate semantic correctness rather than exact matches.

**Sizing guidance:**
- Minimum viable: 50-100 examples (catch obvious failures)
- Production-ready: 200-500 examples
- For our case: 3 images with clear semantic distinctions is sufficient for pipeline validation (not model benchmarking)

### Evaluation Approaches

**Comparator stack (from simple to complex):**
1. **Exact-match** for deterministic fields (JSON structure, field presence)
2. **Structured-field diffs** for JSON outputs (check `objects` array, `tags`)
3. **Keyword/substring matching** — check if "fruit" or "pineapple" appears in description
4. **Embedding-based similarity** — cosine similarity on text embeddings (overkill for our case)
5. **LLM-as-judge** — use a model to evaluate another model's output (expensive)

### Making AI Tests Reliable (Not Flaky)

**Key strategies:**
1. **Use visually unambiguous fixtures** — a pineapple is clearly a fruit, not an animal
2. **Test broad semantic categories, not exact words** — search for "fruit" not "yellow tropical fruit"
3. **Use positive AND negative assertions** — "fruit" matches pineapple, "animal" does NOT
4. **Allow multiple correct answers** — the model might say "pineapple" or "tropical fruit" or "yellow fruit"
5. **Set generous thresholds** — if using similarity scores, use wide margins
6. **Pin the model version** — don't let `latest` tag change between runs

### Applying to Our Integration Test

Our test doesn't need sophisticated evaluation. We're testing the pipeline, not the model. Strategy:

1. **Structural validation:** enrichment result has `description`, `objects`, `tags` fields
2. **Keyword search assertions:** Postgres full-text search finds "fruit" in pineapple's enrichment
3. **Negative assertions:** Postgres full-text search does NOT find "animal" in pineapple's enrichment
4. **If flaky:** Use broader categories (food vs vehicle) or add retry with different search terms

**Sources:**
- [Golden Tests in AI (Shaped)](https://www.shaped.ai/blog/golden-tests-in-ai)
- [Building Golden Datasets (Maxim)](https://www.getmaxim.ai/articles/building-a-golden-dataset-for-ai-evaluation-a-step-by-step-guide/)
- [Evaluating AI with Golden Test Sets (Bloomreach)](https://www.bloomreach.com/en/blog/evaluating-ai-your-guide-to-using-golden-test-sets)
- [Semantic Search Evaluation (arXiv)](https://arxiv.org/html/2410.21549v1)

---

## Part 4: Testing Setup Summary

**Existing patterns to reuse:**
- `createTestUser()`, `cleanupUserData()` from setup.ts
- `getS3Config()`, `createS3Client()`, `uploadS3Object()`, `listS3Objects()` from setup.ts
- `runCli()` + `cliEnv()` pattern from smgr-cli.test.ts
- Vitest integration project config (60s timeout, sequential, globalSetup)

**New infrastructure needed:**
- Ollama service in CI (or docker-compose)
- Test fixture images (pineapple.jpg, dog.jpg, beach.jpg)
- User model config support in enrichment.ts (endpoint + model name override)
- Longer test timeout for enrichment steps (model inference on CPU)
