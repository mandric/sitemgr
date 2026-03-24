# Section 04: Docker Compose — Ollama Service

## Overview

Add an Ollama server and a one-time model-pull sidecar to `docker-compose.yml` so the smgr integration test can run vision enrichment against a local model. This follows the same setup-service pattern already used for MinIO.

## Context

The smgr CLI enriches uploaded images by sending them to a vision model endpoint. For integration testing (and local development), we need a local Ollama instance with the `moondream:1.8b` model pre-pulled. This section has no code dependencies on other sections — it can be implemented in parallel with Sections 1, 2, 3, and 5.

**Existing `docker-compose.yml` structure (for reference):**

```yaml
services:
  minio:
    image: minio/minio:latest
    command: server /data --console-address ":9001"
    ports:
      - "9000:9000"
      - "9001:9001"
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
    healthcheck:
      test: ["CMD", "mc", "ready", "local"]
      interval: 5s
      timeout: 5s
      retries: 5

  minio-setup:
    image: minio/mc:latest
    depends_on:
      minio:
        condition: service_healthy
    entrypoint: >
      /bin/sh -c "
      mc alias set local http://minio:9000 minioadmin minioadmin &&
      mc mb --ignore-existing local/smgr-test &&
      mc anonymous set download local/smgr-test &&
      echo 'Bucket smgr-test ready'
      "

  smgr:
    build: .
    depends_on:
      minio-setup:
        condition: service_completed_successfully
    environment:
      SMGR_S3_BUCKET: smgr-test
      SMGR_S3_ENDPOINT: http://minio:9000
      SMGR_S3_REGION: us-east-1
      SMGR_DEVICE_ID: ci-test
      SMGR_AUTO_ENRICH: "false"
      S3_ACCESS_KEY_ID: minioadmin
      S3_SECRET_ACCESS_KEY: minioadmin
    volumes:
      - smgr-data:/root/.sitemgr
    command: ["bin/smgr.ts", "watch", "--once"]

volumes:
  smgr-data:
```

## What to Change

### `docker-compose.yml`

**Add the `ollama` service** after the `minio-setup` service (before `smgr`):

```yaml
  ollama:
    image: ollama/ollama:latest
    ports:
      - "11434:11434"
    volumes:
      - ollama-data:/root/.ollama
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:11434/api/tags"]
      interval: 10s
      timeout: 5s
      retries: 5
```

Key decisions:
- **Port 11434** is Ollama's default. Exposing it lets both the `smgr` container (via `http://ollama:11434`) and the host (via `http://localhost:11434`) reach the server.
- **`ollama-data` volume** persists downloaded models across `docker-compose down`/`up` cycles, avoiding repeated multi-GB downloads during local development.
- **Healthcheck** uses `/api/tags` (the model list endpoint) which returns 200 when the server is ready to accept requests. The interval is 10s (not 5s like MinIO) because Ollama takes longer to initialize.

**Add the `ollama-setup` service** immediately after `ollama`:

```yaml
  ollama-setup:
    image: ollama/ollama:latest
    depends_on:
      ollama:
        condition: service_healthy
    entrypoint: >
      /bin/sh -c "
      ollama pull moondream:1.8b &&
      echo 'Model moondream:1.8b ready'
      "
    environment:
      OLLAMA_HOST: http://ollama:11434
```

Key decisions:
- **Same image as `ollama`** — the `ollama` CLI is baked into the image and is used to issue the `pull` command.
- **`OLLAMA_HOST` env var** tells the `ollama pull` CLI to target the `ollama` service container (not localhost), since the pull runs in a separate container.
- **`depends_on: service_healthy`** ensures the server is accepting connections before the pull starts — mirrors the `minio-setup` pattern exactly.
- **Pinned to `moondream:1.8b`** — not `moondream:latest`. Pinning prevents CI from silently pulling a newer/larger model that could break tests or blow up download times.
- **Exits after pull** — this is a one-shot container, same as `minio-setup`.

**Add `ollama-data` to the `volumes` section:**

```yaml
volumes:
  smgr-data:
  ollama-data:
```

### Complete resulting `docker-compose.yml`

After all changes, the file should look like this:

```yaml
services:
  minio:
    image: minio/minio:latest
    command: server /data --console-address ":9001"
    ports:
      - "9000:9000"
      - "9001:9001"
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
    healthcheck:
      test: ["CMD", "mc", "ready", "local"]
      interval: 5s
      timeout: 5s
      retries: 5

  minio-setup:
    image: minio/mc:latest
    depends_on:
      minio:
        condition: service_healthy
    entrypoint: >
      /bin/sh -c "
      mc alias set local http://minio:9000 minioadmin minioadmin &&
      mc mb --ignore-existing local/smgr-test &&
      mc anonymous set download local/smgr-test &&
      echo 'Bucket smgr-test ready'
      "

  ollama:
    image: ollama/ollama:latest
    ports:
      - "11434:11434"
    volumes:
      - ollama-data:/root/.ollama
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:11434/api/tags"]
      interval: 10s
      timeout: 5s
      retries: 5

  ollama-setup:
    image: ollama/ollama:latest
    depends_on:
      ollama:
        condition: service_healthy
    entrypoint: >
      /bin/sh -c "
      ollama pull moondream:1.8b &&
      echo 'Model moondream:1.8b ready'
      "
    environment:
      OLLAMA_HOST: http://ollama:11434

  smgr:
    build: .
    depends_on:
      minio-setup:
        condition: service_completed_successfully
    environment:
      SMGR_S3_BUCKET: smgr-test
      SMGR_S3_ENDPOINT: http://minio:9000
      SMGR_S3_REGION: us-east-1
      SMGR_DEVICE_ID: ci-test
      SMGR_AUTO_ENRICH: "false"
      S3_ACCESS_KEY_ID: minioadmin
      S3_SECRET_ACCESS_KEY: minioadmin
    volumes:
      - smgr-data:/root/.sitemgr
    command: ["bin/smgr.ts", "watch", "--once"]

volumes:
  smgr-data:
  ollama-data:
```

### Note on `smgr` service (future section)

Section 06 will update the `smgr` service to depend on `ollama-setup` and add `SMGR_AUTO_ENRICH: "true"` with the Ollama endpoint. Do **not** modify the `smgr` service in this section — keep it unchanged.

## Files to Create/Modify

| File | Action |
|------|--------|
| `docker-compose.yml` | MODIFY — add `ollama` service, `ollama-setup` service, `ollama-data` volume |

## Validation (Manual)

No automated tests for this section. Verify with:

1. **Start the services:**
   ```bash
   docker-compose up -d ollama ollama-setup
   ```

2. **Wait for setup to complete:**
   ```bash
   docker-compose logs -f ollama-setup
   # Should see "Model moondream:1.8b ready" then exit
   ```

3. **Verify the server is running and model is available:**
   ```bash
   curl http://localhost:11434/api/tags
   # Response should include moondream:1.8b in the models list
   ```

4. **Verify exit codes:**
   ```bash
   docker-compose ps -a
   # ollama        — running (Up)
   # ollama-setup  — exited (Exit 0)
   ```

5. **Verify volume persistence** (model survives restart):
   ```bash
   docker-compose down
   docker-compose up -d ollama
   # Wait for healthy, then:
   curl http://localhost:11434/api/tags
   # moondream:1.8b should still be listed (no re-download needed)
   ```

## Acceptance Criteria

1. `docker-compose up -d ollama` starts the Ollama server on port 11434
2. `ollama-setup` waits for `ollama` to be healthy, then pulls `moondream:1.8b` and exits 0
3. `curl http://localhost:11434/api/tags` returns 200 and lists `moondream:1.8b` after setup completes
4. `ollama-data` volume persists the model across container restarts
5. Existing services (`minio`, `minio-setup`, `smgr`) are unchanged
6. Model tag is pinned to `moondream:1.8b` (not `latest`)
