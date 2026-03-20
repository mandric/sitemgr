# Integration Notes: Opus Review Feedback

## What I'm Integrating

### 1. Free-text response handling for moondream (Critical — 1c, 1d)
**Integrating.** This is the most important finding. Moondream cannot produce structured JSON. The OpenAI-compatible path must use a simple "Describe this image" prompt and put the raw text into `description`. The `objects` and `suggested_tags` fields can be empty for non-Anthropic providers. This is a fundamental design change to the enrichment code.

### 2. OpenAI SDK dependency (Critical — 1a)
**Partially integrating.** Rather than adding the full `openai` SDK as a dependency, the plan will specify using raw `fetch` for the OpenAI-compatible endpoint. The payload shape is simple (`/v1/chat/completions` with base64 image), and `fetch` avoids adding a new production dependency for what is currently a test/local-dev feature. If the openai SDK is later needed for other reasons, it can be swapped in then.

### 3. Ollama health check (Critical — 6)
**Integrating.** Add an Ollama health check to the test's `beforeAll`. If Ollama is unreachable, fail immediately with a clear message. This prevents confusing mid-test failures.

### 4. Provider/model fields in EnrichmentResult (Critical — 2b)
**Integrating.** When `config` is provided, use `config.provider` and `config.model` in the returned `EnrichmentResult`.

### 5. model_configs vs env vars (Important — 4a)
**NOT integrating.** The user explicitly chose DB-stored config in the interview (Q1, Q4, Q5). While env vars would be simpler for the test alone, the user wants the `model_configs` table as part of this work. Respecting the stated requirement.

### 6. Double-retry fix (Important — 4b)
**Integrating.** Only add custom retry logic for the OpenAI-compatible/fetch path. The Anthropic SDK already handles its own retries. The plan will clarify this distinction.

### 7. `model_configs` in cleanupUserData (Important — 1b)
**Integrating.** Add `model_configs` to the cleanup table list in `setup.ts`. While CASCADE from `auth.users` would handle it, explicit cleanup is consistent with the existing pattern.

### 8. Exact count assertions (Important — 2a)
**Integrating.** Change `>= 3` to `=== 3`. The test creates an isolated user, so counts should be exact.

### 9. Specific search terms to reduce flakiness (Risk — 3b, 3c)
**Integrating.** Instead of relying on abstract categories ("fruit", "animal"), search for the actual subject ("pineapple", "dog", "beach"/"ocean"). These words are far more likely to appear in moondream's descriptions. Keep the negative assertions but use terms that genuinely won't appear (e.g., searching "car" won't match a pineapple even if the model says "not a car" — unlikely).

Also add a post-enrichment sanity check: assert each description is non-empty before proceeding to search assertions.

### 10. Pin moondream model version (Risk — 3a)
**Integrating.** Use `moondream:1.8b` instead of `moondream:latest` to prevent CI flakiness from model updates.

### 11. Verify S3 uploads before watch (Risk — 3c)
**Integrating.** After uploading in `beforeAll`, verify with `listS3Objects` that all 3 files exist.

### 12. `--enrich` flag naming (1e)
**Integrating.** Fix the flag reference to `--enrich` (not `--no-enrich`).

## What I'm NOT Integrating

### 5. Env-var model config instead of DB table
**Reason:** User explicitly chose DB-stored config. This is a design decision, not a technical error.

### Sequential test dependency → single large test (5a)
**Reason:** The sequential `it` block pattern is consistent with `smgr-cli.test.ts`. Adding early-exit guards is sufficient. Converting to a single test would lose granular failure reporting.
