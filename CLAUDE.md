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
- `ENCRYPTION_KEY_CURRENT` - Active key for new encryptions (required in production)
- `ENCRYPTION_KEY_PREVIOUS` - Old key for decryption during rotation (optional in production)
- `ENCRYPTION_KEY_NEXT` - Future key for gradual rollout (optional in production)
- **DO NOT USE**: `ENCRYPTION_KEY`, `ENCRYPTION_KEY_V1`, `ENCRYPTION_KEY_V2`, `ENCRYPTION_KEY_V3` (legacy, removed)

**Where Secrets Live:**
- **Vercel Production**: All runtime secrets for deployed app
- **GitHub Production Environment**: Only deployment secrets (VERCEL_TOKEN, SUPABASE_ACCESS_TOKEN)
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

**E2E Tests:**
- Only set env vars for services the test actually connects to
- Current: Supabase URL/key (because E2E connects to local Supabase)
- Not encryption keys (E2E doesn't exercise encryption paths)
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

### Backlog items (not v1 scope)

- BYO S3-compatible storage (any provider, not just Supabase)
- Local-first / offline mode with per-device SQLite
- Enrichment metadata as sidecar files in S3 (post-prototype idea)

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
