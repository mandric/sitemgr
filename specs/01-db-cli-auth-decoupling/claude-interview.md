# Interview Transcript: DB/CLI Auth Decoupling

## Q1: Client Factory Config Pattern
**Q:** Should db.ts read web env vars directly, accept config as parameter, or use env var fallback chain for getAdminClient/getUserClient?

**A:** Accept config as parameter. Callers provide config.

## Q2: Barrel Export
**Q:** Should lib/media/index.ts barrel export be kept, changed to selective re-exports, or removed?

**A:** Remove barrel entirely. Consumers import from @/lib/media/db directly.

## Q3: Migration Approach
**Q:** With config-as-parameter, every caller needs updating (~15+ call sites). Big bang, gradual, or new module?

**A:** Big bang. Clean break, no legacy paths.

## Q4: getAuthenticatedClient Location
**Q:** Where should getAuthenticatedClient() live after extraction?

**A:** Keep in db.ts — it's a database client.

## Q5: Scope — CLI and Supabase
**Q:** Should this just fix import coupling, or address env var divergence too?

**A:** Only the web API should need to know about Supabase. The CLI should use the web API as an abstraction.

## Q6: CLI → API Confirmation
**Q:** Does this mean smgr.ts should stop importing db.ts and make HTTP requests to Vercel API routes instead?

**A:** Yes — CLI calls web API endpoints.

## Q7: Scope Confirmation
**Q:** Is full API abstraction (CLI becomes HTTP client, all Supabase access behind API routes) in scope?

**A:** Full API abstraction.

## Q8: CLI Authentication
**Q:** How should CLI authenticate with the web API?

**A:** JWT via login endpoint. CLI sends email/password to /api/auth/login, gets JWT back, sends it as Bearer token.

## Q9: API Endpoint Structure
**Q:** REST endpoints mirroring db.ts, command-oriented, or single RPC endpoint?

**A:** Command-oriented endpoints matching CLI commands: /api/query, /api/show, /api/add, /api/enrich, /api/watch, etc.

## Q10: Health Route
**Q:** Should health route keep direct Supabase access or go through new pattern?

**A:** Refactor health too.

## Q11: Error Handling
**Q:** Should API routes pass through Supabase's { data, error } shape or use standard HTTP status codes?

**A:** Standard HTTP status codes with JSON body. CLI interprets status.

## Q12: Agent Core
**Q:** Agent core (heaviest db.ts consumer, runs server-side) — keep direct access or also go through API?

**A:** Agent goes through API too.

## Q13: db.ts Fate
**Q:** Once only API routes consume db.ts, what happens to it?

**A:** Keep db.ts as server DAL (data access layer). Only imported by API route handlers.

## Q14: CLI HTTP Client
**Q:** Native fetch, custom API client class, or third-party HTTP lib?

**A:** Custom API client class — thin wrapper around fetch that handles auth headers, base URL, error parsing.
