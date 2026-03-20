# Implementation Plan: smgr Integration Testing

## Overview

This plan adds an end-to-end integration test for the smgr CLI that exercises the full media pipeline: uploading images to S3, discovering them via `smgr watch`, enriching them with a real vision model, and asserting that semantic search returns correct results. It also introduces a `model_configs` database table for user-configurable enrichment models, replacing the current hardcoded Anthropic Claude Haiku in the enrichment pipeline.

The test uses three known images (pineapple, dog, beach) as fixtures. A local Ollama instance running the moondream vision model (pinned to `moondream:1.8b`) generates enrichment descriptions. The test then verifies that Postgres full-text search on those descriptions returns semantically correct results — for example, searching "pineapple" finds the pineapple image but not the dog.

### Why This Matters

Currently, smgr's components are tested in isolation: `media-storage.test.ts` covers S3, `smgr-cli.test.ts` covers CLI commands against seeded data, and `media-lifecycle.test.ts` covers DB operations. But nothing validates that the full pipeline works end-to-end. A regression in any connector between layers (S3 → event creation, event → enrichment, enrichment → search indexing) would go undetected.

### Key Design Decisions

1. **Real model, not mocks** — Tests the actual enrichment pipeline (image validation, base64 encoding, API client, response parsing). No mock drift.
2. **DB-stored model config** — New `model_configs` table lets each user configure their enrichment model. The test is the first consumer. The CLI loads config once at startup.
3. **Ollama always required** — The test fails fast if Ollama is unavailable. No graceful degradation.
4. **Real fixture photos** — Small JPEGs (~10-50KB) committed to the repo, not generated synthetically.
5. **Retry then fail** — When the model endpoint is unreachable, retry 2-3 times with backoff, then exit 2.

---

## Section 1: Database Migration — `model_configs` Table

### What to Build

A new Supabase migration that creates the `model_configs` table. This table stores per-user enrichment model configuration: which provider (anthropic, ollama, openai-compatible), the base URL, model name, and optionally an encrypted API key.

### Schema Design

Columns:
- `id` (uuid, PK, default `gen_random_uuid()`)
- `user_id` (uuid, FK → `auth.users(id)`, ON DELETE CASCADE)
- `provider` (text, NOT NULL, default `'anthropic'`) — identifies the provider type
- `base_url` (text, nullable) — NULL means use provider default (e.g., Anthropic's API)
- `model` (text, NOT NULL) — model identifier (e.g., `claude-haiku-4-5-20251001`, `moondream`)
- `api_key_encrypted` (text, nullable) — encrypted API key, NULL for local models like Ollama
- `is_active` (boolean, NOT NULL, default true)
- `created_at` / `updated_at` (timestamptz)

### Constraints

- Unique index on `(user_id, provider)` WHERE `is_active = true` — only one active config per provider per user.
- Row-level security: users can only access their own configs. Service role has full access (needed for CLI operations using `SUPABASE_SECRET_KEY`).

### Migration Location

`supabase/migrations/YYYYMMDDHHMMSS_create_model_configs.sql` — follows the existing Supabase migration naming convention.

---

## Section 2: Enrichment Code — Configurable Model Endpoint

### What to Change

The current `enrichImage()` in `web/lib/media/enrichment.ts` hardcodes Anthropic Claude Haiku. This section makes it accept an optional model configuration, enabling it to call any OpenAI-compatible endpoint (including local Ollama).

### Model Config Loading

Add a new function to `web/lib/media/db.ts`:

```typescript
async function getModelConfig(userId: string, provider?: string): Promise<ModelConfigRow | null>
```

Reads the active `model_configs` row for the user. If `provider` is specified, filters by it. Returns null if no config exists (caller uses defaults).

### Enrichment Function Changes

`enrichImage()` gains an optional `config` parameter:

```typescript
interface ModelConfig {
  provider: string;
  baseUrl: string | null;
  model: string;
  apiKey: string | null;
}

async function enrichImage(
  imageBytes: Buffer,
  mimeType: string,
  config?: ModelConfig
): Promise<EnrichmentResult>
```

**When `config` is provided and has a `baseUrl` (OpenAI-compatible path):**
- Use raw `fetch` to call `{baseUrl}/chat/completions` (no openai SDK dependency needed — the payload shape is simple)
- Format image as `data:image/{mimeType};base64,{base64data}` (required by Ollama's OpenAI-compatible API — pure base64 returns 400)
- Use a simple prompt: `"Describe this image in detail."` — **not** the structured JSON prompt used for Anthropic. Small models like moondream cannot reliably produce structured JSON output; they return free-text descriptions.
- Put the raw text response into `description`. Set `objects` and `suggested_tags` to empty arrays. Set `context` to empty string. Set `provider` and `model` from `config.provider` and `config.model`.
- This means the `EnrichmentResult` from non-Anthropic providers will have a populated `description` but empty structured fields. This is fine — Postgres full-text search operates on the `description` column.

**When `config` is null or has no `baseUrl` (Anthropic path):**
- Use the current Anthropic client path unchanged (structured JSON prompt, SDK-based retry)
- This preserves backward compatibility for users without a `model_configs` row

### Retry Logic

**OpenAI-compatible path only:** Add custom retry logic for the `fetch`-based path:
- Network errors (ECONNREFUSED, ECONNRESET, ETIMEDOUT)
- HTTP 429 (rate limit), 500, 502, 503 (server errors)
- Max 3 attempts with exponential backoff (1s, 2s, 4s)
- Non-retryable: 400 (bad request), 401 (auth), 404 (model not found)

**Anthropic path:** No changes — the Anthropic SDK already handles retries with `maxRetries: 3`. Do not add a second retry layer.

### `buildEmptyResult` Update

The existing `buildEmptyResult()` helper hardcodes `provider: "anthropic"`. Update it to accept an optional config parameter so that empty results for non-Anthropic providers reflect the correct provider/model.

### `batchEnrichImages()` Changes

The batch function already accepts a concurrency option. It should also accept a `config` parameter and pass it through to each `enrichImage()` call. No structural changes to the batch logic itself.

---

## Section 3: CLI Startup — Model Config Loading

### What to Change

The smgr CLI entry point (`web/bin/smgr.ts`) currently invokes enrichment functions without any model configuration. This section adds config loading at startup.

### Startup Flow

When the CLI starts:
1. Validate required env vars (`SMGR_USER_ID`, `SMGR_DEVICE_ID`, Supabase config) — no change
2. **New:** Call `getModelConfig(userId)` to load the user's active model config
3. Store the config (or null) in the command context
4. Pass config to all enrichment calls (`enrichImage`, `batchEnrichImages`)

### Commands Affected

- **`enrich --pending`** — passes config to `batchEnrichImages()`
- **`enrich <event_id>`** — passes config to `enrichImage()`
- **`watch --once`** — when `SMGR_AUTO_ENRICH=true`, passes config to auto-enrichment
- **`add <file>`** — when `--enrich` is true (default), passes config to enrichment

### Commands NOT Affected

- `query`, `show`, `stats` — read-only, no enrichment
- `enrich --status`, `enrich --dry-run` — no actual enrichment

---

## Section 4: Docker Compose — Ollama Service

### What to Add

Add an Ollama service to the existing `docker-compose.yml`. This makes Ollama available for both local development and CI.

### Service Definition

- **Image:** `ollama/ollama:latest`
- **Port:** `11434:11434`
- **Volume:** `ollama-data:/root/.ollama` — persists downloaded models across restarts
- **Healthcheck:** `curl -f http://localhost:11434/api/tags` with interval 10s, timeout 5s, retries 5

### Model Pulling

Ollama doesn't auto-pull models. After the service starts, the model must be pulled:
- Via a one-time setup script: `docker exec ollama ollama pull moondream`
- Or via a docker-compose "setup" service (like the existing `minio-setup` pattern)

Recommend adding an `ollama-setup` service that runs `ollama pull moondream:1.8b` and depends on `ollama` being healthy. This mirrors the existing `minio-setup` pattern. Pin the model tag to `moondream:1.8b` to prevent CI flakiness from model updates.

### CI Model Caching

In GitHub Actions, cache `~/.ollama/models/` (or the Docker volume) between runs. Key the cache on the model name + Ollama version to bust the cache when models update.

---

## Section 5: Test Fixture Images

### What to Create

Three small JPEG images committed to `web/__tests__/integration/fixtures/`:

| File | Subject | Size Target | Why This Image |
|------|---------|-------------|----------------|
| `pineapple.jpg` | Close-up of a pineapple | ~10-30KB | Visually unambiguous fruit |
| `dog.jpg` | Clear photo of a dog | ~10-30KB | Visually unambiguous animal |
| `beach.jpg` | Beach/ocean scene | ~10-30KB | Visually unambiguous water/nature |

### Image Requirements

- Real photographs (not illustrations or clipart) — models describe photos more reliably
- Single dominant subject per image — reduces ambiguity in model descriptions
- Small file size — keep the repo light, but large enough for the model to identify content
- Open license (Unsplash, Pexels, or similar) — no copyright issues
- JPEG format — matches the most common media type in the pipeline

### Sourcing Strategy

Download from Unsplash or Pexels. Resize to ~320x240 or smaller. Compress to target size. Verify the model can identify each image correctly before committing.

---

## Section 6: Integration Test — `smgr-e2e.test.ts`

### Test Structure

Single test file: `web/__tests__/integration/smgr-e2e.test.ts`

The test is a single `describe` block with sequential `it` blocks that share state (user, event IDs, etc). This mirrors the existing pattern in `smgr-cli.test.ts` where `beforeAll` sets up shared state.

### Setup Phase (`beforeAll`)

1. **Ollama health check** — `fetch('http://localhost:11434/api/tags')`. If unreachable, fail immediately with: `"Ollama is not running at localhost:11434. Start it with: docker-compose up -d ollama ollama-setup"`
2. Create test user via `createTestUser()`
3. Get admin client via `getAdminClient()`
4. Insert `model_configs` row for the test user:
   - `provider: 'ollama'`
   - `base_url: 'http://localhost:11434/v1'`
   - `model: 'moondream:1.8b'`
   - `api_key_encrypted: null`
   - `is_active: true`
5. Get S3 config via `getS3Config()`
6. Create S3 client via `createS3Client()`
7. Upload 3 fixture images to S3 bucket with known keys (e.g., `test-e2e/pineapple.jpg`)
8. **Verify uploads** — call `listS3Objects()` and assert all 3 files are visible before proceeding
9. Store uploaded keys for cleanup

**Timeout:** 30s for setup (model config insert + S3 uploads are fast)

### Test: Watch discovers uploaded images

- Run `smgr watch --once` with `SMGR_AUTO_ENRICH=false`, `SMGR_S3_BUCKET` pointing at test bucket
- Assert exit code 0
- Run `smgr stats` → parse JSON
- Assert `total_events === 3` (isolated user, exact count)
- Assert `pending_enrichment === 3`
- Store event IDs for subsequent steps (extract from `smgr query --format json`)

### Test: Enrich dry-run lists pending

- Run `smgr enrich --dry-run` → parse JSON output
- Assert all 3 event IDs appear in the pending list

### Test: Enrich processes all pending images

- Run `smgr enrich --pending` with sufficient timeout (model inference on CPU is slow)
- Assert exit code 0
- Parse result JSON → assert `enriched === 3`, `failed === 0`
- **Post-enrichment sanity check:** For each event, run `smgr show <id>`, parse the enrichment, and assert `description` is non-empty. If any description is empty, fail with a clear message indicating the model returned no content (not a pipeline bug).

**Timeout:** This test needs a longer timeout — moondream on CPU can take 10-30s per image. Set individual test timeout to 120s or use `{ timeout: 120_000 }`.

### Test: Semantic search — positive assertions

Use subject-specific search terms (not abstract categories) for reliability. Moondream will almost certainly mention "pineapple" in its description of a pineapple photo, but may not use the word "fruit."

Three sub-assertions:
- `smgr query --search "pineapple" --format json` → result includes pineapple event ID
- `smgr query --search "dog" --format json` → result includes dog event ID
- `smgr query --search "beach" --format json` → result includes beach event ID

If any positive assertion fails, it could mean:
1. The model didn't generate a relevant description → check enrichment output via `smgr show`
2. Full-text search indexing didn't work → check DB

### Test: Semantic search — negative assertions

Use terms that genuinely cannot appear in a correct description of the image. Avoid conceptually opposite terms ("not an animal" would still match FTS for "animal").

Three sub-assertions:
- `smgr query --search "car" --format json` → result does NOT include pineapple event ID
- `smgr query --search "pineapple" --format json` → result does NOT include dog event ID
- `smgr query --search "snow" --format json` → result does NOT include beach event ID

These negative assertions validate that enrichment descriptions are specific enough for search to discriminate.

### Test: Final stats verification

- `smgr stats` → parse JSON
- Assert `enriched === 3`
- Assert `pending_enrichment === 0`

### Cleanup Phase (`afterAll`)

1. Delete uploaded S3 objects (iterate stored keys)
2. Call `cleanupUserData(admin, userId)` — deletes all DB records (including `model_configs`)
3. Sign out user client, close connections

**Note:** `cleanupUserData()` in `setup.ts` must be updated to include `model_configs` in its table list. Add it before `events` in the delete order (no FKs from other tables reference it).

### Helper: `runCli` and `cliEnv`

Reuse the existing patterns from `smgr-cli.test.ts`. The `cliEnv` helper already constructs the correct environment. For the e2e test, add `SMGR_S3_BUCKET` and `SMGR_AUTO_ENRICH` to the extra env.

### Timeout Strategy

| Phase | Timeout |
|-------|---------|
| `beforeAll` | 30s |
| Watch test | 60s |
| Dry-run test | 30s |
| Enrich test | 120s (model inference) |
| Search tests | 30s each |
| Stats test | 30s |
| `afterAll` | 30s |

---

## Section 7: CI Pipeline Changes

### What to Change

Modify `.github/workflows/ci.yml` to include Ollama in the integration test job.

### Ollama Setup Steps (before test run)

1. Install Ollama: `curl -fsSL https://ollama.com/install.sh | sh`
2. Start server in background: `ollama serve &`
3. Wait for health: poll `http://localhost:11434/api/tags` until 200
4. Pull model: `ollama pull moondream`

### Model Caching

Cache `~/.ollama/models/` with key `ollama-moondream-${{ runner.os }}`. This avoids re-downloading the ~1.8GB model on every CI run.

### Alternative: Docker-Compose in CI

Instead of installing Ollama directly, CI could run `docker-compose up -d ollama ollama-setup`. This is more consistent with local dev but adds Docker-in-Docker complexity. The direct install approach is simpler for CI.

**Recommendation:** Use direct install in CI, docker-compose for local dev. Both result in Ollama at `localhost:11434`.

### Environment Variables

Add to the integration test step:
- No new env vars needed — the test inserts `model_configs` directly via DB, and Ollama is at the default `localhost:11434`

### Timeout Considerations

The integration test job timeout may need increasing. Moondream inference on CI runners (2 CPU, no GPU) takes ~10-30s per image. With 3 images + setup/teardown, budget ~5 minutes for the e2e test alone. Current CI timeout should accommodate this if it's generous enough for existing integration tests.

---

## Execution Order and Dependencies

```
Section 1 (DB migration)
    ↓
Section 2 (Enrichment code changes)  ←  depends on Section 1 (needs model_configs table)
    ↓
Section 3 (CLI startup changes)      ←  depends on Section 2 (uses new enrichment API)
    ↓
Section 4 (Docker compose)           ←  independent, can be done in parallel with 1-3
    ↓
Section 5 (Fixture images)           ←  independent, can be done in parallel
    ↓
Section 6 (Integration test)         ←  depends on ALL above (1-5)
    ↓
Section 7 (CI pipeline)              ←  depends on Section 4 + 6
```

**Critical path:** Section 1 → 2 → 3 → 6 → 7

**Parallelizable:** Sections 4 and 5 can be done at any time.
