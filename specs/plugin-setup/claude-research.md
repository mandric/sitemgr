# Plugin Setup — Research Findings

## Codebase Research

### Current `.claude/settings.json` Structure

```json
{
  "hooks": {
    "SessionStart": [{
      "hooks": [{
        "type": "command",
        "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/session-start.sh"
      }]
    }]
  },
  "enabledPlugins": {
    "deep-project@piercelamb-deep-project": true,
    "deep-plan@piercelamb-deep-plan": true,
    "deep-implement@piercelamb-deep-implement": true
  },
  "extraKnownMarketplaces": {
    "piercelamb-deep-project": {
      "source": { "source": "github", "repo": "piercelamb/deep-project" }
    },
    "piercelamb-deep-plan": {
      "source": { "source": "github", "repo": "piercelamb/deep-plan" }
    },
    "piercelamb-deep-implement": {
      "source": { "source": "github", "repo": "piercelamb/deep-implement" }
    }
  }
}
```

Three sections: `hooks` (lifecycle event handlers), `enabledPlugins` (plugin IDs with boolean status), `extraKnownMarketplaces` (custom GitHub marketplace sources).

### SessionStart Hook

Located at `.claude/hooks/session-start.sh`. Only runs in remote/web environments (`CLAUDE_CODE_REMOTE=true`). Bootstraps:
- gh CLI (v2.65.0)
- Supabase CLI
- Vercel CLI
- Playwright browsers
- npm install in `web/`
- Local Supabase start

### Global Plugin State (`~/.claude/plugins/`)

```
~/.claude/plugins/
├── blocklist.json
├── installed_plugins.json    # Tracks installed plugins with versions, paths, SHAs
├── known_marketplaces.json   # Registry of added marketplaces
├── cache/                    # Cloned plugin code
│   └── piercelamb-deep-plan/
├── data/                     # Plugin data
└── marketplaces/             # Cloned marketplace repos
```

On web sessions, these are ephemeral (container is fresh each session) but get re-created from project-level `.claude/settings.json`.

### Testing Setup

- **Framework:** Vitest (unit/integration) + Playwright (E2E)
- **Test commands:** `npm test` (unit), `npm run test:integration`, `npm run test:e2e`
- **Pattern:** `vi.stubEnv()` with fixture values for unit tests; real services for integration
- **Config:** `web/vitest.config.ts`, `web/vitest.integration.config.ts`, `web/playwright.config.ts`

### Existing Deep-Plan Output Pattern

`01-data-foundation/` shows the full deep-plan output structure:
- `spec.md`, `deep_plan_config.json`, `claude-plan.md`, `claude-research.md`, `claude-spec.md`
- `reviews/` directory, `sections/` directory, `implementation/` directory

---

## Web Research

### Claude Code Plugin CLI Commands

Source: [Official Claude Code Docs — Discover and Install Plugins](https://code.claude.com/docs/en/discover-plugins)

#### Marketplace Management

```bash
# Add a marketplace (GitHub shorthand)
/plugin marketplace add owner/repo
claude plugin marketplace add owner/repo

# Add from git URL
/plugin marketplace add https://gitlab.com/company/plugins.git

# Add specific branch/tag
/plugin marketplace add https://gitlab.com/company/plugins.git#v1.0.0

# Add from local path
/plugin marketplace add ./my-marketplace

# List all marketplaces
/plugin marketplace list

# Update marketplace listings
/plugin marketplace update marketplace-name

# Remove a marketplace (also uninstalls its plugins)
/plugin marketplace remove marketplace-name
```

#### Plugin Installation

```bash
# Install a plugin (user scope by default)
/plugin install plugin-name@marketplace-name
claude plugin install plugin-name@marketplace-name

# Install with specific scope
claude plugin install plugin-name@marketplace-name --scope project
claude plugin install plugin-name@marketplace-name --scope user
claude plugin install plugin-name@marketplace-name --scope local

# Disable without uninstalling
/plugin disable plugin-name@marketplace-name

# Re-enable
/plugin enable plugin-name@marketplace-name

# Uninstall completely
/plugin uninstall plugin-name@marketplace-name

# Reload after changes
/reload-plugins
```

#### Scopes

| Scope | Stored In | Shared? | Use Case |
|-------|-----------|---------|----------|
| **User** (default) | `~/.claude/settings.json` | No (personal) | Personal tools across all projects |
| **Project** | `.claude/settings.json` | Yes (via git) | Team-shared plugins |
| **Local** | `.claude/settings.local.json` | No | Personal, per-repo only |
| **Managed** | Admin-controlled | Varies | Org-enforced plugins |

### Team Marketplace Configuration (`extraKnownMarketplaces`)

Source: [Official Claude Code Docs — Configure Team Marketplaces](https://code.claude.com/docs/en/discover-plugins#configure-team-marketplaces)

Team admins can add `extraKnownMarketplaces` to `.claude/settings.json` to auto-configure marketplaces for team members:

```json
{
  "extraKnownMarketplaces": {
    "my-team-tools": {
      "source": {
        "source": "github",
        "repo": "your-org/claude-plugins"
      }
    }
  }
}
```

When team members trust the repository folder, Claude Code prompts them to install these marketplaces and plugins. This is the **recommended approach for teams** — it's how the current sitemgr setup works.

### Key Findings

1. **`extraKnownMarketplaces` + `enabledPlugins` IS the official team pattern.** The docs explicitly recommend this for configuring team marketplaces. Using `claude plugin marketplace add` + `claude plugin install --scope project` produces the same result but through the CLI.

2. **CLI vs manual JSON produces equivalent config.** Both approaches write to `.claude/settings.json`. The CLI is just a convenience wrapper — it doesn't produce a fundamentally different format.

3. **`--scope project` writes to `.claude/settings.json`.** This is the same file the manual approach uses, ensuring git-shared config.

4. **Removing a marketplace also uninstalls its plugins.** Important to know for the migration — don't remove old config before adding new.

5. **Auto-updates are off by default for third-party marketplaces.** The official Anthropic marketplace auto-updates, but `piercelamb/*` repos won't unless explicitly enabled.

6. **`/reload-plugins` is needed after changes.** After install/enable/disable, run `/reload-plugins` to pick up changes without restarting.

7. **Web sessions re-create from project config.** The global `~/.claude/plugins/` state is ephemeral on web, but `.claude/settings.json` is the durable source of truth that triggers re-installation.

### Migration Consideration

The current manual approach (`extraKnownMarketplaces` + `enabledPlugins`) is actually the **documented team configuration pattern**. The CLI approach (`marketplace add` + `plugin install`) is equivalent but provides:
- Easier updates (`/plugin marketplace update`)
- Easier removal (`/plugin uninstall`)
- Interactive UI (`/plugin` → Discover/Installed/Marketplaces tabs)
- Auto-update configuration

Both are valid. The real value of migrating to CLI is operational convenience, not a different config format.
