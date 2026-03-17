Now I have all the context needed. Let me generate the section content.

# Section 10: Documentation

## Overview

This section produces three documentation deliverables based on the findings and changes from all prior sections (01 through 09). It is the final section in the execution order and depends on all other sections being complete.

**Deliverables:**
1. `/home/user/sitemgr/docs/KEY_ROTATION.md` -- Key rotation runbook
2. `/home/user/sitemgr/docs/RLS_POLICIES.md` -- RLS policy documentation
3. Updated `/home/user/sitemgr/01-data-foundation/spec.md` -- Schema reference reflecting all changes

**Dependencies:** Sections 01 through 09 must be complete before writing this documentation. The content of these documents is derived from the actual implementation outcomes.

---

## Verification Checks

There are no automated tests for this section. Verification is by review.

```
# Verify: docs/KEY_ROTATION.md exists and covers rotation procedure
# Verify: docs/RLS_POLICIES.md exists and covers each table
# Verify: 01-data-foundation/spec.md updated with schema changes
```

---

## Deliverable 1: Key Rotation Runbook

**File:** `/home/user/sitemgr/docs/KEY_ROTATION.md`

This file documents the tested key rotation procedure based on results from sections 01 (encryption fix) and 05 (encryption tests). It must be a standalone operational runbook that an operator can follow without reading any other document.

### Content Requirements

The runbook must cover these topics, in this order:

**1. Prerequisites**
- Which environment variables must exist before starting (`ENCRYPTION_KEY_CURRENT` at minimum)
- How to generate a new key (algorithm, length, encoding requirements matching AES-GCM expectations)
- Where keys are stored (Vercel environment variables only, never GitHub)

**2. Step-by-step rotation procedure**
- Adding `ENCRYPTION_KEY_NEXT` in Vercel
- Validating the NEXT key works locally (using `vi.stubEnv()` in test files, not by setting real env vars)
- Promoting NEXT to CURRENT: saving old CURRENT as PREVIOUS first, then replacing CURRENT with the NEXT value, then removing NEXT
- Deploying and triggering lazy migration
- Specific Vercel CLI commands for each step (reference the existing commands in `/home/user/sitemgr/docs/ENV_VARS.md` which already has a rotation procedure skeleton, but expand with more operational detail)

**3. Monitoring lazy migration progress**
- What log messages to look for: `[Lazy Migration]` entries indicating records being re-encrypted
- How to query the database to check which `bucket_configs` records still have old `encryption_key_version` values
- What "migration complete" looks like (no more lazy migration log entries, all records show current version)

**4. Verification queries**
- SQL query to count records by `encryption_key_version` on `bucket_configs`
- How to confirm a specific record decrypts correctly after rotation

**5. Rollback procedure**
- If issues arise mid-rotation: restore PREVIOUS as CURRENT, remove the new key
- If lazy migration produces errors: how to identify affected records and re-encrypt manually

**6. Post-rotation cleanup**
- When it is safe to remove `ENCRYPTION_KEY_PREVIOUS` from Vercel
- Confirmation checklist before removing the old key

### Relationship to existing docs

The file `/home/user/sitemgr/docs/ENV_VARS.md` already contains a "Key Rotation Procedure" section with basic CLI commands. The new `KEY_ROTATION.md` should be the authoritative, expanded version. Update `ENV_VARS.md` to add a cross-reference: "For the full rotation procedure, see `docs/KEY_ROTATION.md`."

---

## Deliverable 2: RLS Policy Documentation

**File:** `/home/user/sitemgr/docs/RLS_POLICIES.md`

This file documents the RLS policies as they exist after all migrations from sections 02 (RLS audit), 04 (RPC user isolation), 06 (RLS tests), and 08 (phone migration) have been applied.

### Content Requirements

**Per-table sections** for each of the 6 tables: `events`, `enrichments`, `watched_keys`, `bucket_configs`, `conversations`, `user_profiles`.

Each table section must include:

**1. Policy listing**
- Policy name, operation (SELECT/INSERT/UPDATE/DELETE), and the USING/WITH CHECK expression
- Whether the policy uses `TO authenticated` restriction
- Whether the policy uses `(SELECT auth.uid())` wrapping for performance

**2. Auth model**
- After the phone-to-user_id migration (section 08), all policies should use `user_id`-only auth
- Document any tables that still reference `phone_number` and why (e.g., `user_profiles` keeps phone for WhatsApp display, `conversations` keeps phone as a column but primary key is now `user_id`)

**3. Client key usage**
- Which code paths use `getAdminClient()` (service role, bypasses RLS) and why they are authorized to do so (background enrichment pipeline, sync workers)
- Which code paths use `getUserClient()` (publishable key with auth context, RLS enforced) for user-facing operations
- This information comes from the client refactor in section 03

**4. RPC function security**
- Document `search_events()`, `stats_by_content_type()`, `stats_by_event_type()` with their `p_user_id` parameter requirement (from section 04)
- Document `get_user_id_from_phone()` restriction (moved to private schema or converted to SECURITY INVOKER, per section 02 findings)
- Note which functions are SECURITY INVOKER vs SECURITY DEFINER

**5. Index coverage**
- List the indexes that support RLS policy evaluation
- `events.user_id`, `bucket_configs.user_id`, `watched_keys.user_id`, etc.
- Note any missing indexes that should be added

**6. Testing**
- Reference the RLS test suite from section 06 (`rls-policies.test.ts`)
- Summarize what the tests verify: cross-tenant isolation, anon blocking, insert restrictions, phone-based access

---

## Deliverable 3: Updated spec.md

**File:** `/home/user/sitemgr/01-data-foundation/spec.md`

Update the existing spec to reflect all schema and architecture changes from sections 01 through 09. The current spec is at `/home/user/sitemgr/01-data-foundation/spec.md`.

### Changes to incorporate

**Database Schema section:**
- `watched_keys` primary key changed from `s3_key` to `(s3_key, bucket_config_id)` (from section 07, data integrity tests that identified the collision bug)
- `conversations` primary key changed from `phone_number` to `user_id` (from section 08)
- `user_id` is now NOT NULL on `events`, `bucket_configs`, `watched_keys` (from section 08 Phase 3)
- `phone_number` columns dropped from `bucket_configs`, `watched_keys`, `events` (from section 08 Phase 3)
- `phone_number` retained on `user_profiles` (needed for WhatsApp) and `conversations` (display only, no longer primary key)

**Encryption section:**
- Note that `encryption.ts` now accepts key as a parameter (no more process.env side-channel) from section 01
- Reference the key rotation runbook (`docs/KEY_ROTATION.md`)

**Auth and Security section:**
- Remove "Dual auth: phone_number (WhatsApp) and user_id (web)" -- after section 08, auth is user_id-only
- Replace with: "Supabase Auth with user_id-only RLS policies. Phone number retained in user_profiles for WhatsApp display."
- Document the two client constructors: `getAdminClient()` and `getUserClient()` from section 03
- Note RLS performance optimizations: `(SELECT auth.uid())` wrapping, `TO authenticated` restriction

**RPC Functions section:**
- Update `search_events()`, `stats_by_content_type()`, `stats_by_event_type()` to show the `p_user_id UUID` parameter
- Update `get_user_id_from_phone()` to reflect its restricted access

**Key Files section:**
- Add `docs/KEY_ROTATION.md`
- Add `docs/RLS_POLICIES.md`
- Update paths if any files moved during refactoring

**Event ID format:**
- Note that `newEventId()` now generates ULIDs (from section 09)
- Note mixed ID formats in the events table (old truncated UUIDs, new ULIDs)
- Clarify that `timestamp` column remains the authoritative chronological sort key

---

## Implementation Checklist

1. Write `/home/user/sitemgr/docs/KEY_ROTATION.md` following the content requirements above, incorporating actual implementation details from sections 01 and 05.
2. Write `/home/user/sitemgr/docs/RLS_POLICIES.md` following the content requirements above, incorporating actual policy definitions from the final migration state after sections 02, 04, 06, and 08.
3. Update `/home/user/sitemgr/01-data-foundation/spec.md` with all schema and architecture changes from sections 01 through 09.
4. Update `/home/user/sitemgr/docs/ENV_VARS.md` to add a cross-reference to the new `KEY_ROTATION.md` in the "Key Rotation Procedure" section (replace the inline procedure with a pointer, or keep both with a note that `KEY_ROTATION.md` is the authoritative source).
5. Review all three documents for internal consistency -- table names, column names, policy names, and file paths must match the actual implementation.