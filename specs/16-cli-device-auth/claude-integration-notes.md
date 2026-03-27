# Integration Notes: Opus Review Feedback

## Integrating

1. **Tighten anon SELECT RLS — use RPC function.** Good catch. Instead of `USING (true)`, use a Postgres RPC function `get_device_code_status(device_code text)` that returns only `status`, `token_hash`, `email`, and `expires_at`. The anon SELECT policy becomes unnecessary — all reads go through the function. Integrating.

2. **URL-encode the redirect parameter.** Correct — the raw query string breaks with nested `?`. The middleware must use `encodeURIComponent()`. Integrating.

3. **Add user code collision retry logic.** Good point. The partial unique index could cause insert failures. Add retry loop (up to 3 attempts with new user_code). Integrating.

4. **Add client-side polling timeout.** The CLI should check `Date.now() > expires_at` before each poll and stop. Integrating.

5. **Delete/null token_hash after successful poll.** Once the CLI retrieves the approved status and token_hash, the row should be updated to null out token_hash (or set status to `consumed`). This prevents replay. Integrating.

6. **Add email column to device_codes.** The poll response needs the email but the table only stores user_id. Add an `email` column set during approval. Simpler than joining auth.users. Integrating.

7. **Document admin.generateLink() return path.** Specify `data.properties.hashed_token`. Integrating.

8. **Document verifyOtp semantics.** Note that the CLI calls `verifyOtp({ token_hash, type: 'magiclink' })` from an anon-key client with no prior session. This matches the server-side pattern in `auth/confirm/route.ts`. Integrating.

## NOT Integrating

1. **Service role key policy conflict.** The user was asked about this directly during the interview (Q1, Q8) and chose Option A: use the service role key in the approve endpoint as a narrow exception. The CLAUDE.md policy update is part of this spec's deliverables. The user is aware this is a policy change.

2. **Rate limiting.** The user explicitly chose "Skip rate limiting for now" (Q5) during the interview. The 10-minute expiry, code entropy, and now the RPC function (which limits data exposure) provide baseline protection. Per-IP limits are a TODO for a future spec.

3. **Server-side verifyOtp instead of CLI-side.** The current design (CLI calls verifyOtp) is simpler and avoids an additional server round-trip. The token_hash is already short-lived and single-use. The reviewer noted "current design is acceptable" — keeping as-is.

4. **HTTPS requirement.** All Vercel deployments are HTTPS by default. Local dev uses HTTP but is on localhost. This is a deployment concern, not an implementation concern. No plan change needed.
