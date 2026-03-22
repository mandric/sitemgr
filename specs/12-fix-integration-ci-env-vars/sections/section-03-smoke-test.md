Now I have all the context needed. Let me produce the section content.

# Section 3: Smoke Test Improvements

## Overview

This section adds retry logic and improved diagnostic output to the `smoke_test` function in `/home/user/sitemgr/scripts/lib.sh`. The goal is to handle transient cold-start failures in production deploys (retry on connection errors or generic 5xx) while failing fast on configuration errors (HTTP response with `status: "degraded"`).

This section has no dependencies on Sections 1 or 2 and can be implemented independently.

## Background

The `smoke_test` function in `scripts/lib.sh` runs after production deploys to verify the health endpoint is working. It currently makes a single `curl` request to `/api/health` and fails if the status is not `"ok"`. The problem: Vercel cold-starts can cause transient 5xx responses on the first request after deploy. A single-shot check conflates transient failures with real configuration errors, leading to false alarms.

The health endpoint returns `{"status": "degraded", "checks": {...}}` with HTTP 503 when required environment variables are missing. This is a configuration error that will not resolve on retry, so the smoke test should fail immediately in this case.

## Current Implementation

The current `smoke_test` function lives at `/home/user/sitemgr/scripts/lib.sh`, starting at line 21. The health check portion (lines 30-49) does:

1. A single `curl -sS` to `$deploy_url/api/health`, capturing HTTP status code and body
2. Extracts `.status` from the JSON response via `jq`
3. If status is not `"ok"`, prints failure details and returns 1
4. If status is `"ok"`, proceeds to the webhook POST test (lines 54-70)

## Tests

These are behavioral descriptions for the bash function. Direct unit testing of bash functions is heavyweight; validation is primarily through CI observation and manual testing.

```bash
# Test: smoke_test retries on connection refused (curl exit code != 0)
# Test: smoke_test retries on HTTP 5xx without "degraded" in body
# Test: smoke_test fails immediately on HTTP 503 with status "degraded" (no retry)
# Test: smoke_test succeeds on first attempt if health returns status "ok"
# Test: smoke_test succeeds on retry if first attempt fails but second succeeds
# Test: smoke_test prints attempt number and result on each try
# Test: smoke_test exits with failure after max retries exhausted
# Test: each failed attempt prints HTTP status code
# Test: each failed attempt prints response body
# Test: connection errors print curl exit code
# Test: final failure prints summary with attempt count
```

**Validation approach:**
- Manual validation: start a local server that returns 503, verify `smoke_test` retries
- Manual validation: start a local server that returns `{"status":"degraded"}`, verify immediate failure
- CI validation: `smoke_test` runs against live deploy after production merge

## Implementation

### File to modify

`/home/user/sitemgr/scripts/lib.sh` -- modify the `smoke_test` function (lines 21-71).

### Changes to the health check portion

Replace the single-shot health check (current lines 30-49) with a retry loop. The webhook POST portion (lines 54-70) stays as-is but only executes after the health check passes.

### Retry logic design

The health check should be wrapped in a loop with these parameters:
- **Max attempts:** 3
- **Delay between retries:** 5 seconds

Each attempt should:
1. Print the attempt number (e.g., `"Health check attempt 1/3..."`)
2. Run `curl -sS -o /tmp/health.json -w '%{http_code}' "$health_url"`
3. Capture the curl exit code

**Decision tree after each attempt:**

- **curl fails (exit code != 0):** This is a connection error (server not yet responding). Print the curl exit code, sleep 5s, retry.
- **curl succeeds, response contains `"status": "ok"`:** Health check passed. Break out of the loop and proceed to webhook POST.
- **curl succeeds, response contains `"status": "degraded"`:** This is a configuration error. Print full diagnostic output (HTTP status, response body, individual check results from `.checks`). Fail immediately with `return 1` -- do NOT retry.
- **curl succeeds, HTTP 5xx, body does NOT contain `"degraded"`:** Transient server error. Print the HTTP status and response body. Sleep 5s, retry.
- **curl succeeds, other non-200 status:** Unexpected response. Print diagnostics, sleep 5s, retry.

**After all retries exhausted:** Print a summary indicating the number of attempts made and that all failed, then `return 1`.

### Diagnostic output requirements

On each failed attempt, print:
- The attempt number out of max (e.g., `"Attempt 1/3"`)
- The HTTP status code (or curl exit code for connection errors)
- The response body (if available)

On `"degraded"` status (immediate failure), additionally print:
- The individual check results from `.checks` (using the existing `jq` expression: `jq -r '.checks | to_entries[] | "  \(.key): \(.value)"'`)
- A clear message indicating this is a configuration error, not a transient failure

On final failure after retries exhausted, print:
- A summary banner similar to the existing `"HEALTH CHECK FAILED"` banner
- The total number of attempts made

### Structure of the modified function

The function signature and URL setup (lines 21-28) remain unchanged. The flow becomes:

1. URL setup (unchanged)
2. Health check retry loop (new)
   - Loop up to 3 times
   - On each iteration: curl, check result, decide retry/fail/pass
   - On success: break and continue
   - On `"degraded"`: fail immediately
   - On exhaustion: fail with summary
3. Webhook POST test (unchanged, lines 54-70 of current code)

### Important notes

- Use a `for` loop with a counter variable, not a `while` loop, to make the attempt count clear
- The `/tmp/health.json` temp file is reused across attempts (overwritten each time) -- this is fine
- The 5-second delay uses `sleep 5` (same pattern as other scripts in the codebase)
- The function returns 1 on failure (not `exit 1`) -- this is the existing convention and must be preserved so sourcing scripts are not terminated