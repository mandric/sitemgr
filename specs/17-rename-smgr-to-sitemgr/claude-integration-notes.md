# Integration Notes: Opus Review Feedback

## Integrating

1. **Add `scripts/setup/verify.sh`** to Section 4 — confirmed it has SMGR_ references, must update.
2. **Add `cli-auth-device-flow.test.ts`** to Section 3 — missed test file with SMGR_WEB_URL stub.
3. **Add `device-auth.test.ts`** to Section 3 — missed integration test with SMGR_WEB_URL.
4. **SMGR_OLLAMA_URL and SMGR_VISION_MODEL in CI** — already in scope per interview (user confirmed rename all SMGR_ vars), but making explicit in Section 4.
5. **Explicitly list SMGR_API_URL/SMGR_API_KEY** — making these explicit in sections rather than implicit.
6. **Fix verification grep** — expanding to cover Dockerfile, CLAUDE.md, .env.example.
7. **Substring hazard warning** — critical correctness issue. Adding explicit guidance to avoid `smgr` → `sitemgr` replacing the `smgr` inside existing `sitemgr` strings.
8. **`.env.local` self-heal note** — useful context, adding to Section 4.
9. **CLAUDE.md updates explicit** — moving from conditional to explicit in Section 5.

## Not Integrating

10. **Single atomic commit** — not integrating. The sections are for planning/implementation structure. The implementer can decide commit granularity. Intermediate test runs between sections are useful for catching issues early.
