# Integration Notes: Opus Review Feedback

## Integrating

### 1. Agent core stays on direct db.ts imports (Recommendation 1a)
**Integrating.** The reviewer is right — agent core runs server-side on the same Vercel deployment. Routing it through HTTP adds latency, cold start amplification, and a fake auth problem. Once db.ts is parameterized, agent core just passes config from env vars. Only the CLI needs the HTTP API.

### 2. Add `/api/auth/refresh` endpoint (Recommendation 2b)
**Integrating.** Supabase JWTs expire in 1 hour. Long-running CLI commands (e.g., `smgr enrich --pending` processing hundreds of items) would fail mid-session. A refresh endpoint is trivial to add and prevents real user pain.

### 3. Resolve userId scoping (Recommendation 2c)
**Integrating.** API routes will extract userId from the JWT (via `supabase.auth.getUser()`). The JWT is the sole source of user identity. No `userId` query params — this eliminates the authorization concern of user A querying user B's data.

### 4. Define API contracts (Recommendation 2a)
**Integrating.** Will add request/response schemas to the plan for each endpoint.

### 5. Address `process.env.SMGR_DEVICE_ID` in getStats (Recommendation 1d)
**Integrating.** Will make `device_id` a parameter to `getStats()` instead of reading env vars directly. API route passes it from request or defaults to "web". CLI passes from env.

### 6. Update tests alongside each step (Recommendation 4a)
**Integrating.** Each section will include its test updates rather than a monolithic test rewrite at the end.

### 7. Delete barrel export early (Recommendation 4c)
**Integrating.** Will move barrel deletion to Section 1 alongside db.ts refactoring.

### 8. Missing bucket CRUD endpoints (Recommendation 2e)
**Not needed** since agent core now stays on direct db.ts imports. Bucket operations (addBucket, removeBucket, listBuckets) and encryption handling remain inside core.ts with direct Supabase access.

### 9. `{ data, error }` at API boundary (Recommendation 1c)
**Integrating.** Will document this as a deliberate deviation. At the HTTP boundary, `{ data, error }` is replaced by HTTP status codes + JSON body. The API client throws `ApiError` on non-2xx. This is the right shape for an HTTP client — callers expect thrown errors, not Supabase-style result objects.

## Not Integrating

### Split into two PRs (Recommendation 1b)
**Not integrating.** The user explicitly chose "big bang" and "full API abstraction" as scope. While splitting is lower risk, the user's preference is clear. The plan maintains ordered commits for bisectability.

### Rate limiting on /api/auth/login (Recommendation 3c)
**Not integrating.** Supabase Auth has built-in rate limiting on `signInWithPassword`. Adding Vercel-level rate limiting is out of scope. Can be added later if needed.

### Concurrent credentials file access (Recommendation 3b)
**Not integrating.** This is a pre-existing issue, not introduced by this migration. The credential file pattern is unchanged. Can be addressed separately.

### Health endpoint information disclosure (Recommendation 3d)
**Not integrating in plan.** The current health endpoint already returns only "ok"/"degraded" with no error details. This is already safe.
