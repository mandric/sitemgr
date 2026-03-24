# Research Findings — Fix Remaining Integration Failures

## Codebase Research

### Test Infrastructure

- **Vitest** with separate unit/integration projects. Integration tests run with `fileParallelism: false` (sequential) and 60s timeout.
- **Global setup** (`globalSetup.ts`): Validates Supabase is running, spawns `npm run dev` if needed, maps `SMGR_API_URL` → `NEXT_PUBLIC_SUPABASE_URL`.
- **Test helpers** (`setup.ts`):
  - `getAdminClient()`: Service role client (bypasses RLS)
  - `getS3Config()`: Returns `{ endpoint, region, accessKeyId, secretAccessKey, forcePathStyle }` — endpoint is `{SUPABASE_URL}/storage/v1/s3`
  - `createTestUser()`: Creates auth user + signs in → returns `{ userId, client }`
  - `seedUserData()`: Inserts in dependency order — profiles → events (`content_type: "image/jpeg"`) → enrichments → watched_keys → bucket_configs → conversations
  - `cleanupUserData()`: Deletes in reverse dependency order with soft error handling

### S3/Storage Patterns

- `createS3Client(config)` in `web/lib/media/s3.ts` reads `SMGR_S3_ENDPOINT`, `SMGR_S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`
- E2E test uploads fixtures to local Supabase Storage via `getS3Config()` but the `E2E_ENV` object passed to CLI subprocesses was **missing** S3 endpoint and credentials — the CLI subprocess couldn't find the locally-uploaded objects

### CLI Test Patterns

- `cliEnv(extra)` builds subprocess environment: spreads `process.env`, sets `HOME: tempHome`, and overlays `extra`
- `beforeAll` creates `~/.sitemgr/credentials.json` in `tempHome` with real session tokens
- `requireUserId()` in `web/bin/smgr.ts:106-118`: checks `SMGR_USER_ID` env var → falls back to `loadCredentials()` from `~/.sitemgr/credentials.json` → throws error
- The "missing SMGR_USER_ID" test set `SMGR_USER_ID: ""` but didn't override `HOME`, so the credential file fallback succeeded

### Content Type Duality

- **Stored in events**: MIME types like `image/jpeg`, `video/mp4`
- **Some code uses**: Semantic types like `"photo"`, `"video"` (via `CONTENT_TYPE_MAP` in constants.ts)
- **Mismatch**: `getEnrichStatus()`, `getStats()`, and `getPendingEnrichments()` all filtered on `.eq("content_type", "photo")` but actual data has `"image/jpeg"`
- **Detection**: `detectContentType()` in utils.ts maps `image/*` → `"photo"` for display, but events store the raw MIME type
- Seed data uses `content_type: "image/jpeg"`, CLI FTS tests use `content_type: "photo"` — inconsistent

### Database Function History

- `get_user_id_from_phone`: Created (20260306), restricted to service_role (20260313), re-granted to authenticated (20260321 for webhook)
- The re-grant was too broad — all authenticated users could call it, breaking tenant isolation
- Tenant isolation test expects regular users to be denied

### CI Configuration

- Three Supabase CLI usages in ci.yml: integration-tests, e2e-tests, deploy
- All were using `version: latest` which could pull broken versions
- CI extracts S3 credentials from `supabase status` and sets `SMGR_S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, etc. as env vars

---

## Web Research

### 1. Supabase CLI ES256 JWT Fix

**Timeline:**
- CLI v2.71.1 (late 2025): Changed default JWT signing from HS256 to ES256 without migration docs
- CLI v2.76.3: Broken — Studio sent HS256 tokens while GoTrue expected ES256
- **CLI v2.76.4** (Feb 8, 2026): Fix released via PR #4821 ("set correct valid methods env var")
  - Reporter of issue #4820 confirmed "2.76.4 fixed it for me"
- Latest CLI: v2.78.1

**Recommendation:** Pin to CLI >= 2.76.4 for stable local development. Watch issue #4726 for `jwt_algorithm` config option.

**Sources:**
- [Issue #4820](https://github.com/supabase/cli/issues/4820)
- [Release v2.76.4](https://github.com/supabase/cli/releases/tag/v2.76.4)
- [Issue #4726](https://github.com/supabase/cli/issues/4726)

### 2. Postgres SECURITY DEFINER Function Patterns

**Core problem:** Postgres `GRANT EXECUTE` operates at the role level, not per-user. All Supabase authenticated users share the `authenticated` role.

**Recommended patterns for per-user restriction:**

1. **Email-based caller check** (best for this case):
   ```sql
   IF (auth.jwt() ->> 'email') != 'webhook@sitemgr.internal' THEN
     RAISE EXCEPTION 'Unauthorized';
   END IF;
   ```

2. **Role-based check via `current_setting`:**
   ```sql
   IF current_setting('request.jwt.claim.role', true) != 'service_role' THEN
     RAISE EXCEPTION 'Unauthorized';
   END IF;
   ```

3. **Private schema** — place functions in non-public schema to hide from PostgREST API

**Best practices:**
- Always set `search_path = ''` on SECURITY DEFINER functions
- Use `auth.jwt()` for email checks (not `user_metadata` which users can modify)
- Don't use `auth.uid()` from `auth.users` table lookup when JWT claims suffice (performance)

**Sources:**
- [Supabase Database Functions docs](https://supabase.com/docs/guides/database/functions)
- [Discussion #3269](https://github.com/orgs/supabase/discussions/3269)

### 3. Vitest Integration Test Isolation

**Key findings:**

- `vi.stubEnv()` modifies `process.env` in-process only; child processes inherit `process.env` but Vitest instrumentation doesn't extend to subprocesses
- For subprocess tests: explicitly construct `env` option in `spawn`/`exec`/`fork`
- For filesystem isolation: use `test.extend` with `mkdtemp` + cleanup via `use` callback, or `mkdtempSync` with `beforeEach`/`afterEach`
- Set `HOME: tmpdir` in subprocess env for config file isolation

**Recommended patterns:**
| Concern | Pattern |
|---------|---------|
| Env vars in subprocess | Explicit `env` in `spawn`/`exec` |
| Filesystem isolation | `mkdtempSync` + set as `HOME` |
| Cleanup | `rmSync(dir, { recursive: true, force: true })` in `afterEach` |

**Sources:**
- [Vitest vi API — stubEnv](https://vitest.dev/api/vi.html)
- [sdorra.dev — Using temporary files with Vitest](https://sdorra.dev/posts/2024-02-12-vitest-tmpdir)
- [Vitest Discussion #2911](https://github.com/vitest-dev/vitest/discussions/2911)

---

## Testing Setup Summary

- **Framework:** Vitest with separate unit/integration projects
- **Integration config:** Sequential file execution, 60s timeout, 30s hook timeout
- **Patterns:** `createTestUser()` → `seedUserData()` → test → `cleanupUserData()`
- **CLI tests:** Spawn `tsx bin/smgr.ts` with explicit env, isolated `HOME`
- **E2E tests:** Upload fixtures to local S3, invoke CLI, verify enrichments
