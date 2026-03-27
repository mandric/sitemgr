# Interview Transcript: CLI Device Code Auth

## Q1: OTP Generation Strategy

**Question:** Research shows the service account can't call `auth.admin.generateLink()` (requires service role key). Three options: (A) Use service role key in just the `/api/auth/device/approve` endpoint — it's server-side and authenticated, minimal blast radius. (B) Have the browser relay its own session tokens to the device_code row when approving — the CLI gets a copy of the browser's tokens. (C) Use signInWithOtp which sends an email?

**Answer:** A: Service role key in approve endpoint. Narrow exception — single authenticated server endpoint uses service role key to generate OTP.

## Q2: Auth UX for Device Page

**Question:** The device auth page at `/auth/device` needs to handle unauthenticated users. Redirect to existing login page with return URL, or inline login form?

**Answer:** Redirect to existing login page. Simpler — reuses existing login flow, redirect back to /auth/device after.

## Q3: User Code Format

**Question:** For the user code format displayed in the terminal, which style?

**Answer:** ABCD-1234 (letters + digits, 8 chars). Mixed alphanumeric, familiar from GitHub CLI.

## Q4: Code Pre-fill in URL

**Question:** Should the CLI pre-fill the user code in the browser URL (e.g. `/auth/device?code=ABCD-1234`) so the user just has to click approve, or should the user always type manually?

**Answer:** Pre-fill in URL. Better UX — user just verifies the code matches and clicks approve. The code is short-lived and in the URL only.

## Q5: Rate Limiting

**Question:** For rate limiting on the device auth endpoints, what approach should we use?

**Answer:** Skip rate limiting for now. Add a TODO. The 10-minute expiry and code entropy provide baseline protection.

## Q6: CLI Polling UX

**Question:** Any specific terminal UX preferences for the polling phase?

**Answer:** Keep it simple — just a message. Static: "Waiting for browser approval. Press Ctrl+C to cancel."

## Q7: Headless/Password Login

**Question (from earlier conversation):** Should we support a headless login fallback with email/password?

**Answer:** No. Remove headless support entirely — it can be a security hole. Device code flow is the only login method.

## Q8: Service Account vs Service Role Key

**Question (from earlier conversation):** Should we use a service account pattern or service role key for the device auth OTP generation?

**Answer:** Initially wanted service account, but after learning the service account can't call `admin.generateLink()`, agreed to use the service role key in a narrow, single-endpoint exception. Add a TODO to revisit the approach later.
