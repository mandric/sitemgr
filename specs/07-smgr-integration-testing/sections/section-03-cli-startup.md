# Section 03: CLI Startup — Model Config Loading

## Overview

Wire the smgr CLI entry point (`web/bin/smgr.ts`) to load the user's model configuration at startup and pass it through to every enrichment call. After this section, the CLI will use whatever model endpoint the user has configured (or fall back to Anthropic defaults when no config exists).

## Context

The smgr CLI has four commands that call `enrichImage()`:

1. `enrich <event_id>` — enrich a single event (line 235)
2. `enrich --pending` — batch-enrich all pending events (line 284)
3. `watch` — auto-enrich new images when `SMGR_AUTO_ENRICH=true` (line 403)
4. `add <file>` — enrich after upload when `--enrich` is true, the default (line 538)

All four currently call `enrichImage(imageBytes, mime)` with no config argument. After Section 2, `enrichImage` accepts an optional third parameter `config: ModelConfig | null`. This section threads that config from a single startup load through to all four call sites.

Commands that never call enrichment (`query`, `show`, `stats`, `enrich --status`, `enrich --dry-run`) need no changes.

## Prerequisites

- **Section 1** (database migration) must be complete — the `model_configs` table must exist
- **Section 2** (enrichment code changes) must be complete — `enrichImage()` must accept the optional `config` parameter, and `getModelConfig()` must be exported from `web/lib/media/db.ts`

## Implementation

### File to modify: `web/bin/smgr.ts`

### Step 1: Add `getModelConfig` to the db import

Current import block (line 18-29):

```typescript
import {
  queryEvents,
  showEvent,
  getStats,
  getEnrichStatus,
  getPendingEnrichments,
  insertEvent,
  insertEnrichment,
  upsertWatchedKey,
  getWatchedKeys,
  findEventByHash,
} from "../lib/media/db";
```

Add `getModelConfig` to this import:

```typescript
import {
  queryEvents,
  showEvent,
  getStats,
  getEnrichStatus,
  getPendingEnrichments,
  insertEvent,
  insertEnrichment,
  upsertWatchedKey,
  getWatchedKeys,
  findEventByHash,
  getModelConfig,
} from "../lib/media/db";
```

### Step 2: Load config once at startup in the main block

The current main block (lines 605-611) looks like this:

```typescript
const requestId = crypto.randomUUID();
runWithRequestId(requestId, () => {
  commands[command](rest).catch((err) => {
    logger.error("unhandled command error", { error: String(err), stack: err?.stack });
    cliError(err.message ?? String(err), EXIT.INTERNAL);
  });
});
```

Change it to load config before dispatching the command. The config is loaded inside the `runWithRequestId` callback so that the request context is available for any downstream logging:

```typescript
const requestId = crypto.randomUUID();
runWithRequestId(requestId, async () => {
  try {
    const userId = process.env.SMGR_USER_ID;
    const modelConfig = userId ? (await getModelConfig(userId)).data ?? null : null;

    // Make config available to command functions
    globalModelConfig = modelConfig;

    await commands[command](rest);
  } catch (err: unknown) {
    const e = err instanceof Error ? err : new Error(String(err));
    logger.error("unhandled command error", { error: String(e), stack: e.stack });
    cliError(e.message ?? String(e), EXIT.INTERNAL);
  }
});
```

Note: `getModelConfig` returns `{ data, error }` following the Supabase convention. We use `.data ?? null` — if the DB call fails or returns no rows, config is simply `null` and enrichment will use Anthropic defaults. There is no special error handling for config loading failure; if the DB is unreachable, the CLI will fail on the first actual DB operation anyway.

### Step 3: Add the module-level variable for loaded config

Near the top of the file, after the `verboseMode` declaration (line 56), add:

```typescript
let globalModelConfig: Record<string, unknown> | null = null;
```

This is the same pattern used by `verboseMode` — a module-level variable set during startup and read by command functions. The type is `Record<string, unknown> | null` because `getModelConfig` returns the row as-is from Supabase (per the project's "don't reshape data" principle).

### Step 4: Pass config to all four `enrichImage()` call sites

**4a. `enrich <event_id>` — single event enrichment (line 235)**

Current:
```typescript
const result = await enrichImage(imageBytes, mime);
```

Change to:
```typescript
const result = await enrichImage(imageBytes, mime, globalModelConfig);
```

**4b. `enrich --pending` — batch enrichment (line 284)**

Current:
```typescript
const result = await enrichImage(imageBytes, mime);
```

Change to:
```typescript
const result = await enrichImage(imageBytes, mime, globalModelConfig);
```

**4c. `watch` — auto-enrichment (line 403)**

Current:
```typescript
const result = await enrichImage(imageBytes, mime);
```

Change to:
```typescript
const result = await enrichImage(imageBytes, mime, globalModelConfig);
```

**4d. `add <file>` — enrich after upload (line 538)**

Current:
```typescript
const result = await enrichImage(Buffer.from(fileBytes), mimeType);
```

Change to:
```typescript
const result = await enrichImage(Buffer.from(fileBytes), mimeType, globalModelConfig);
```

## What NOT to change

- **No per-command config loading.** Config is loaded once at startup, not inside each command function. This avoids redundant DB calls and keeps command functions simple.
- **No error handling for config loading.** If the DB is unreachable, `getModelConfig` returns `{ data: null, error: ... }`. We take `null` and move on. The CLI will fail with a clear error on the first real DB operation (e.g., `getPendingEnrichments`).
- **No new CLI flags for model config.** Config comes from the database, not from CLI arguments. Users set their model config through the web UI or API (out of scope for this section).
- **No changes to `query`, `show`, `stats`.** These commands never call enrichment.
- **No changes to `enrich --status` or `enrich --dry-run`.** These exit before any enrichment call.

## Verification

After implementing this section, verify with:

```bash
# 1. Confirm the CLI still starts and shows help
npx tsx web/bin/smgr.ts

# 2. Confirm commands that don't enrich still work
SMGR_USER_ID=<test-uuid> npx tsx web/bin/smgr.ts stats

# 3. Confirm enrichment commands accept the config path
# (full verification happens in Section 6's integration test)
```

The integration test in Section 6 will validate end-to-end that:
- Config is loaded from the `model_configs` table at startup
- Config is passed through to `enrichImage`
- `enrichImage` uses the config to call the local Ollama endpoint instead of the Anthropic API

## Tests (validated in Section 6)

The following behaviors are validated by the end-to-end integration test rather than dedicated unit tests for this section:

| Behavior | How it's verified |
|----------|-------------------|
| `getModelConfig` called with `SMGR_USER_ID` at startup | Integration test inserts a model config row, then runs smgr — enrichment hits Ollama (not Anthropic), proving config was loaded |
| `enrich --pending` passes config to `enrichImage` | Integration test runs `enrich --pending` and asserts enrichment results exist in DB |
| `enrich <event_id>` passes config to `enrichImage` | Integration test runs single-event enrich and checks result |
| CLI works with no model config (null → Anthropic default) | Tested by _not_ inserting a config row and verifying enrichment still attempts Anthropic (or by mocking) |
| Read-only commands unaffected | Integration test runs `stats` and `query` and checks they succeed without model config side effects |

## Summary of changes

| File | Change |
|------|--------|
| `web/bin/smgr.ts` | Add `getModelConfig` import |
| `web/bin/smgr.ts` | Add `globalModelConfig` module-level variable |
| `web/bin/smgr.ts` | Load config at startup in main block |
| `web/bin/smgr.ts` | Pass `globalModelConfig` to 4 `enrichImage()` call sites |
