# Opus Review

**Model:** claude-opus-4-6
**Generated:** 2026-03-20T16:25:00Z

---

# Plan Review: smgr Integration Testing

## 1. Completeness

### 1a. Missing: OpenAI SDK dependency

The plan calls for creating an OpenAI-compatible client (Section 2) to talk to Ollama's `/v1/chat/completions` endpoint. However, `openai` is not in the project's dependencies (`web/package.json` has no openai reference). The plan never mentions adding this dependency. This is a blocking gap -- without it, the OpenAI-compatible client code has no SDK to use.

**Fix:** Add an explicit step to `npm install openai` as a production dependency in `web/`, or specify that the implementation should use raw `fetch` calls instead (simpler, avoids a new dep).

### 1b. Missing: `model_configs` cleanup in teardown

The `cleanupUserData` function in `setup.ts` deletes from a fixed list of tables: `enrichments`, `watched_keys`, `events`, `bucket_configs`, `conversations`, `user_profiles`. It does not know about `model_configs`. The plan's afterAll says "Call `cleanupUserData(admin, userId)`" but never mentions updating the cleanup function. The `model_configs` rows will be orphaned (or cascade-deleted via `auth.users` FK, but only if the auth user delete succeeds).

**Fix:** Either explicitly add `model_configs` to the `cleanupUserData` table list, or document that CASCADE from `auth.users` handles it. The former is more explicit and consistent with the existing pattern.

### 1c. Missing: Response format mismatch between Anthropic and OpenAI paths

The current `enrichImage()` sends a structured prompt that asks the model to return JSON with specific fields: `description`, `objects`, `context`, `suggested_tags`. The Anthropic path parses this JSON response. The plan says the OpenAI-compatible path should "Parse the response text into the existing `EnrichmentResult` structure" but never addresses a critical difference: small models like moondream do not reliably produce structured JSON output. Moondream is a "describe this image" model, not an instruction-following model that obeys JSON format requests.

**Fix:** The OpenAI-compatible path needs different response parsing. Instead of expecting JSON, it should take the raw text response and construct the `EnrichmentResult` manually: put the entire response in `description`, leave `objects`/`suggested_tags` empty or parse them heuristically.

### 1d. Missing: Prompt adaptation for moondream

The `ENRICHMENT_PROMPT` asks for structured JSON output. Moondream will likely ignore this and just describe the image. The plan should specify whether to use the same prompt or a simpler one for OpenAI-compatible endpoints.

### 1e. Missing: `--no-enrich` flag on `add` command

The plan's Section 3 lists `add <file>` as affected "when `--no-enrich` is not set." But looking at the CLI code, the flag is actually `--enrich` (boolean, default true). The plan should use the correct flag name.

## 2. Correctness

### 2a. Stats assertion is fragile: `total_events >= 3`

The plan creates a fresh test user with user isolation enforced by `p_user_id` in the RPC functions. The assertions should be `== 3`, not `>= 3`. Using `>= 3` masks real bugs.

### 2b. `enrichImage` return value for OpenAI path hardcodes wrong provider/model

The current code hardcodes `provider: "anthropic"` and `model: response.model ?? "claude-haiku-4-5-20251001"`. The plan does not mention updating these fields for Ollama calls.

**Fix:** When `config` is provided, use `config.provider` and `config.model` in the returned result.

## 3. Risk Areas

### 3a. Moondream model reliability is a significant flakiness risk

The research notes "Known issue: some versions return empty answers." The plan does not include mitigation.

**Mitigations:** Assert non-empty description after enrichment; retry enrichment for empty descriptions; pin moondream model tag.

### 3b. Postgres full-text search semantics may surprise

Moondream might describe the pineapple as "a pineapple" without ever using "fruit." Similarly, "animal" might not appear in "a golden retriever sitting on grass."

**Fix:** Use more specific search terms ("pineapple" instead of "fruit") or inspect raw descriptions and dynamically choose search terms.

### 3c. Negative assertion: model saying "this is not an animal" would match "animal" in FTS

Postgres FTS matches individual words. A description containing "not an animal" still matches the query "animal."

## 4. Architecture

### 4a. `model_configs` table is overengineered for the stated need

The original spec explicitly describes model config as "Future." A simpler alternative: pass model config via environment variables (`SMGR_ENRICHMENT_BASE_URL`, `SMGR_ENRICHMENT_MODEL`). This is 10x less code, zero migrations, and achieves the same test coverage.

**Recommendation:** Consider env-var approach for v1. Defer `model_configs` to when there is a real user need.

### 4b. Retry logic placement: double-retry risk

The Anthropic SDK already has `maxRetries: 3`. Adding custom retry logic means double-retrying for the Anthropic path. Only add retry logic for the OpenAI-compatible path.

## 5. Testing Strategy

### 5a. Sequential test dependency is fragile

If the watch test fails, all subsequent tests fail with confusing messages. Add early-exit guards or use a single large test with step labels.

### 5b. Vitest timeout

The enrich test needs 120s but the project config has `testTimeout: 60000`. Plan correctly mentions per-test override.

## 6. Missing: Ollama health check

The test's `beforeAll` does not verify Ollama health. Add an Ollama health check early. Fail with a clear message.

## 7. Missing: Verify S3 uploads before watch

After uploading in `beforeAll`, verify with `listS3Objects` that all 3 files are visible before proceeding.

## Summary of Recommended Changes

**Critical:**
1. Handle moondream's free-text responses (no structured JSON)
2. Add `openai` SDK dependency or use raw `fetch`
3. Add Ollama health check to test setup
4. Update `provider`/`model` fields in `EnrichmentResult` for Ollama

**Important:**
5. Consider env-var model config instead of `model_configs` table
6. Fix double-retry issue
7. Add `model_configs` to `cleanupUserData`
8. Use exact count assertions (`=== 3`)

**Nice to have:**
9. Pin moondream model version
10. Add post-enrichment description check
11. Verify S3 uploads before watch
12. Use more specific search terms
