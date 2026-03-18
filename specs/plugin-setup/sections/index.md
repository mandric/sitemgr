<!-- PROJECT_CONFIG
runtime: shell
test_command: bash -n .claude/hooks/session-start.sh && claude plugin list
END_PROJECT_CONFIG -->

<!-- SECTION_MANIFEST
section-01-backup-audit
section-02-remove-manual-config
section-03-add-marketplaces
section-04-install-plugins
section-05-validate-settings
section-06-web-test
section-07-hook-fallback
section-08-final-commit
END_MANIFEST -->

# Implementation Sections Index

## Dependency Graph

| Section | Depends On | Blocks | Parallelizable |
|---------|------------|--------|----------------|
| section-01-backup-audit | - | section-02 | Yes |
| section-02-remove-manual-config | section-01 | section-03 | No |
| section-03-add-marketplaces | section-02 | section-04 | No |
| section-04-install-plugins | section-03 | section-05 | No |
| section-05-validate-settings | section-04 | section-06 | No |
| section-06-web-test | section-05 | section-07 | No |
| section-07-hook-fallback | section-06 | section-08 | No |
| section-08-final-commit | section-07 | - | No |

## Execution Order

1. section-01-backup-audit (no dependencies)
2. section-02-remove-manual-config (after 01)
3. section-03-add-marketplaces (after 02)
4. section-04-install-plugins (after 03)
5. section-05-validate-settings (after 04)
6. section-06-web-test (after 05)
7. section-07-hook-fallback (conditional, after 06)
8. section-08-final-commit (after 07)

Note: This is a strictly sequential workflow. Each section depends on the previous section's output. No parallelization is possible because each step modifies the same files (`.claude/settings.json` and optionally `session-start.sh`).

## Section Summaries

### section-01-backup-audit
Verify git branch state, record current settings.json structure and plugin list. Ensure rollback path via git history.

### section-02-remove-manual-config
Remove hand-edited `enabledPlugins` and `extraKnownMarketplaces` blocks from settings.json. Preserve `hooks` block.

### section-03-add-marketplaces
Run `claude plugin marketplace add` for each of the three piercelamb repos. Verify hooks not clobbered after each command. Capture CLI-assigned marketplace names.

### section-04-install-plugins
Run `claude plugin install --scope project` for each plugin using marketplace names from section 03. Verify hooks preserved after each command.

### section-05-validate-settings
Diff new settings.json against git baseline. Confirm hooks, plugins, and marketplaces are all present. Run `claude plugin list` for final verification.

### section-06-web-test
Commit and push updated settings.json. Start new web session. Test that skills are available by asking Claude to run each plugin's skill.

### section-07-hook-fallback
Conditional — only if section 06 fails. Add plugin CLI commands to session-start.sh wrapped in a subshell with `set +e`. Include guard check to skip when already installed. Verify `claude` CLI availability in hook context.

### section-08-final-commit
Final commit of all changes (settings.json, optionally session-start.sh). Push to remote. Verify clean git state.
