# Plugin Setup — Complete Specification

## Problem Statement

Claude Code plugins (deep-project, deep-plan, deep-implement) are manually configured in `.claude/settings.json` using `extraKnownMarketplaces` and `enabledPlugins` blocks. While this is the documented team configuration pattern, it **does not reliably make plugins available in Claude Code web sessions**. Skills are not listed and Claude reports them as unavailable.

Running the equivalent CLI commands (`claude plugin marketplace add` + `claude plugin install --scope project`) in-session does work — once the CLI install runs, plugins are available for the rest of the session.

## Goal

Make all three plugins reliably available in Claude Code web sessions without manual intervention. The migration should:

1. Replace manual JSON with CLI-managed equivalent configuration
2. Ensure plugins auto-install and skills are available on session start in web
3. If settings.json alone doesn't work, add CLI install commands to the existing SessionStart hook as a fallback
4. Preserve the existing `SessionStart` hook functionality
5. Keep project scope so config is shared via git

## Current State

### `.claude/settings.json`

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

### SessionStart Hook (`session-start.sh`)

Runs only on web (`CLAUDE_CODE_REMOTE=true`). Bootstraps gh CLI, Supabase CLI, Vercel CLI, Playwright browsers, npm install, and local Supabase start.

### Global Plugin State (`~/.claude/plugins/`)

Ephemeral on web sessions (container is fresh each session). Contains `installed_plugins.json`, `known_marketplaces.json`, and plugin cache. Gets re-created from project config on session start.

## Desired State

### Primary Approach: CLI-Managed settings.json

Run these commands (once, locally or in-session) to produce a CLI-managed `.claude/settings.json`:

```bash
# Add each marketplace
claude plugin marketplace add piercelamb/deep-project
claude plugin marketplace add piercelamb/deep-plan
claude plugin marketplace add piercelamb/deep-implement

# Install each plugin at project scope
claude plugin install deep-project@piercelamb-deep-project --scope project
claude plugin install deep-plan@piercelamb-deep-plan --scope project
claude plugin install deep-implement@piercelamb-deep-implement --scope project
```

The resulting `settings.json` should have the `hooks` block preserved, plus whatever format the CLI produces for marketplaces and plugins.

### Fallback Approach: SessionStart Hook Bootstrap

If the CLI-managed settings.json still doesn't auto-install plugins on web session start, add CLI install commands to `session-start.sh`:

```bash
# After existing tool bootstrapping...
# Ensure plugins are installed
claude plugin marketplace add piercelamb/deep-project 2>/dev/null || true
claude plugin marketplace add piercelamb/deep-plan 2>/dev/null || true
claude plugin marketplace add piercelamb/deep-implement 2>/dev/null || true

claude plugin install deep-project@piercelamb-deep-project --scope project 2>/dev/null || true
claude plugin install deep-plan@piercelamb-deep-plan --scope project 2>/dev/null || true
claude plugin install deep-implement@piercelamb-deep-implement --scope project 2>/dev/null || true
```

## Plugins

| Plugin ID | Marketplace | GitHub Repo |
|-----------|-------------|-------------|
| `deep-project@piercelamb-deep-project` | `piercelamb-deep-project` | `piercelamb/deep-project` |
| `deep-plan@piercelamb-deep-plan` | `piercelamb-deep-plan` | `piercelamb/deep-plan` |
| `deep-implement@piercelamb-deep-implement` | `piercelamb-deep-implement` | `piercelamb/deep-implement` |

Each plugin has its own marketplace (GitHub repo). This follows the plugin authors' README convention.

## Requirements

1. **Preserve hooks** — The `SessionStart` hook must not be removed or broken
2. **Project scope** — All plugins installed with `--scope project` (writes to `.claude/settings.json`)
3. **Web session reliability** — Plugins must be available on web session start
4. **Verify via `claude plugin list`** — All three plugins should appear as installed
5. **Commit result** — Updated `.claude/settings.json` (and potentially `session-start.sh`) committed
6. **Extensible** — Easy to add/remove plugins later using the same CLI pattern

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| CLI produces different JSON shape | Expected and fine — CLI output is canonical |
| Web session doesn't auto-install from settings.json | Fall back to SessionStart hook CLI commands |
| Plugin install fails in web container (network/auth) | Use `2>/dev/null \|\| true` to prevent hook failure; log outcome |
| SessionStart hook becomes too slow | Plugin install is idempotent and fast when already installed |
| Removing marketplace also removes plugins | Don't remove old config until new config is verified working |

## Out of Scope

- Changing which plugins are installed
- Plugin version pinning (use latest)
- User-scope or global-scope plugin configuration
- Consolidating into a single marketplace
- Local-first testing (web is the primary target)
