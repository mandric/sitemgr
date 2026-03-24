# Codebase Research — 06-fix-ci-pipeline

## 1. Integration Test Infrastructure

### Configuration
- **Framework**: Vitest with `projects` config in `web/vitest.config.ts`
- **Integration project**: `__tests__/integration/**/*.test.ts`, `testTimeout: 60000`, `hookTimeout: 30000`, `fileParallelism: false`
- **Global setup**: `__tests__/integration/globalSetup.ts` — validates Supabase availability before tests run

### Test Files (4 suites, ~1027 lines)
| File | Purpose | Cleanup Pattern |
|------|---------|-----------------|
| `schema-contract.test.ts` | Schema validation via `schema_info()` RPC | No cleanup (read-only) |
| `tenant-isolation.test.ts` | Multi-tenant RLS isolation | `cleanupUserData()` for both users |
| `media-lifecycle.test.ts` | Full user journey: upload→search→stats | Manual S3 cleanup + `cleanupUserData()` |
| `media-storage.test.ts` | S3-compatible storage operations | S3 key removal + bucket deletion |

### Client Cleanup Patterns
- **No `removeAllChannels()` or `auth.signOut()` calls anywhere** in test teardown
- All clients created with `autoRefreshToken: false, persistSession: false`
- Cleanup is data-only (delete rows + delete auth users), NOT client lifecycle

### Dangling Handle Root Cause
The Supabase JS client maintains internal connections (GoTrue auth refresh timer, realtime WebSocket potential). Even with `autoRefreshToken: false`, the client keeps Node.js handles alive. No test file calls any client disposal method in `afterAll`.

## 2. E2E Test Infrastructure

### Playwright Config (`web/playwright.config.ts`)
- `testDir: './e2e'`, `fullyParallel: true`
- CI-specific: `retries: 2`, `workers: 1`, `forbidOnly: true`
- **No explicit test timeout** — uses Playwright default (30s)
- Web server: `npm run dev` with 120s startup timeout, `baseURL: 'http://localhost:3000'`

### E2E beforeAll Issue
- `agent.spec.ts` `beforeAll` creates user via signup form, then calls `getConfirmationLink()` which retries up to 10 times with exponential backoff (up to ~50s total)
- Playwright default timeout is **30s** — insufficient for the email confirmation flow
- No explicit timeout parameter on `test.beforeAll()`

## 3. CI Workflow Structure

### Jobs: lint → build → unit-tests → integration-tests → e2e-tests → deploy

### Integration Tests Env Vars
- Extracted from `supabase status -o json` into `$GITHUB_ENV`
- 7 vars set: `SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SUPABASE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `S3_ENDPOINT_URL`, AWS credentials
- Verification step validates required vars before running tests

### E2E Tests Env Vars
- Only 2 vars extracted: `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`
- Written to `.env.local` via printf (currently heredoc in original, but edited to printf)
- Next.js auto-loads `.env.local`

### .env.local Generation Analysis
The original heredoc pattern:
```yaml
cat > .env.local <<EOF
          # Comment
          NEXT_PUBLIC_SUPABASE_URL=...
          EOF
```
YAML `|` block scalar strips base indentation consistently, so the shell receives content at column 0. The heredoc itself is likely fine — the E2E failure is primarily the **timeout issue**, not whitespace. However, the printf pattern is cleaner and unambiguous.

## 4. Supabase RPC Function Grants

### search_events, stats_by_content_type, stats_by_event_type
- **No explicit GRANT statements** in any migration
- Created with `LANGUAGE sql STABLE` (not `SECURITY DEFINER`)
- PostgreSQL default + Supabase: Functions are executable by `PUBLIC` unless explicitly revoked
- **Supabase auto-grants EXECUTE to authenticated/anon roles** by default
- Result: Authenticated users CAN call these functions

### get_user_id_from_phone, schema_info
- **Explicitly restricted** to `service_role` only
- `REVOKE EXECUTE FROM PUBLIC, authenticated, anon` + `GRANT EXECUTE TO service_role`

### RLS Interaction with RPC Functions
Since functions are NOT `SECURITY DEFINER`, they run with the **caller's privileges**:
- Alice calling `search_events` → RLS on `enrichments` and `events` applies with `auth.uid() = alice_id`
- The function's `WHERE e.user_id = p_user_id` provides additional filtering
- Both tables' RLS policies allow SELECT where `auth.uid() = user_id`

## 5. search_events Return Type — Critical Finding

### RETURNS TABLE does NOT include user_id
```sql
RETURNS TABLE(
    id TEXT,
    "timestamp" TIMESTAMPTZ,
    device_id TEXT,
    "type" TEXT,
    content_type TEXT,
    content_hash TEXT,
    local_path TEXT,
    remote_path TEXT,
    metadata JSONB,
    parent_id TEXT,
    description TEXT,
    objects TEXT[],
    context TEXT,
    tags TEXT[]
)
```

### Impact on Tests
- `tenant-isolation.test.ts` line 201: `data.every((r: { user_id: string }) => r.user_id === aliceId)` → `r.user_id` is always `undefined`
- The `if (data && data.length > 0)` guard hides this bug — if data IS returned, the assertion would FAIL
- **media-lifecycle.test.ts** uses correct pattern: matches by `r.id` (event ID), not `r.user_id`

## 6. Testing Patterns Summary

### Key Conventions
- Unit tests: `vi.stubEnv()` with fixture values, `vi.unstubAllEnvs()` in afterEach
- Integration tests: Real Supabase clients, real data, real cleanup
- E2E tests: Playwright, `.env.local` for Next.js, Mailpit for email confirmation
- All tests: No production secrets, fixtures only
