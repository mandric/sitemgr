## Coding Principles

### Don't reshape data without a reason

When a library or service returns a consistent shape (e.g. Supabase's `{ data, error }`), pass it through as-is. Do not re-wrap, strip fields, map to thrown exceptions, or invent custom return shapes in intermediate layers. Callers decide how to handle the result — the db/data layer's job is query encapsulation, not return value transformation.

This applies to error objects too — preserve the full object (`code`, `details`, `hint`, etc). Only strip or redact fields when there's a concrete reason (e.g. hiding internals from end users).

## Key Decisions

### v1 is cloud-based (not local-first)

- **Supabase Postgres** is the event store (not per-device SQLite)
- **Supabase Storage** (S3-compatible) for media (not BYO S3 — that's backlog)
- **Online required** — no offline support in v1
- **Vercel API routes** for the WhatsApp bot webhook handler (migrated from Supabase Edge Functions)
- Local-first/offline with SQLite is deferred to a future version

### Environment Variables & Secrets Strategy

**Core Principle: Tests use fixtures, production uses secrets**

**Encryption Keys (Status-Based Naming):**
- `ENCRYPTION_KEY_CURRENT` - Active key for new encryptions (required wherever the Next.js app runs: production, preview, local dev, E2E)
- `ENCRYPTION_KEY_PREVIOUS` - Old key for decryption during rotation (optional in production)
- `ENCRYPTION_KEY_NEXT` - Future key for gradual rollout (optional in production)
- **DO NOT USE**: `ENCRYPTION_KEY`, `ENCRYPTION_KEY_V1`, `ENCRYPTION_KEY_V2`, `ENCRYPTION_KEY_V3` (legacy, removed)
- **DO NOT USE**: `SUPABASE_SECRET_KEY` (renamed to `SUPABASE_SERVICE_ROLE_KEY`, removed from runtime)

**Supabase Service Role Key (Test/Admin + Device Auth Exception):**
- Application code (CLI, agent core, health endpoint, webhook handler) **never** uses the service role key
- **Exception:** `/api/auth/device/approve` uses the service role key solely for `admin.generateLink()` to generate a magic link token hash during device code approval. This endpoint is itself authenticated (user must be logged in via cookie session). This is the only application endpoint with this exception. Evaluating alternatives (service account, edge function) is deferred to a future spec.
- The service role key only appears in: `.env.local` (for integration tests), integration test setup (`setup.ts`), CI deployment scripts, `scripts/setup/verify.sh`, and the device approve endpoint
- The WhatsApp webhook uses a dedicated service account (`webhook@sitemgr.internal`) with narrowly-scoped RLS policies instead of the service role key
- `WEBHOOK_SERVICE_ACCOUNT_EMAIL` and `WEBHOOK_SERVICE_ACCOUNT_PASSWORD` are Vercel Production runtime secrets for the webhook handler

**Where Secrets Live:**
- **Vercel Production**: All runtime secrets for deployed app (includes `SUPABASE_SERVICE_ROLE_KEY` — used only by `/api/auth/device/approve` for `admin.generateLink()`)
- **GitHub Production Environment**: Only deployment secrets (VERCEL_TOKEN, SUPABASE_ACCESS_TOKEN, SUPABASE_SERVICE_ROLE_KEY for storage bucket creation)
- **NO GitHub secrets for tests**: Tests use `vi.stubEnv()` with fixture values, not real secrets
- **NO repository secrets**: GitHub repository-level secrets NOT used (only environment-level)

**Testing Pattern (IMPORTANT):**

When to use `vi.stubEnv()` (fixtures) vs setting in CI:
- **Use fixtures**: When testing logic that uses the env var internally (encryption, business logic, API clients)
  - The value doesn't need to connect to a real service
  - Example: `ENCRYPTION_KEY_CURRENT` - tests the encryption algorithm, not a remote service
- **Set in CI**: When the test connects to an actual running service
  - The value must match the service instance
  - Example: `NEXT_PUBLIC_SUPABASE_URL` - E2E test connects to real local Supabase instance

**Unit/Integration Tests:**
- Always use `vi.stubEnv()` with test fixture values
  ```typescript
  beforeEach(() => {
    vi.stubEnv("ENCRYPTION_KEY_CURRENT", "test-fixture-key");
  });
  ```

**E2E Tests (three runtimes):**

E2E involves three separate runtimes, each with different env var needs:
1. **Supabase** (Postgres, Auth, Storage) — started via `supabase start`, configured by `supabase/config.toml`
2. **Next.js web app** (API routes + frontend) — the system under test, needs all env vars required for request handling
3. **Playwright test runner** — drives the browser, only needs the app URL and Supabase URL/key to set up test users

The web app needs `ENCRYPTION_KEY_CURRENT` in `.env.local` because API routes encrypt/decrypt bucket config secrets at request time. This must be a valid encryption key (correct length/format for AES) since data round-trips through Supabase during E2E — it's a **local dev secret**, not a throwaway fixture. It should never be reused in production.

- **Supabase runtime**: No app-level env vars needed (configured via `config.toml`)
- **Next.js runtime** (`.env.local`): `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `ENCRYPTION_KEY_CURRENT` (local dev secret)
- **Playwright runtime**: Only needs the app URL to connect to
- Not API keys (E2E doesn't call external APIs)

**Never add production secrets to GitHub for tests** - use fixtures instead

**Encryption Format:**
- Current format: `current:base64ciphertext` (label-prefixed)
- Legacy format: `base64ciphertext` (no prefix, assumed "previous")
- Lazy migration: Data auto-migrates to current key on access (non-blocking background update)

**Key Rotation Process (Production Only):**
1. Add `ENCRYPTION_KEY_NEXT` in Vercel
2. Validate NEXT key works (run tests locally with stubbed NEXT key)
3. Promote NEXT to CURRENT (save old CURRENT as PREVIOUS first)
4. Deploy and monitor logs for lazy migration messages
5. After migration completes, remove PREVIOUS from Vercel

**See `docs/ENV_VARS.md` for detailed procedures**

### Development & Deployment Workflow

**Three environments: Local → Preview → Production**

**Local (dev):**
- `supabase start` — local Postgres, Auth, Storage, etc. (Docker)
- `vercel dev` or `next dev` — local frontend + API routes
- All services run on your machine; no cloud dependencies
- This is the primary development loop — get things working here first

**Preview:**
- Vercel auto-creates preview deployments on PRs
- Separate Supabase project for preview (not yet set up — backlog)
- Preview environment is fully isolated from production
- DB migrations must be applied to preview Supabase project separately

**Production:**
- Merge to `main` triggers Vercel production deploy (frontend + API routes)
- DB migrations deploy via GitHub Actions using `SUPABASE_ACCESS_TOKEN`
- These are two separate deploy pipelines — Vercel owns app, GitHub owns DB

**Known gaps / CI-CD backlog:**
- Preview Supabase environment not yet configured
- App and DB deploy pipelines are decoupled (Vercel vs GitHub Actions) — works but fragile
- No automated rollback if DB migration succeeds but app deploy fails (or vice versa)

### Planning Artifacts

- `project-manifest.md` — Split structure, dependencies, and execution order
- `01-data-foundation/spec.md` through `05-cli/spec.md` — Per-split specs for `/deep-plan`
- Files under `specs/` are **immutable after implementation** — do not update them during refactors or renames. They are historical records of the plan at the time it was executed.

### Backlog items (not v1 scope)

- BYO S3-compatible storage (any provider, not just Supabase)
- Local-first / offline mode with per-device SQLite
- Enrichment metadata as sidecar files in S3 (post-prototype idea)

## Autonomous Operation

### Decision-Making Heuristics

When running autonomously (via `/plan-next`, triggers, or background sessions), follow these rules to avoid blocking on human input:

**Always safe to do without asking:**
- Run tests, typecheck, lint, build
- Read any file in the repo
- Create/switch branches
- Fix failing tests by reading test expectations and matching source code
- Add new test files following existing patterns
- Push to `claude/*` branches
- Create PRs via `gh pr create`

**Make your best judgment (don't ask):**
- Choose between two reasonable implementation approaches — pick the simpler one
- Decide on function/variable naming — match neighboring code style
- Choose where to put new code — follow the existing module structure in `lib/`
- Handle edge cases — follow patterns from similar code in the repo
- Code review triage — auto-fix obvious improvements, let go of nitpicks, only ask about genuine tradeoffs
- Context/compaction prompts — skip "continue or compact?" prompts when context usage is low (<50%). Just continue. Only prompt if context is actually near capacity (>80%)
- Plugin workflow pauses — if a plugin skill (e.g. `/deep-implement`) has optional "wait for user" checkpoints, skip them during autonomous operation unless there's a genuine decision that requires human judgment

**Stop and report (don't guess):**
- Database schema changes (new migrations, RLS policy changes)
- Changes to auth flows or security-sensitive code
- Adding new environment variables to production
- Deleting or significantly restructuring existing features
- Anything that would change the public API contract

### Verification Checklist

Before considering any implementation task done, run:
```bash
cd web && npm run typecheck && npm run lint && npm run test && npm run test:integration && npm run build
```
All five must pass. If any fail, fix them before committing.

### Post-Implementation Checklist (mandatory)

After completing any feature implementation (via `/deep-implement`, manual, or any other method):

1. **Run `/verify`** — all checks must pass (typecheck, lint, unit tests, integration tests, build)
2. **Push and create/update PR** — push to `claude/*` branch, create or update the PR with a summary
3. **Run `/code-review`** on the PR — this posts review comments
4. **Address review findings:**
   - Clear bugs or correctness issues → fix, commit, push
   - Style/quality aligned with project conventions → fix, commit, push
   - Subjective or architectural suggestions → note for the human, don't act
5. **Re-verify after fixes** — run `/verify` again if you made changes
6. **Update PR description** — reflect final state: what was built, what was fixed, what needs human attention
7. **Present for human review:**
   - PR URL
   - Summary of what was implemented
   - Code review: what was fixed autonomously, what was left for human judgment
   - Any items needing human attention before merge
   - **Stop here.** The user decides when to merge.

**Note:** `npm run test` runs unit tests only (`vitest run --project unit`). Integration tests (`test:integration`) and E2E tests (`test:e2e`) both require local Supabase and the web app running. The session-start hook starts Supabase automatically. The minimum version constant (`SUPABASE_MIN_VERSION`) and install/start helpers live in `scripts/lib.sh`.

**Docker and Supabase are always available** in web sessions — both can be installed and started. Do NOT skip integration tests because of infrastructure setup issues — fix the setup and run them.

**Docker proxy setup (web sessions):** Docker can't resolve DNS directly in container environments. It needs the egress proxy. The session-start hook handles this automatically with `sudo -E dockerd` (the `-E` flag passes `HTTP_PROXY`/`HTTPS_PROXY` from the shell). If Docker pulls fail manually, ensure you use `sudo -E`.

**Next.js dev server for integration tests:** Some integration tests (device-auth, e2e) need the Next.js dev server running. The globalSetup auto-spawns it, but if it fails, start manually: `npx next dev --port 3000 &>/tmp/next-dev.log &` with the required env vars (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `ENCRYPTION_KEY_CURRENT`).

**Supabase Realtime is disabled** in `supabase/config.toml` — it requires IPv6 which is unavailable in container environments (Claude Code web sessions, CI). We don't use Realtime in v1. If re-enabling, test in a container environment first.

### Slash Commands for Autonomous Work

- `/plan-next` — Pick the next task, research it deeply, and produce an autonomous implementation plan
- `/verify` — Run typecheck + lint + test + build, fix any issues
- `/code-review` — Review PRs with multi-agent confidence-scored analysis (plugin skill, not a standalone command)

## Installing Claude Code Plugins for Web Sessions

When installing a Claude Code plugin so it works in the web interface (claude.ai), follow this pattern:

### 1. Add the plugin source to `.claude/plugins/<name>/`

Copy or clone the plugin into `.claude/plugins/<name>/`. The plugin must have a `.claude-plugin/plugin.json` with name, version, and description.

### 2. Register in the local marketplace

Add an entry to `.claude/plugins/.claude-plugin/marketplace.json` under `local-plugins.plugins`:

```json
{
  "name": "<name>",
  "version": "<version>",
  "description": "...",
  "path": "../<name>"
}
```

### 3. Enable in settings.json

Add to `.claude/settings.json`:

```json
{
  "enabledPlugins": {
    "<name>@local-plugins": true
  }
}
```

### 4. Install runtime dependencies via session-start hook

Web sessions start from a clean environment. Any tools the plugin needs (e.g. `uv`, `gh`) must be installed by the session-start hook at `.claude/hooks/session-start.sh`. Guard installs with `command -v` checks and only run in remote environments (check for absence of interactive terminal or presence of cloud markers). The hook is registered in `settings.json` under `hooks.SessionStart`.

### 5. Standalone commands

For slash commands that should be discoverable without a plugin, place the `.md` file in `.claude/commands/<command-name>.md`. These are available as `/<command-name>` in any session.

### Key files

- `.claude/settings.json` — plugin enablement, hooks
- `.claude/hooks/session-start.sh` — runtime dependency installation
- `.claude/plugins/.claude-plugin/marketplace.json` — local plugin registry
- `.claude/plugins/<name>/` — plugin source
- `.claude/commands/` — standalone slash commands
