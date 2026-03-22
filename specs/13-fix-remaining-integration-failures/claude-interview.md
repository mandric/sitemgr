# Interview Transcript

## Q1: Content type consistency in tests

**Q:** The spec identifies a content_type duality: events store MIME types (image/jpeg) but some code uses semantic types (photo). Should we also fix the CLI FTS test that inserts with content_type: 'photo', or leave as-is?

**A:** Fix it for consistency — change test inserts to use MIME types like image/jpeg to match seedUserData().

## Q2: JWT claim check vs auth.users query

**Q:** For the get_user_id_from_phone caller check, should we use auth.jwt() ->> 'email' (reads from JWT claims directly, faster) or query auth.users table via auth.uid()?

**A:** Use auth.jwt() claims (recommended) — faster, no table lookup. Checks email directly from the JWT token.

## Q3: Supabase CLI version pinning

**Q:** Should we pin CLI to exact 2.76.4 or use latest?

**A:** Use latest — always get newest version. Risk of future breakage but get fixes automatically.

## Q4: Existing implementation scope

**Q:** The existing commit already implemented all 5 fixes. Should deep-plan revise the existing implementation, plan only the delta, or start fresh?

**A:** Revise existing implementation — deep-plan reviews what was done and suggests improvements based on research findings (auth.jwt() instead of auth.users query, 'latest' CLI version, content_type consistency fixes).
