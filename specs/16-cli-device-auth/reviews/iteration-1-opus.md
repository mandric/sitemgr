# Opus Review

**Model:** claude-opus-4
**Generated:** 2026-03-25T04:00:00Z

---

## Critical: Direct Conflict with CLAUDE.md on Service Role Key

The plan requires adding `SUPABASE_SERVICE_ROLE_KEY` as a Vercel production runtime secret for the approve endpoint. CLAUDE.md explicitly states app code never uses the service role key. The plan acknowledges this is an exception but does not reconcile it with the project's documented security invariant.

**Recommendation:** Either (a) explicitly amend CLAUDE.md and get buy-in, or (b) redesign to avoid the service role key entirely using a service account pattern.

## Security: Token Hash Exposed to Unauthenticated Callers

The poll endpoint returns `token_hash` to an unauthenticated caller who only presents the `device_code`. The device_code is functionally a bearer token for session creation. If it leaks, the user's account is compromised until expiry.

**Recommendations:**
- Require HTTPS-only for all endpoints.
- Delete the row or null the token_hash after the first successful poll that returns approved.
- Never log device_code values.

## Security: Unauthenticated Insert with No Rate Limiting

The initiate endpoint allows unauthenticated inserts with no rate limiting. An attacker can flood the table.

**Recommendation:** Add per-IP insert limit (max 10 pending per IP per hour).

## Security: RLS Policy is Too Permissive

Anon SELECT policy is `USING (true)` — anon can read ALL rows, exposing token_hash, user_id, etc.

**Recommendation:** Use a database function (RPC) that takes device_code as input and returns only needed fields, or scope the RLS more tightly.

## Architectural: verifyOtp Called from CLI, Not Server

The token_hash traverses the network. An alternative would have the server verify and return session tokens directly. Current design is acceptable but should document the rationale.

## Missing: Redirect URL Encoding

`/auth/login?redirect=/auth/device?code=ABCD-1234` has an unencoded second `?`. Must be URL-encoded: `/auth/login?redirect=%2Fauth%2Fdevice%3Fcode%3DABCD-1234`.

## Missing: User Code Collision Handling

No retry logic if generated user_code collides with existing pending code. Add retry (generate new code, up to 3 attempts).

## Missing: Polling Timeout

CLI polling loop has no maximum duration. Add client-side timeout based on `expires_at`.

## Missing: Cleanup of Approved Rows

Approved rows with token_hash linger until cleanup. Delete or null token_hash after successful poll.

## Missing: Email Field on Poll Response

Poll returns `email` when approved, but approve endpoint stores `user_id` not email. Need email column or join against auth.users.

## Missing: verifyOtp Semantics

Confirm `verifyOtp({ token_hash, type: 'magiclink' })` works from a client with just anon key (no prior session).

## Minor: admin.generateLink() Return Shape

The actual response path is `data.properties.hashed_token`. Plan should be explicit.

## Summary of Recommended Changes

1. Resolve service role key policy conflict — amend CLAUDE.md or redesign
2. Tighten anon SELECT RLS — use RPC function, don't expose all rows
3. URL-encode the redirect parameter
4. Add user code collision retry logic
5. Add client-side polling timeout based on expires_at
6. Add rate limiting or per-IP insert cap
7. Clarify where email comes from in poll response (add column or join)
8. Delete or null token_hash after successful poll consumption
9. Document verifyOtp client-side call and confirm it works with token_hash
10. Fix redirect URL encoding in auth flow description
