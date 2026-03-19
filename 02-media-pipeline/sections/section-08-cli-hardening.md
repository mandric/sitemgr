# Section 08: CLI Hardening

**Depends on:** section-01 (logger + request context), section-04 (S3 hardening), section-05 (enrichment hardening), section-06 (DB hardening)
**Blocks:** nothing (last implementation section before tests)
**Can be implemented as an independent PR after sections 01, 04, 05, 06 are merged**

---

## What You Are Building

Four targeted improvements to `web/bin/smgr.ts`:

1. **Structured error reporting with exit codes** — replace the single `die()` helper with a typed error system that maps failure categories to distinct exit codes (0=success, 1=user error, 2=service error, 3=internal error).
2. **Watch command hardening** — add `--interval` and `--max-errors` flags; count consecutive failures and stop when the limit is hit; log scan results at info level.
3. **Enrich command improvements** — add `--concurrency` and `--dry-run` flags; replace the sequential `for` loop with `p-limit`; emit progress to stderr, final summary to stdout.
4. **Output channel discipline** — user-facing results stay on stdout; all operational logs move to stderr via the structured logger from section 01.

No new library files are created. The only file modified is `web/bin/smgr.ts`.

---

## Dependencies

Before starting, verify these sections are merged:

- **Section 01:** `web/lib/logger.ts` exports `createLogger` and `LogComponent`. `web/lib/request-context.ts` exports `runWithRequestId` and `getRequestId`.
- **Section 02:** `p-limit` is installed in `web/package.json`.
- **Section 04:** `listS3Objects` and `downloadS3Object` attach `s3ErrorType` to thrown errors. `web/lib/media/s3-errors.ts` exports `S3ErrorType`.
- **Section 05:** `enrichImage` is hardened with pre-validation.
- **Section 06:** `upsertWatchedKey` accepts `bucketConfigId` as a last parameter.

---

## Files to Modify

- `web/bin/smgr.ts` — error reporting, exit codes, watch flags, enrich flags, logging, output channels

---

## Tests First

The CLI is a thin orchestrator over well-tested library functions. There is no dedicated unit test file for this section — process-spawning tests are high effort and the library behavior is already covered by sections 04–07's tests.

Instead, verify by running the full suite after each change:

```bash
cd web && npm test
```

All existing tests must continue to pass. No new failures are acceptable.

The manual verification checklist at the end of this section covers the behaviors to confirm before marking this section complete.

---

## Implementation

### 1. Exit Code Constants and `cliError()`

Replace the current `die()` function with a typed error system. Place this near the top of `smgr.ts`, after the imports:

```typescript
const EXIT = {
  SUCCESS:  0,
  USER:     1,   // Bad arguments, missing env var, resource not found
  SERVICE:  2,   // S3 unreachable, DB timeout, external API failure
  INTERNAL: 3,   // Unexpected exception, programming error
} as const;
type ExitCode = typeof EXIT[keyof typeof EXIT];

let verboseMode = false;

function cliError(message: string, code: ExitCode = EXIT.USER, detail?: string): never {
  console.error(`Error: ${message}`);
  if (verboseMode && detail) {
    console.error(`Detail: ${detail}`);
  }
  process.exit(code);
}
```

Replace all `die(msg)` call sites with `cliError(msg)`. The default code is `EXIT.USER`, which matches the current behaviour for missing arguments and missing env vars.

Update the top-level catch block to use `EXIT.INTERNAL`:

```typescript
commands[command](rest).catch((err) => {
  logger.error("unhandled command error", { error: String(err), stack: err?.stack });
  cliError(err.message ?? String(err), EXIT.INTERNAL);
});
```

**Error category mapping for existing call sites:**

| Situation | Exit code |
|-----------|-----------|
| Missing `SMGR_USER_ID` env var | `EXIT.USER` |
| Missing `SMGR_S3_BUCKET` env var | `EXIT.USER` |
| Bad command arguments | `EXIT.USER` |
| Event not found | `EXIT.USER` |
| S3 connection failure | `EXIT.SERVICE` |
| Supabase/DB failure (non-user) | `EXIT.SERVICE` |
| Claude API failure | `EXIT.SERVICE` |
| Unhandled exception | `EXIT.INTERNAL` |

### 2. Module-Level Logger and Request Context

Add these imports at the top of the file, after the existing imports:

```typescript
import { createLogger, LogComponent } from "../lib/logger";
import { runWithRequestId } from "../lib/request-context";

const logger = createLogger(LogComponent.CLI);
```

Wrap each command dispatch in a request context so that all downstream library log entries carry the same request ID automatically. The simplest approach is to wrap the dispatch at the bottom of the file:

```typescript
const requestId = crypto.randomUUID();
runWithRequestId(requestId, () => {
  commands[command](rest).catch((err) => {
    logger.error("unhandled command error", { error: String(err), stack: err?.stack });
    cliError(err.message ?? String(err), EXIT.INTERNAL);
  });
});
```

No function signatures need to change. The logger reads `getRequestId()` from `AsyncLocalStorage` automatically.

### 3. Output Channel Rules

Apply these rules across all command functions. This is a categorisation decision, not a find-and-replace:

| Content type | Channel | Method |
|---|---|---|
| JSON results, table output — what the user reads | stdout | `console.log()` |
| Progress lines (`[1/10] Enriching...`, scan timestamps) | stderr | `console.error()` |
| Structured operational logs (timings, counts, debug) | stderr | `logger.info()` / `logger.debug()` |
| Error messages | stderr | `console.error()` or `cliError()` |

The invariant to preserve: `smgr stats | jq .total_events` must work. No output from `logger.*` may appear on stdout.

Existing `console.log()` calls that print progress lines like `"[1/10] Enriching..."` must be changed to `console.error()`. Existing `console.log()` calls that print final JSON or table results stay on stdout.

### 4. Watch Command: `--interval` and `--max-errors`

The existing `cmdWatch` reads interval from `process.env.SMGR_WATCH_INTERVAL`. Expose it as a CLI flag that falls back to the env var, which falls back to 60 seconds. Add `--max-errors`.

Updated `parseArgs` options block:

```typescript
const { values } = parseArgs({
  args,
  options: {
    once:          { type: "boolean", default: false },
    interval:      { type: "string" },
    "max-errors":  { type: "string" },
    verbose:       { type: "boolean", default: false },
  },
});

if (values.verbose) verboseMode = true;

const intervalSecs = parseInt(
  values.interval ?? process.env.SMGR_WATCH_INTERVAL ?? "60",
  10,
);
const maxErrors = parseInt(values["max-errors"] ?? "5", 10);
```

Add a consecutive error counter around the scan loop:

```typescript
let consecutiveErrors = 0;

while (running) {
  try {
    const objects = await listS3Objects(s3, bucket, prefix);
    const mediaObjects = objects.filter((o) => isMediaKey(o.key));
    const seenKeys = await getWatchedKeys(userId);
    const newObjects = mediaObjects.filter((o) => !seenKeys.has(o.key));

    // ... existing per-object processing ...

    consecutiveErrors = 0;  // reset on a successful scan

    logger.info("watch scan complete", {
      bucket,
      total_objects: objects.length,
      new_objects: newObjects.length,
    });

    const ts = new Date().toLocaleTimeString();
    console.error(`[${ts}] Scanned: ${objects.length} objects, ${newObjects.length} new`);

  } catch (err) {
    consecutiveErrors++;
    logger.error("watch scan failed", {
      error: String(err),
      consecutive_errors: consecutiveErrors,
      max_errors: maxErrors,
    });
    console.error(`Poll error (${consecutiveErrors}/${maxErrors}): ${err}`);

    if (consecutiveErrors >= maxErrors) {
      cliError(
        `Stopping: ${maxErrors} consecutive scan failures`,
        EXIT.SERVICE,
        String(err),
      );
    }
  }

  if (values.once) break;

  for (let i = 0; i < intervalSecs && running; i++) {
    await new Promise((r) => setTimeout(r, 1000));
  }
}
```

The `--once` flag behaviour is unchanged: run one cycle, then break regardless of success or failure.

Move the existing `console.log(\`Watching s3://...\`)` startup line to `console.error()` since it is operational context, not user data.

### 5. Enrich Command: `--concurrency` and `--dry-run`

Add two new options to `cmdEnrich`:

```typescript
const { values, positionals } = parseArgs({
  args,
  options: {
    pending:      { type: "boolean", default: false },
    status:       { type: "boolean", default: false },
    force:        { type: "boolean", default: false },
    concurrency:  { type: "string", default: "3" },
    "dry-run":    { type: "boolean", default: false },
    verbose:      { type: "boolean", default: false },
  },
  allowPositionals: true,
});

if (values.verbose) verboseMode = true;
const concurrency = Math.max(1, parseInt(values.concurrency ?? "3", 10));
const dryRun = values["dry-run"] ?? false;
```

**Dry-run mode** — print which events would be enriched and exit without calling the API:

```typescript
if (dryRun) {
  const pending = await getPendingEnrichments(userId);
  console.log(JSON.stringify({ pending: pending.length, items: pending.map((e) => e.id) }, null, 2));
  return;
}
```

**Batch enrichment with `p-limit`** — replace the sequential `for` loop:

```typescript
import pLimit from "p-limit";

// (inside the `if (values.pending)` block)

const limit = pLimit(concurrency);
let done = 0;
let failed = 0;
let skipped = 0;
const total = pending.length;

const tasks = pending.map((event, i) =>
  limit(async () => {
    const meta = (event.metadata as Record<string, unknown>) ?? {};
    const s3Key =
      (meta.s3_key as string) ??
      (event.remote_path
        ? String(event.remote_path).replace(`s3://${bucket}/`, "")
        : null);

    if (!s3Key) {
      skipped++;
      console.error(`[${i + 1}/${total}] ${event.id} — no S3 key, skipping`);
      return;
    }

    console.error(`[${i + 1}/${total}] Enriching ${event.id}...`);
    try {
      const imageBytes = await downloadS3Object(s3, bucket, s3Key);
      const mime = (meta.mime_type as string) ?? getMimeType(s3Key);
      const result = await enrichImage(imageBytes, mime);
      await insertEnrichment(event.id, result, userId);
      done++;
    } catch (err) {
      failed++;
      logger.error("enrich item failed", { event_id: event.id, error: String(err) });
      console.error(`  Failed: ${err}`);
    }
  }),
);

await Promise.all(tasks);
```

Print the final summary **to stdout** so it is machine-readable and pipeable:

```typescript
const summary = { enriched: done, failed, skipped, total };
console.log(JSON.stringify(summary, null, 2));
logger.info("enrich batch complete", summary);
```

Remove the old `console.log(\`Enriched ${done}, failed ${failed}, total ${pending.length}\`)` plain-text line. The JSON summary replaces it.

### 6. S3 Error Classification for Exit Codes

Where the CLI catches errors from `listS3Objects` or `downloadS3Object` in one-shot paths (for example: `cmdEnrich` called with a specific event ID), use the attached `s3ErrorType` property to choose the right exit code:

```typescript
import { S3ErrorType } from "../lib/media/s3-errors";

function exitCodeForS3Error(err: unknown): ExitCode {
  const t = (err as any)?.s3ErrorType as S3ErrorType | undefined;
  if (t === S3ErrorType.AccessDenied) return EXIT.USER;
  if (t === S3ErrorType.NotFound)     return EXIT.USER;
  if (t === S3ErrorType.NetworkError) return EXIT.SERVICE;
  if (t === S3ErrorType.ServerError)  return EXIT.SERVICE;
  if (t === S3ErrorType.Timeout)      return EXIT.SERVICE;
  return EXIT.INTERNAL;
}
```

Use this inside catch blocks where you currently call `die()` or `console.error()` after a failed download or list operation.

### 7. `requireUserId()` and `--verbose` Global Flag

Parse `--verbose` before command dispatch by checking `process.argv` directly (simpler than adding it to every command's `parseArgs`):

```typescript
if (process.argv.includes("--verbose")) verboseMode = true;
```

`requireUserId()` already exits with a user-error message. Update the call to use `cliError`:

```typescript
function requireUserId(): string {
  const userId = process.env.SMGR_USER_ID;
  if (!userId) {
    cliError(
      "Set SMGR_USER_ID environment variable (user UUID for tenant-scoped operations)",
      EXIT.USER,
    );
  }
  return userId;
}
```

### 8. Update Usage Help Text

Update the help block printed when no command is given:

```
Usage:
  smgr query [--search Q] [--type TYPE] [--format json] [--limit N]
  smgr show <event_id>
  smgr stats
  smgr enrich [--pending] [--status] [--concurrency N] [--dry-run] [<event_id>]
  smgr watch [--once] [--interval N] [--max-errors N]
  smgr add <file> [--prefix path/] [--no-enrich]

Flags (all commands):
  --verbose         Show technical error details on failure

Enrich flags:
  --concurrency N   Max parallel enrichment calls (default: 3)
  --dry-run         Print pending events without calling the Claude API

Watch flags:
  --interval N      Poll interval in seconds (default: 60)
  --max-errors N    Stop after N consecutive scan failures (default: 5)

Exit codes:
  0  Success
  1  User error (bad arguments, missing env var, resource not found)
  2  Service error (S3 unreachable, DB timeout, API failure)
  3  Internal error (unexpected exception)
```

---

## Acceptance Criteria

- `npm test` from `web/` passes with no new failures
- `smgr stats 2>/dev/null | jq .total_events` works — no logger output on stdout
- `smgr enrich --pending --dry-run` prints JSON to stdout and exits 0 without calling `enrichImage`
- `smgr enrich --pending --concurrency 5` processes events up to 5-at-a-time
- `smgr watch --interval 10 --max-errors 2` polls every 10 seconds and exits with code 2 after 2 consecutive S3 failures
- Missing `SMGR_USER_ID` produces exit code 1
- An unhandled thrown exception produces exit code 3
- All progress lines (`[1/10] Enriching...`, scan summaries) go to stderr
- All JSON results and table output go to stdout

---

## Manual Verification Checklist

```bash
# Exit codes
smgr unknown-command; echo "exit: $?"     # expect: 1
smgr stats; echo "exit: $?"               # expect: 0 (with Supabase creds set)

# Output channel discipline (no log noise on stdout)
smgr stats 2>/dev/null | jq .             # must parse as valid JSON
smgr enrich --pending 2>/dev/null         # progress lines absent from stdout

# Dry run (no API calls)
smgr enrich --pending --dry-run           # JSON list of event IDs, exit 0

# Watch flags visible in usage
smgr watch --help 2>&1 | grep interval    # should show the flag

# Single-cycle watch to exercise flag parsing
smgr watch --interval 5 --max-errors 2 --once
```

---

## Summary of Changes

| What | Where | Why |
|---|---|---|
| `EXIT` constants + `cliError()` | `smgr.ts` | Typed exit codes replace single-code `die()` |
| Module-level `logger` + request context wrap | `smgr.ts` | Operational output to stderr; request ID propagates to library logs |
| `--interval`, `--max-errors` flags | `cmdWatch` | Replaces env-var-only config; prevents silent hang on broken S3 |
| Consecutive error counter in watch loop | `cmdWatch` | Stops the watch process after sustained failure |
| `--concurrency`, `--dry-run` flags | `cmdEnrich` | Parallel batch; safe preview mode |
| `p-limit` in `cmdEnrich --pending` | `cmdEnrich` | Replaces sequential `for` loop |
| Progress output moved to `console.error()` | `cmdEnrich`, `cmdWatch` | Preserves stdout for piping |
| Final enrich summary as JSON on stdout | `cmdEnrich --pending` | Machine-readable result |
| `exitCodeForS3Error()` helper | `smgr.ts` | Maps S3 error classification to exit codes |
