# Section 06 Code Review Interview

## Interview Decisions

### Exclude integration tests from main vitest config
- **Finding:** Main vitest.config.ts doesn't exclude integration files; `npm test` picks them up
- **Decision:** Exclude from main config
- **User chose:** "Exclude from main config"
- **Applied:** Added rls-policies, rpc-user-isolation, migration-integrity to vitest.config.ts exclude

## Auto-fixes Applied

### Error checking on seed inserts
- **Finding:** beforeAll seed inserts ignore errors, could cause vacuous test passes
- **Applied:** Added assertInsert helper that throws on insert errors

## Let go
- Phone-based access test: JWT won't have phone claim without phone-confirmed users; test acknowledges this in comments and asserts the safe behavior (bData empty)
- Missing teardown verification test: afterAll cleanup is best-effort, not worth a dedicated test
- Missing auth verification test: user IDs being defined/distinct is sufficient
- Anon INSERT/UPDATE/DELETE tests: out of plan scope
- NULL safety only on events/bucket_configs: sufficient for the dual-auth concern
