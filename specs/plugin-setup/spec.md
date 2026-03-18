# Plugin Setup — Spec

## Overview

Migrate Claude Code plugin configuration from hand-edited `settings.json` to the official CLI-based installation approach. This ensures plugins are managed consistently and can be updated/removed without manual JSON editing.

## Current State

`.claude/settings.json` has manually added `extraKnownMarketplaces` and `enabledPlugins` blocks for three plugins:
- `deep-project@piercelamb-deep-project`
- `deep-plan@piercelamb-deep-plan`
- `deep-implement@piercelamb-deep-implement`

All three reference GitHub repos under `piercelamb/`.

## Desired State

Replace the manual JSON with CLI-managed configuration:

```bash
# Add marketplaces
claude plugin marketplace add piercelamb/deep-project
claude plugin marketplace add piercelamb/deep-plan
claude plugin marketplace add piercelamb/deep-implement

# Install plugins at project scope
claude plugin install deep-project@piercelamb-deep-project --scope project
claude plugin install deep-plan@piercelamb-deep-plan --scope project
claude plugin install deep-implement@piercelamb-deep-implement --scope project
```

## Requirements

1. **Preserve existing hooks** — The `SessionStart` hook in `settings.json` must not be removed or altered
2. **Project scope** — All plugins must be installed with `--scope project` so the config stays in `.claude/settings.json` (shared via git)
3. **Verify functionality** — After migration, confirm plugins are listed via `claude plugin list`
4. **Commit the result** — The updated `.claude/settings.json` should be committed

## Steps

1. Remove `extraKnownMarketplaces` and `enabledPlugins` blocks from `.claude/settings.json` (keep `hooks` intact)
2. Run `claude plugin marketplace add` for each of the three marketplace repos
3. Run `claude plugin install --scope project` for each plugin
4. Run `claude plugin list` to verify all three are installed
5. Diff `.claude/settings.json` to confirm the CLI wrote equivalent config
6. Commit the updated `settings.json`

## Risks

- **CLI may produce a different JSON shape** than the hand-edited version. This is expected and fine — the CLI output is the canonical format.
- **Web sessions** will continue to work because the project-scoped config in `.claude/settings.json` triggers plugin installation on session start regardless of how it was written.
- **If CLI commands aren't available in the web container**, this task should be done locally and the result pushed.

## Out of Scope

- Changing which plugins are installed
- Plugin version pinning (use latest for now)
- User-scope or global-scope plugin configuration
