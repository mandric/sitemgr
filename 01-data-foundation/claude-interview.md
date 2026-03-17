# Interview Transcript — 01-data-foundation

## Q1: What's the goal of this deep-plan?

**Answer:** Audit & improve existing implementation. The spec says 01-data-foundation is "fully implemented" — the goal is to review for gaps, performance issues, and security concerns.

## Q2: Have you observed any performance issues with the current FTS + RLS combination?

**Answer:** Haven't tested at scale yet. No significant data volume to notice issues.

## Q3: Has a key rotation ever been performed in production?

**Answer:** Untested. The lazy migration system was designed but never exercised.

## Q4: What are your top concerns about the current data foundation?

**Answer:** (Multiple selections)
- Security gaps in RLS/encryption
- Test coverage gaps
- Performance at scale

## Q5: Event ID format — intentional or inherited?

The events table uses TEXT PRIMARY KEY with ULID-style IDs generated as truncated UUIDs (26 chars).

**Answer:** Inherited / quick implementation. Open to revisiting.

## Q6: Long-term auth model direction?

The dual auth model (phone_number for WhatsApp, user_id for web) creates complexity in RLS policies.

**Answer:** Migrate to user_id only. Phone-based auth is transitional, plan to unify.

## Q7: Which areas feel most under-tested?

**Answer:** (Multiple selections)
- RLS policy testing — no tests verify that RLS actually blocks unauthorized access
- All of the above (migration rollback/forward, event store edge cases, RLS testing)

## Q8: Should the plan include a phone→user_id migration strategy?

**Answer:** Include migration strategy. Plan the phone→user_id unification as part of this audit.

## Q9: Expected data volume for events table in next 6-12 months?

**Answer:** 10K - 100K events. Moderate usage, a few active users.

## Q10: Plans to support additional credential types beyond S3?

**Answer:** S3 only for v1. Keep it simple, S3-compatible storage only.
