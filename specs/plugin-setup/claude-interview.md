# Plugin Setup — Interview Transcript

## Q1: Motivation for Migration

**Q:** The research shows that `extraKnownMarketplaces` + `enabledPlugins` is actually the officially documented team configuration pattern. The CLI just wraps it. Given this, what's the real motivation — is it about operational convenience, moving to a 'canonical' format, or something else?

**A:** It didn't appear to behave properly. The settings.json file did not seem to set up the plugin/skill because after session start the skills were not available to Claude Code web interface.

## Q2: Plugin Organization

**Q:** Should all three plugins stay as separate marketplace entries, or would you prefer them consolidated into a single marketplace?

**A:** I am just following the README instructions which uses a separate marketplace for each plugin.

## Q3: Symptoms in Web Interface

**Q:** When you say skills weren't available in the web interface, what exactly happens?

**A:** Skills are not listed. Note that in the web interface we do not use slash commands, we just instruct Claude to run the skill. When I ask Claude to run the skill it says not available.

## Q4: Local vs Web

**Q:** Does the current manual settings.json config work locally (CLI), or is it broken in both?

**A:** Only tested on web.

## Q5: Has CLI Approach Been Tested?

**Q:** Have you already tried running `claude plugin marketplace add` + `claude plugin install --scope project` to see if the CLI approach fixes the web behavior?

**A:** If I prompt enough eventually the web version will install the plugins via the CLI and then make them available.

## Q6: Post-CLI Install Reliability

**Q:** When you 'prompt enough' and Claude eventually runs the CLI install commands in-session, do the skills reliably work for the rest of that session?

**A:** Yes, works after CLI install.

## Q7: Desired End-State

**Q:** What's your desired end-state for web sessions? Should plugins be automatically available on session start, or is a hook-based bootstrap acceptable?

**A:** Just make it work.

## Q8: Hook Approach

**Q:** The existing SessionStart hook already bootstraps tools. Would you be OK adding plugin CLI install commands there to guarantee plugins are available on every web session start?

**A:** Settings first, hook as fallback.

## Q9: Plugin Scope

**Q:** Should the migration cover exactly the same three plugins, or are there changes?

**A:** Start with these, may change.

---

## Key Takeaways

1. **Core problem:** Manual `settings.json` (`extraKnownMarketplaces` + `enabledPlugins`) does NOT reliably make plugins available in web sessions
2. **CLI install works:** Running `claude plugin marketplace add` + `claude plugin install` in-session reliably activates plugins
3. **Strategy:** Try settings.json-based CLI approach first; if that doesn't work on web, fall back to adding CLI commands to the SessionStart hook
4. **Three plugins:** deep-project, deep-plan, deep-implement (all from piercelamb GitHub repos), may add more later
5. **Separate marketplaces per plugin:** Following plugin author README convention
