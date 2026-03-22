# TDD Plan: Fix Integration CI Env Vars

Companion to `claude-plan.md`. Defines what tests to write BEFORE implementing each section.

**Testing framework:** Vitest (unit + integration projects), bash assertions for CI/shell changes.

---

## Section 1: CI Workflow — Add NEXT_PUBLIC Env Vars

### 1a. Add env vars to "Configure environment for smgr" step

No automated test — this is a CI workflow YAML change. Validated by:

```bash
# Test: CI workflow YAML is valid (parse check)
# Test: "Configure environment for smgr" step sets NEXT_PUBLIC_SUPABASE_URL from SMGR_API_URL
# Test: "Configure environment for smgr" step sets NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY from SMGR_API_KEY
# Test: NEXT_PUBLIC_* lines appear before SMGR_S3_* lines in the step
```

Validation: grep the ci.yml for expected patterns after editing.

### 1b. Add NEXT_PUBLIC_* to verification step

```bash
# Test: "Verify integration test env vars" step checks NEXT_PUBLIC_SUPABASE_URL
# Test: "Verify integration test env vars" step checks NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
# Test: Verification step fails fast if NEXT_PUBLIC_SUPABASE_URL is empty
# Test: Verification step fails fast if NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is empty
```

Validation: grep the ci.yml for the new var names in the verification block.

---

## Section 2: globalSetup.ts — Defensive Env Var Mapping

### Env var fallback in spawn call

```typescript
// Test: spawn env includes NEXT_PUBLIC_SUPABASE_URL when it's already in process.env
// Test: spawn env falls back NEXT_PUBLIC_SUPABASE_URL to SMGR_API_URL when NEXT_PUBLIC is not set
// Test: spawn env falls back NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY to SMGR_API_KEY when NEXT_PUBLIC is not set
// Test: spawn env preserves NEXT_PUBLIC value when BOTH NEXT_PUBLIC and SMGR are set (NEXT_PUBLIC wins)
// Test: spawn env includes PORT: "3000"
// Test: spawn env spreads existing process.env
```

These are unit-level checks. The globalSetup file is a Vitest setup module, so testing the env construction logic directly is tricky (it's not a regular importable module). Options:

1. **Extract the env construction** into a small helper function that can be tested independently
2. **Inline verification** via the existing integration test run — if the dev server starts and health returns 200, the env vars are correct

Recommend option 2 (inline verification via CI) for this simple change. The integration test run itself is the test — if the dev server starts, the env was correct.

---

## Section 3: Smoke Test Improvements

### Retry logic

```bash
# Test: smoke_test retries on connection refused (curl exit code != 0)
# Test: smoke_test retries on HTTP 5xx without "degraded" in body
# Test: smoke_test fails immediately on HTTP 503 with status "degraded" (no retry)
# Test: smoke_test succeeds on first attempt if health returns status "ok"
# Test: smoke_test succeeds on retry if first attempt fails but second succeeds
# Test: smoke_test prints attempt number and result on each try
# Test: smoke_test exits with failure after max retries exhausted
```

These are behavioral descriptions for the bash function. Direct unit testing of bash is possible but heavy. Validation approach:

```bash
# Manual validation: start a server that returns 503, verify smoke_test retries
# Manual validation: start a server that returns {"status":"degraded"}, verify immediate failure
# CI validation: smoke_test runs against live deploy after production merge
```

### Diagnostic output

```bash
# Test: each failed attempt prints HTTP status code
# Test: each failed attempt prints response body
# Test: connection errors print curl exit code
# Test: final failure prints summary with attempt count
```

---

## Cross-Section Integration

```bash
# Test: integration test job passes end-to-end (dev server starts, health returns 200, tests run)
# Test: smoke test passes against production deploy after merge
```

These are validated by the CI pipeline itself — no additional test files needed.
