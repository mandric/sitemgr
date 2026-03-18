# Fix Session-Start Hook: Supabase CLI Installation

## Problem

The `.claude/hooks/session-start.sh` hook fails to install the Supabase CLI because `npm install -g supabase` is explicitly blocked by the Supabase CLI package. This causes 2 cascading failures:

1. Supabase CLI installation fails
2. `supabase start` is skipped because the CLI isn't available

## Current Behavior

The hook uses `npm install -g supabase` which outputs:
```
Installing Supabase CLI as a global module is not supported.
Please use one of the supported package managers: https://github.com/supabase/cli#install-the-cli
```

## Desired Behavior

Install the Supabase CLI via direct binary download from GitHub releases, matching the same pattern already used for the `gh` CLI installation in the hook.

## Constraints

- Must work in the Claude Code on the web environment (Linux amd64)
- Should follow the same pattern as the existing gh CLI installation (curl tarball, extract, copy to /usr/local/bin or ~/.local/bin fallback)
- Hook must remain resilient — individual step failures should not block other steps
- The fix is already implemented on branch `claude/check-deep-plan-skill-68AV4` but needs validation

## Files

- `.claude/hooks/session-start.sh` — the hook script
- `.claude/settings.json` — hook configuration
