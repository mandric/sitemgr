# Section 2: Enrichment Code — Configurable Model Endpoint

## Goal

Make `enrichImage()` accept an optional model configuration so it can call any OpenAI-compatible endpoint (e.g., local Ollama with moondream) in addition to the current hardcoded Anthropic Claude Haiku path. Also add `getModelConfig()` to the DB layer.

## Prerequisites

- Section 1 complete (model_configs table exists in DB)

## Files to Modify

- `web/lib/media/enrichment.ts` — add ModelConfig interface, OpenAI-compatible path, retry logic, update buildEmptyResult and batchEnrichImages
- `web/lib/media/db.ts` — add getModelConfig() function

---

## Part A: Add `getModelConfig()` to `web/lib/media/db.ts`

### What to Add

A new exported function that reads the user's active model configuration:

```typescript
export async function getModelConfig(
  userId: string,
  provider?: string,
): Promise<{ data: ModelConfigRow | null; error: PostgrestError | null }>
```

**Behavior:**
- Query `model_configs` WHERE `user_id = userId` AND `is_active = true`
- If `provider` is specified, also filter by `provider`
- Use `.maybeSingle()` (returns null instead of error when no rows match)
- Return Supabase's `{ data, error }` shape as-is (per CLAUDE.md: "don't reshape data")
- Uses the existing admin/service-role client pattern from db.ts

**ModelConfigRow type** (add near other row types in db.ts):
```typescript
interface ModelConfigRow {
  id: string;
  user_id: string;
  provider: string;
  base_url: string | null;
  model: string;
  api_key_encrypted: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}
```

### Existing Pattern to Follow

Look at how other query functions in db.ts work (e.g., `showEvent`, `getStats`). They:
1. Get the Supabase client
2. Build a query with `.from().select().eq()`
3. Return `{ data, error }` directly

---

## Part B: Add `ModelConfig` Interface to `web/lib/media/enrichment.ts`

```typescript
export interface ModelConfig {
  provider: string;
  baseUrl: string | null;
  model: string;
  apiKey: string | null;
}
```

This is the shape that the CLI passes to enrichment functions. It's a simplified view of `ModelConfigRow` (no `id`, `created_at`, etc.).

---

## Part C: Modify `enrichImage()` Signature

Current signature (line 98):
```typescript
export async function enrichImage(
  imageBytes: Buffer,
  mimeType: string,
): Promise<EnrichmentResult>
```

New signature:
```typescript
export async function enrichImage(
  imageBytes: Buffer,
  mimeType: string,
  config?: ModelConfig,
): Promise<EnrichmentResult>
```

### Routing Logic

After the existing image validation block (lines 106-121), add routing:

```
if (config?.baseUrl) {
  → OpenAI-compatible path (new code, Part D)
} else {
  → Anthropic path (existing code, unchanged)
}
```

The Anthropic path (lines 123-185) remains exactly as-is. No changes to the existing code path.

---

## Part D: OpenAI-Compatible Path (New Code)

When `config.baseUrl` is set, use raw `fetch` to call the OpenAI-compatible chat completions endpoint.

### Request Format

```typescript
const b64 = imageBytes.toString("base64");
const dataUri = `data:image/${normalizedMime};base64,${b64}`;

const body = {
  model: config.model,
  messages: [{
    role: "user",
    content: [
      { type: "text", text: "Describe this image in detail." },
      { type: "image_url", image_url: { url: dataUri } },
    ],
  }],
};
```

**CRITICAL:** The image must be formatted as `data:image/{mimeType};base64,{base64data}`. Pure base64 without the data URI prefix returns 400 from Ollama's OpenAI-compatible endpoint.

### Prompt

Use the simple prompt `"Describe this image in detail."` — NOT the structured JSON prompt from `ENRICHMENT_PROMPT`. Small models like moondream cannot reliably produce structured JSON output; they return free-text descriptions.

### Request Execution (with retry)

```typescript
const url = `${config.baseUrl}/chat/completions`;

const response = await fetchWithRetry(url, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
  },
  body: JSON.stringify(body),
});

const json = await response.json();
const description = json.choices?.[0]?.message?.content ?? "";
```

### Response Mapping

Map the response to `EnrichmentResult`:

```typescript
return {
  description: description,
  objects: [],           // Small models don't produce structured fields
  context: "",           // Empty for non-Anthropic providers
  suggested_tags: [],    // Empty for non-Anthropic providers
  provider: config.provider,
  model: config.model,
  raw_response: description,
};
```

### Logging

Log completion similar to the Anthropic path:
```typescript
logger.info("enrichment complete (openai-compatible)", {
  model: config.model,
  provider: config.provider,
  description_length: description.length,
  image_size_bytes: imageBytes.length,
});
```

---

## Part E: Retry Logic for Fetch (OpenAI-Compatible Path Only)

Add a helper function `fetchWithRetry` in enrichment.ts (not exported — internal only).

### Behavior

- Max 3 attempts with exponential backoff: 1s, 2s, 4s
- **Retry on:**
  - Network errors: ECONNREFUSED, ECONNRESET, ETIMEDOUT (these throw, not HTTP status)
  - HTTP status: 429 (rate limit), 500, 502, 503 (server errors)
- **Do NOT retry on:**
  - HTTP 400 (bad request — malformed payload)
  - HTTP 401 (auth — wrong API key)
  - HTTP 404 (model not found)
  - Any other 4xx error
- On final failure, throw an error with the status code and response body

### Implementation Sketch

```typescript
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  maxAttempts = 3,
): Promise<Response> {
  // Loop: attempt 1, 2, 3
  // On network error or retryable status: wait (1s, 2s, 4s), retry
  // On non-retryable status: throw immediately
  // On success (2xx): return response
}
```

**IMPORTANT:** Do NOT add this retry logic to the Anthropic path. The Anthropic SDK already has `maxRetries: 3` configured (line 41). Adding custom retry would cause double-retrying.

---

## Part F: Update `buildEmptyResult()`

Current (line 86):
```typescript
function buildEmptyResult(rawResponse: string): EnrichmentResult {
  return {
    description: "",
    objects: [],
    context: "",
    suggested_tags: [],
    provider: "anthropic",
    model: "claude-haiku-4-5-20251001",
    raw_response: rawResponse,
  };
}
```

New signature:
```typescript
function buildEmptyResult(rawResponse: string, config?: ModelConfig): EnrichmentResult
```

When `config` is provided, use `config.provider` and `config.model` instead of the hardcoded Anthropic values.

Update the call site in the validation block (line 113) to pass `config`:
```typescript
return buildEmptyResult("", config);
```

---

## Part G: Update `batchEnrichImages()`

Current signature (line 188):
```typescript
export async function batchEnrichImages(
  items: BatchEnrichmentItem[],
  options?: { concurrency?: number },
): Promise<BatchEnrichmentResult>
```

New signature:
```typescript
export async function batchEnrichImages(
  items: BatchEnrichmentItem[],
  options?: { concurrency?: number; config?: ModelConfig },
): Promise<BatchEnrichmentResult>
```

Change the `enrichImage` call inside (line 201) to pass through the config:
```typescript
const result = await enrichImage(item.imageBytes, item.mimeType, options?.config);
```

No other changes to batch logic.

---

## Tests to Write First (TDD)

### Unit tests for enrichImage (mock fetch and Anthropic client)

```
# Test: enrichImage() with no config calls Anthropic client (existing behavior unchanged)
# Test: enrichImage() with config.baseUrl calls fetch to {baseUrl}/chat/completions
# Test: enrichImage() with config formats image as data:image/{mime};base64,{data} in request body
# Test: enrichImage() with config sends "Describe this image in detail." prompt (not ENRICHMENT_PROMPT)
# Test: enrichImage() with config puts response text into description field
# Test: enrichImage() with config sets objects and suggested_tags to empty arrays
# Test: enrichImage() with config sets provider and model from config values
# Test: enrichImage() with config retries on HTTP 503 (up to 3 times with backoff)
# Test: enrichImage() with config does NOT retry on HTTP 400
# Test: enrichImage() with config retries on ECONNREFUSED network error
# Test: enrichImage() with config throws after 3 failed retries
```

### Unit tests for buildEmptyResult

```
# Test: buildEmptyResult() with config returns correct provider/model from config
# Test: buildEmptyResult() without config returns "anthropic" and "claude-haiku-4-5-20251001"
```

### Integration tests for getModelConfig (against real DB)

```
# Test: getModelConfig() returns active config for user
# Test: getModelConfig() returns null when no config exists
# Test: getModelConfig() ignores inactive configs (is_active = false)
# Test: getModelConfig() with provider filter returns only matching provider
```

### Integration tests for batchEnrichImages

```
# Test: batchEnrichImages() passes config through to each enrichImage() call
```

## Summary of Changes

| File | Change |
|------|--------|
| `web/lib/media/db.ts` | Add `ModelConfigRow` type, add `getModelConfig()` function |
| `web/lib/media/enrichment.ts` | Add `ModelConfig` interface, add `config?` param to `enrichImage()`, add OpenAI-compatible path with `fetchWithRetry`, update `buildEmptyResult()` to accept config, update `batchEnrichImages()` to accept and pass config |
