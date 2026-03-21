# Interview Transcript — 02-media-pipeline

## Q1: What's the goal of this deep-plan?

**Question:** The spec says the media pipeline is "fully implemented." What's the goal — what do you want to improve, add, or change?

**Answer:** Harden & improve existing code — test coverage, error handling, reliability improvements, documentation.

## Q2: What's the single most important area?

**Question:** What's the single most important area you want the plan to focus on?

**Answer:** Test coverage gaps.

## Q3: What level of test coverage are you targeting?

**Question:** The existing tests mock Supabase and S3 — do you want real service integration tests too?

**Answer:** Both unit and integration tests (mocked unit tests + real service integration tests).

## Q4: Which error paths and edge cases are you most concerned about?

**Question:** Which error paths and edge cases are most concerning?

**Answer:** All four areas:
- S3 error scenarios (network timeouts, partial responses, provider-specific errors)
- Claude API failure modes (rate limits 429, overloaded 529, malformed JSON, invalid images)
- Database error handling (connection failures, RLS denials, constraint violations)
- Edge cases in media processing (large files, corrupt images, unsupported formats, empty buckets)

## Q5: How should we handle real service dependencies for integration tests?

**Question:** For integration tests, how should we handle the real service dependencies (Supabase, S3)?

**Answer:** Use local Supabase (`supabase start`) + S3 service from Supabase for integration tests.

## Q6: Which hardening improvements beyond test coverage?

**Question:** Beyond test coverage, which hardening improvements should we include?

**Answer:** All four:
- Retry logic with backoff (exponential backoff, jitter, configurable retry counts for S3 and Claude API)
- Rate limit handling (check rate limit headers, queue/throttle requests to Claude API)
- Input validation (validate image size/format before sending to Claude, handle corrupt files gracefully)
- Better observability/logging (structured logging with levels, request IDs, timing metrics)

## Q7: Should the scope cover the full pipeline?

**Question:** Should the hardening scope cover only the media library files, or also the agent actions and CLI?

**Answer:** Full pipeline end-to-end (media library + agent actions + CLI + API routes).

## Q8: Are breaking changes acceptable?

**Question:** Are breaking changes to function signatures acceptable?

**Answer:** We are in prototype mode so all APIs are open to change.

## Q9: What scale should the hardening target?

**Question:** What scale affects retry budgets, concurrency limits, and error handling depth.

**Answer:** Medium (small team) — a few users, thousands of photos, regular automated syncing.

## Q10: Should the plan include CI pipeline setup?

**Question:** Should the plan include CI pipeline setup for integration tests?

**Answer:** Local development only for now, CI later.
