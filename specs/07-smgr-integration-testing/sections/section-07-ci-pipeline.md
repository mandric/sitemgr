# Section 07: CI Pipeline — Ollama for Integration Tests

## Overview

Add Ollama installation, model caching, and server startup steps to the `integration-tests` job in `.github/workflows/ci.yml` so the smgr end-to-end integration test can run vision enrichment against a real local model in CI.

## Context

The smgr e2e integration test (Section 06) uploads images and verifies that the enrichment pipeline produces vision-model descriptions. This requires a running Ollama server with the `moondream:1.8b` model available at `http://localhost:11434`. In local dev, Docker Compose handles this (Section 04). In CI, we install Ollama directly on the runner because the GitHub Actions runner already uses Docker for Supabase — running Ollama in Docker would require Docker-in-Docker complexity for no benefit.

**Existing `integration-tests` job structure (relevant excerpt):**

```yaml
  integration-tests:
    name: Integration Tests (Supabase Local)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: "20"

      - uses: supabase/setup-cli@v1
        with:
          version: latest

      - name: Start Supabase local environment
        run: |
          supabase start
          echo "Supabase started successfully"

      - name: Extract Supabase connection details
        run: |
          # ... extracts env vars from supabase status ...

      - name: Verify integration test env vars
        run: |
          # ... checks required vars are set ...

      - name: Configure environment for smgr
        run: |
          echo "SMGR_S3_ENDPOINT=${{ env.STORAGE_S3_URL }}" >> $GITHUB_ENV
          echo "SMGR_S3_BUCKET=media" >> $GITHUB_ENV
          echo "SMGR_S3_REGION=local" >> $GITHUB_ENV
          echo "SMGR_DEVICE_ID=ci-test" >> $GITHUB_ENV
          echo "SMGR_AUTO_ENRICH=false" >> $GITHUB_ENV
          echo "AWS_ENDPOINT_URL_S3=${{ env.STORAGE_S3_URL }}" >> $GITHUB_ENV

      - name: Create storage bucket
        run: |
          # ... creates media bucket via Supabase Storage API ...

      - name: Install web dependencies
        run: cd web && npm ci

      - name: Run integration tests
        run: cd web && npm run test:integration

      - name: Stop Supabase
        if: always()
        run: supabase stop
```

## What to Change

### `.github/workflows/ci.yml`

**Add four new steps** to the `integration-tests` job, inserted between the `Configure environment for smgr` step and the `Create storage bucket` step. The Ollama setup runs in parallel with Supabase (which is already started by this point), so placing it here avoids adding serial wait time.

**Step 1 — Install Ollama:**

```yaml
      - name: Install Ollama
        run: curl -fsSL https://ollama.com/install.sh | sh
```

Key decisions:
- **Direct install, not Docker** — the runner is a fresh Ubuntu VM with Docker already occupied by Supabase containers. Installing Ollama as a native binary avoids Docker-in-Docker complexity and networking headaches between containers.
- **`curl | sh`** is Ollama's official install method. The `-fsSL` flags ensure the script fails loudly on HTTP errors (`-f`), runs silently (`-sS`), and follows redirects (`-L`).

**Step 2 — Restore model cache:**

```yaml
      - name: Restore Ollama model cache
        uses: actions/cache@v4
        with:
          path: ~/.ollama/models
          key: ollama-moondream-1.8b-${{ runner.os }}
```

Key decisions:
- **Cache `~/.ollama/models/`** — this is where Ollama stores downloaded model weights. The `moondream:1.8b` model is approximately 1.8GB; caching it avoids a 30-60s download on every CI run.
- **Cache key `ollama-moondream-1.8b-${{ runner.os }}`** — intentionally stable. The key only needs to change if we switch to a different model. There is no hash component because model weights for a pinned tag do not change. If we ever need to bust the cache (e.g., corrupted download), manually delete the cache entry via the GitHub Actions UI or `gh cache delete`.
- **No `restore-keys` fallback** — a partial cache of a different model is useless, so there is no benefit to fuzzy matching.

**Step 3 — Start Ollama server:**

```yaml
      - name: Start Ollama server
        run: |
          ollama serve &
          for i in $(seq 1 30); do
            curl -sf http://localhost:11434/api/tags > /dev/null 2>&1 && break
            sleep 1
          done
          curl -sf http://localhost:11434/api/tags > /dev/null 2>&1 || { echo "::error::Ollama server failed to start within 30s"; exit 1; }
```

Key decisions:
- **Background process** (`&`) — Ollama must keep running for the duration of the job. It does not daemonize itself, so `&` is necessary.
- **Health check polling** — polls `/api/tags` up to 30 times with 1-second intervals. This endpoint returns 200 when the server is ready to accept requests. This is the same endpoint used in the Docker Compose healthcheck (Section 04).
- **Hard failure after timeout** — the final `curl` after the loop ensures the step fails with a clear `::error::` annotation if the server never came up, rather than letting the test step fail with a confusing connection-refused error.

**Step 4 — Pull moondream model:**

```yaml
      - name: Pull moondream model
        run: ollama pull moondream:1.8b
```

Key decisions:
- **Pinned to `moondream:1.8b`** — not `moondream:latest`. Pinning prevents CI from silently pulling a newer or larger model that could break tests or change output format. This matches the pin in `docker-compose.yml` (Section 04).
- **Idempotent** — if the cache restored the model files, `ollama pull` detects the model is already present and completes instantly. If the cache missed, it downloads the full model. No conditional logic needed.

**Update the `Configure environment for smgr` step** to enable enrichment and point to the local Ollama instance:

Change these two lines in the existing step:

```yaml
      - name: Configure environment for smgr
        run: |
          echo "SMGR_S3_ENDPOINT=${{ env.STORAGE_S3_URL }}" >> $GITHUB_ENV
          echo "SMGR_S3_BUCKET=media" >> $GITHUB_ENV
          echo "SMGR_S3_REGION=local" >> $GITHUB_ENV
          echo "SMGR_DEVICE_ID=ci-test" >> $GITHUB_ENV
          echo "SMGR_AUTO_ENRICH=true" >> $GITHUB_ENV
          echo "SMGR_OLLAMA_URL=http://localhost:11434" >> $GITHUB_ENV
          echo "SMGR_VISION_MODEL=moondream:1.8b" >> $GITHUB_ENV
          echo "AWS_ENDPOINT_URL_S3=${{ env.STORAGE_S3_URL }}" >> $GITHUB_ENV
```

Changes from the existing step:
- `SMGR_AUTO_ENRICH` changed from `false` to `true` — enables the enrichment pipeline so the integration test exercises the full upload-enrich flow.
- `SMGR_OLLAMA_URL=http://localhost:11434` added — tells smgr where to find the Ollama server. Localhost because Ollama is installed directly on the runner, not in a Docker container.
- `SMGR_VISION_MODEL=moondream:1.8b` added — explicitly sets the model name so the enrichment code does not fall back to a default that might not be pulled.

### Complete resulting `integration-tests` job

After all changes, the job should look like this:

```yaml
  integration-tests:
    name: Integration Tests (Supabase Local)
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: "20"

      - uses: supabase/setup-cli@v1
        with:
          version: latest

      - name: Start Supabase local environment
        run: |
          supabase start
          echo "Supabase started successfully"

      - name: Extract Supabase connection details
        run: |
          set -euo pipefail
          STATUS_JSON=$(supabase status -o json)
          echo "SUPABASE_URL=$(echo "$STATUS_JSON" | jq -r .API_URL)" >> $GITHUB_ENV
          echo "NEXT_PUBLIC_SUPABASE_URL=$(echo "$STATUS_JSON" | jq -r .API_URL)" >> $GITHUB_ENV
          echo "SUPABASE_SECRET_KEY=$(echo "$STATUS_JSON" | jq -r .SERVICE_ROLE_KEY)" >> $GITHUB_ENV
          echo "SUPABASE_PUBLISHABLE_KEY=$(echo "$STATUS_JSON" | jq -r .ANON_KEY)" >> $GITHUB_ENV
          echo "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=$(echo "$STATUS_JSON" | jq -r .ANON_KEY)" >> $GITHUB_ENV
          echo "STORAGE_S3_URL=$(echo "$STATUS_JSON" | jq -r .STORAGE_S3_URL)" >> $GITHUB_ENV

          AWS_ACCESS_KEY=$(supabase status | grep "Access Key" | awk -F '│' '{print $3}' | tr -d ' ')
          AWS_SECRET_KEY=$(supabase status | grep "Secret Key" | awk -F '│' '{print $3}' | tr -d ' ')
          echo "AWS_ACCESS_KEY_ID=$AWS_ACCESS_KEY" >> $GITHUB_ENV
          echo "AWS_SECRET_ACCESS_KEY=$AWS_SECRET_KEY" >> $GITHUB_ENV

      - name: Verify integration test env vars
        run: |
          missing=0
          for var in SUPABASE_URL SUPABASE_SECRET_KEY SUPABASE_PUBLISHABLE_KEY NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY; do
            if [ -z "${!var}" ] || [ "${!var}" = "null" ]; then
              echo "ERROR: $var is not set (value: '${!var}')"
              missing=1
            fi
          done
          if [ "$missing" -eq 1 ]; then
            echo "::error::Required Supabase env vars are missing. DB tests would silently skip; media tests would get cryptic auth failures."
            exit 1
          fi
          echo "All required env vars verified"

      - name: Configure environment for smgr
        run: |
          echo "SMGR_S3_ENDPOINT=${{ env.STORAGE_S3_URL }}" >> $GITHUB_ENV
          echo "SMGR_S3_BUCKET=media" >> $GITHUB_ENV
          echo "SMGR_S3_REGION=local" >> $GITHUB_ENV
          echo "SMGR_DEVICE_ID=ci-test" >> $GITHUB_ENV
          echo "SMGR_AUTO_ENRICH=true" >> $GITHUB_ENV
          echo "SMGR_OLLAMA_URL=http://localhost:11434" >> $GITHUB_ENV
          echo "SMGR_VISION_MODEL=moondream:1.8b" >> $GITHUB_ENV
          echo "AWS_ENDPOINT_URL_S3=${{ env.STORAGE_S3_URL }}" >> $GITHUB_ENV

      - name: Install Ollama
        run: curl -fsSL https://ollama.com/install.sh | sh

      - name: Restore Ollama model cache
        uses: actions/cache@v4
        with:
          path: ~/.ollama/models
          key: ollama-moondream-1.8b-${{ runner.os }}

      - name: Start Ollama server
        run: |
          ollama serve &
          for i in $(seq 1 30); do
            curl -sf http://localhost:11434/api/tags > /dev/null 2>&1 && break
            sleep 1
          done
          curl -sf http://localhost:11434/api/tags > /dev/null 2>&1 || { echo "::error::Ollama server failed to start within 30s"; exit 1; }

      - name: Pull moondream model
        run: ollama pull moondream:1.8b

      - name: Create storage bucket
        run: |
          curl -sf -X POST "${{ env.SUPABASE_URL }}/storage/v1/bucket" \
            -H "Authorization: Bearer ${{ env.SUPABASE_SECRET_KEY }}" \
            -H "Content-Type: application/json" \
            -d '{"id":"media","name":"media","public":false}' \
            || echo "Bucket may already exist"

      - name: Install web dependencies
        run: cd web && npm ci

      - name: Run integration tests
        run: cd web && npm run test:integration

      - name: Stop Supabase
        if: always()
        run: supabase stop
```

## Timeout Considerations

The existing job has no explicit `timeout-minutes`, which defaults to 360 minutes (6 hours). Add `timeout-minutes: 20` to the job to fail fast if something hangs. Budget breakdown:

| Phase | Estimated Time |
|-------|---------------|
| Checkout + Node + Supabase setup | ~2 min |
| Supabase start | ~2-3 min |
| Ollama install | ~5-10s |
| Model pull (cache miss) | ~30-60s |
| Model pull (cache hit) | ~1-2s |
| Integration tests (including model inference) | ~3-5 min |
| Teardown | ~30s |
| **Total (cache miss)** | **~10-12 min** |
| **Total (cache hit)** | **~8-10 min** |

20 minutes provides comfortable headroom. Standard GitHub-hosted `ubuntu-latest` runners have 4 vCPUs and 16GB RAM — more than sufficient for `moondream:1.8b` (which needs ~2GB RAM for inference).

## Why Direct Install Instead of Docker

The `integration-tests` job already starts Supabase via `supabase start`, which launches multiple Docker containers (Postgres, GoTrue, Storage, etc.). Running Ollama in Docker would require:

1. A Docker network shared between the Supabase containers and the Ollama container
2. Managing the Ollama container lifecycle separately from Supabase's Docker Compose
3. Potential port conflicts or Docker-in-Docker complications

Installing Ollama directly on the runner avoids all of this. The test code hits `http://localhost:11434`, which just works because both the test process and the Ollama server run directly on the runner host.

The Docker Compose approach from Section 04 is for local development only, where all services (MinIO, Ollama, smgr) run together in a single Docker Compose stack.

## Files to Create/Modify

| File | Action |
|------|--------|
| `.github/workflows/ci.yml` | MODIFY — add Ollama install, cache, start, and model pull steps to `integration-tests` job; update smgr env vars to enable enrichment; add `timeout-minutes: 20` |

## Validation

No automated tests for this section. Validation is via CI run:

1. **Push a branch with the CI changes** and open a PR (or use `workflow_dispatch` to trigger manually).

2. **Verify the Ollama steps succeed** in the GitHub Actions log:
   - "Install Ollama" step completes without error
   - "Restore Ollama model cache" shows either "Cache restored" (hit) or "Cache not found" (miss)
   - "Start Ollama server" step exits 0 (server is healthy)
   - "Pull moondream model" shows either "moondream:1.8b already exists" (cached) or downloads the model

3. **Verify cache on second run** — re-run the workflow or push another commit. The "Restore Ollama model cache" step should show "Cache restored from key: ollama-moondream-1.8b-Linux" and the "Pull moondream model" step should complete in under 2 seconds.

4. **Verify integration tests pass** — the "Run integration tests" step should pass, including the smgr e2e test from Section 06 that exercises the enrichment pipeline.

## Acceptance Criteria

1. `integration-tests` job installs Ollama via the official install script (not Docker)
2. Model cache at `~/.ollama/models` is saved and restored between CI runs using `actions/cache@v4`
3. Cache key is `ollama-moondream-1.8b-${{ runner.os }}` (stable, only changes if model changes)
4. Ollama server starts in the background and is verified healthy via `/api/tags` polling (up to 30s)
5. Step fails with a clear `::error::` annotation if the server does not start within 30 seconds
6. `moondream:1.8b` model is pulled (idempotent — skips download if cache provided it)
7. Model tag is pinned to `moondream:1.8b` (not `latest`)
8. `SMGR_AUTO_ENRICH` is set to `true` and `SMGR_OLLAMA_URL`/`SMGR_VISION_MODEL` env vars are configured
9. Job has `timeout-minutes: 20` to fail fast on hangs
10. All existing steps and env vars in the `integration-tests` job are preserved unchanged (except `SMGR_AUTO_ENRICH` and the two new env vars)
11. No other jobs in the workflow are modified
