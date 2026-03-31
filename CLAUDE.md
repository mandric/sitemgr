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
- **Exception:** `/api/auth/device/approve` uses the service role key for `admin.generateLink()` to generate a magic link token hash during device code approval, and for the `device_codes` table lookup and update (service role bypasses RLS). This endpoint is itself authenticated (user must be logged in via cookie session). This is the only application endpoint with this exception. Evaluating alternatives (service account, edge function) is deferred to a future spec.
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
- **Next.js runtime** (`.env.local`): `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `ENCRYPTION_KEY_CURRENT` (local dev secret)
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
- **`specs/` is the source of truth for all features, bugs, and refactors.** Each gets a numbered directory (`specs/<NN>-<name>/spec.md`). Use `/plan-next` to pick the next spec, plan it, and implement it.
- Files under `specs/` are **immutable after implementation** — do not update them during refactors or renames. They are historical records of the plan at the time it was executed.

### Backlog items (not v1 scope)

- BYO S3-compatible storage (any provider, not just Supabase)
- Local-first / offline mode with per-device SQLite
- Enrichment metadata as sidecar files in S3 (post-prototype idea)

## Autonomous Operation

### Core Principle: Fix First, Ask Second

Claude acts as **first-tier support**. When something fails — a test, a lint rule, a build, a CI check, a code review finding — Claude's default behavior is to **diagnose and fix it**, not escalate to the human. Only escalate after genuine investigation and multiple fix attempts.

This applies to every phase: implementation, verification, code review, and CI.

### Decision-Making Heuristics

When running autonomously (via `/plan-next`, triggers, or background sessions), follow these rules:

**Always safe to do without asking:**
- Run tests, typecheck, lint, build
- Read any file in the repo
- Create/switch branches
- Fix failing tests by reading test expectations and matching source code
- Fix lint/typecheck errors, then re-run the failing check
- Add new test files following existing patterns
- Push to `claude/*` branches
- Create PRs

**Make your best judgment (don't ask):**
- Choose between two reasonable implementation approaches — pick the simpler one
- Decide on function/variable naming — match neighboring code style
- Choose where to put new code — follow the existing module structure in `lib/`
- Handle edge cases — follow patterns from similar code in the repo
- Fix code review findings that are clear bugs, correctness issues, or convention violations
- Context/compaction — never prompt about context management. If compaction happens, follow the Compaction Recovery protocol below
- Plugin workflow pauses — if a plugin skill (e.g. `/deep-implement`) has optional "wait for user" checkpoints, skip them during autonomous operation unless there's a genuine decision that requires human judgment

**Plugin prompt defaults (never ask, always use these):**
- "Where should implementation code be written?" → current working directory (`/home/user/sitemgr`)
- "Is there existing code I should research first?" → Yes, research the codebase
- "No external LLMs configured. How should plan review be handled?" → Use Claude Opus for review
- "Plan review" → Done reviewing (auto-proceed)
- "Allow Claude to web search?" → Allow (always permit web search during research/planning)

**Stop and report (don't guess):**
- Database schema changes (new migrations, RLS policy changes)
- Changes to auth flows or security-sensitive code
- Adding new environment variables to production
- Deleting or significantly restructuring existing features
- Anything that would change the public API contract

### The Fix Loop

When any check fails (typecheck, lint, test, build, code review, CI), follow this loop:

```
failure → read error → diagnose → fix → re-run failed check → pass? → continue
                                    ↑                            |
                                    └── retry (max 3 attempts) ──┘
                                              |
                                         escalate with context
```

**Rules:**
1. **Read the error first.** Don't guess — read the actual output.
2. **Fix the code to match the expectation.** Never weaken a test assertion or disable a lint rule to make a failure go away. If a test expectation is wrong, verify against the spec before changing it.
3. **Re-run only the failing check**, not the full suite. Run the full suite once at the end.
4. **3 genuine attempts.** Each attempt must try a *different* approach. If attempt 1 was "fix the type annotation" and it didn't work, attempt 2 should investigate why, not retry the same fix.
5. **Escalate with context.** If stuck after 3 attempts, report: what failed, what was tried, why each attempt didn't work. The human should be able to act on this without re-investigating.

### Autonomous Development Process

This is the end-to-end process for implementing any spec. It runs without stopping for human input unless a "stop and report" item is hit or the fix loop is exhausted. The process is the same whether triggered by `/plan-next`, by the user saying "work on spec N", or any other entry point.

**Phase 0: Plan & Implement**
1. **Find the spec** — Look in `specs/` for the target directory with `spec.md`. If using `/plan-next` without a specific spec, pick the next unimplemented one.
2. **Confirm with user** — Present the spec. Flag anything from the "stop and report" list (migrations, RLS, auth, new env vars, public API changes) before proceeding.
3. **Plan** — Run `/deep-plan` with the spec path. Skip if a plan already exists (check for `sections/` directory).
4. **Implement** — Run `/deep-implement` against the sections directory.

**Phase 1: Verify**
1. Run all checks: typecheck, lint, unit tests, integration tests, build (see "Test Infrastructure" below for commands).
2. If anything fails, enter the fix loop. Fix and re-run only the failing check.
3. Once all checks pass, proceed.

**Phase 2: Push & PR**
1. Push to `claude/*` branch.
2. Create or update the PR with a summary of what was built.

**Phase 3: Code Review**
1. Run `/code-review` on the PR.
2. Review findings are trusted. For each finding:
   - Clear bug or correctness issue → fix, commit, push.
   - Convention/style violation → fix, commit, push.
   - Subjective or architectural suggestion → note it, don't act on it.
3. If fixes were made, re-run all checks (full suite since code changed).
4. Update the PR description to reflect fixes made.

**Phase 4: CI**
1. Check CI status on the PR using `gh pr checks <pr-number>`.
2. If CI fails, enter the fix loop — read the failure logs, fix, push, wait for re-run.
3. If CI passes, proceed.

**Phase 5: Present**
1. Present to the human with:
   - PR URL
   - Summary of what was implemented
   - What code review findings were fixed autonomously
   - What was left for human judgment (subjective/architectural items)
   - Any "stop and report" items encountered during the process
2. **Stop here.** The user decides when to merge.

**Keep the PR description current** — update it after each chunk of work. The description is the living record for human reviewers and future agents.

### Compaction Recovery

If context compaction occurs mid-task, **immediately re-orient before continuing:**

1. **Read `git log --oneline -10`** — see what's been committed recently
2. **Read `git diff --stat`** — see what's uncommitted
3. **Read the PR** (if one exists on the current branch) — the description has the implementation summary
4. **Check for deep-implement state** — `cat specs/*/implementation/deep_implement_config.json 2>/dev/null` shows completed sections and commit hashes
5. **Read CLAUDE.md** — it's already reloaded, but re-read the autonomous process to know what phase you're in

Then resume where you left off. If the current section's work is uncommitted and unclear, redo it — the cost is small. Do NOT proceed with degraded understanding; take 30 seconds to rebuild context from artifacts.

### Test Infrastructure

**All checks run from the `web/` directory.** Test tiers (all mandatory before pushing):

```bash
cd web
echo "=== TypeCheck ===" && npm run typecheck 2>&1 | tail -20
echo "=== Lint ===" && npm run lint 2>&1 | tail -20
echo "=== Unit Tests ===" && npm run test 2>&1 | tail -30
echo "=== Integration Tests ===" && npm run test:integration 2>&1 | tail -30
echo "=== E2E Tests ===" && npm run test:e2e 2>&1 | tail -30
echo "=== Build ===" && npm run build 2>&1 | tail -20
```

Integration and E2E tests are **not optional**. If infra isn't ready, fix the infra first, then run the tests.

**E2E tests** (`npm run test:e2e`) use Playwright and require:
- Local Supabase running (`supabase start`)
- Next.js dev server running (globalSetup auto-spawns it)
- Chromium installed (session-start hook runs `npx playwright install --with-deps chromium`)

**Infrastructure notes:**
- The session-start hook starts Supabase automatically. The minimum version constant (`SUPABASE_MIN_VERSION`) and install/start helpers live in `scripts/lib.sh`.
- Docker and Supabase are always available in web sessions — both can be installed and started.
- **Docker proxy (web sessions):** Docker needs the egress proxy. The session-start hook handles this with `sudo -E dockerd` (the `-E` flag passes `HTTP_PROXY`/`HTTPS_PROXY`). If Docker pulls fail, ensure `sudo -E`.
- **Next.js dev server:** Some integration tests need the Next.js dev server. The globalSetup auto-spawns it. If it fails, start manually: `npx next dev --port 3000 &>/tmp/next-dev.log &` with env vars (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `ENCRYPTION_KEY_CURRENT`).
- **Supabase Realtime is disabled** in `supabase/config.toml` — requires IPv6, unavailable in containers. Not used in v1.

### Slash Commands

Slash commands are thin triggers — they start a process, but the process itself is defined above. Do not duplicate process logic in command files.

- `/plan-next` — Find the next unimplemented spec and start the Autonomous Development Process
- `/verify` — Run all checks from "Test Infrastructure" and enter the fix loop on failures
- `/code-review` — Review PRs with multi-agent confidence-scored analysis (plugin skill)

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
