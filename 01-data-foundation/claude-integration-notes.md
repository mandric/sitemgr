# Integration Notes — Opus Review

## Integrating

1. **Process.env race condition in encryption (Critical #1)** — Integrating. This is a real async interleaving bug. Adding new Section 2.5 to refactor encryption.ts to accept key as parameter. High priority.

2. **getSupabaseClient() uses service role key (Critical #3)** — Integrating. This fundamentally undermines RLS enforcement. Adding to Section 2.1 as a top-priority finding — need to distinguish admin vs user-scoped clients.

3. **RPC functions need user_id filtering (Significant #4)** — Integrating. Strengthening Section 2.3 from "verify" to "add user_id parameter to all RPC functions."

4. **get_user_id_from_phone() SECURITY DEFINER vulnerability (#6)** — Integrating. Adding to Section 2.1 as information disclosure risk.

5. **Missing user_id on insert functions (#7)** — Integrating. Expanding Section 5.3 to enumerate every insert path.

6. **conversations primary key migration (#9)** — Integrating. Adding explicit handling to Section 5.

7. **watched_keys collision bug (#10)** — Integrating. Adding to Section 4.3 and flagging as a schema fix needed.

8. **ULID clarification (#8)** — Integrating. Updating Section 6 to clarify B-tree locality vs ordering benefits.

9. **Success criteria (#14)** — Integrating. Adding deliverables to each section.

10. **TO authenticated timing (#15)** — Integrating. Deferring TO authenticated to Phase 2 of phone→user_id migration to avoid duplicate work.

## NOT Integrating

1. **user_profiles INSERT policy for WhatsApp (#5)** — Not integrating as a plan change. This is a 03-agent-messaging concern (WhatsApp bot creates profiles). The data foundation plan should note the policy exists but not change it — the agent layer handles profile creation via service role key.

2. **N+1 query in queryEvents (#12)** — Not integrating. This is a 02-media-pipeline optimization concern. Noted for that split's plan.

3. **Missing DOWN migrations (#11)** — Partially integrating. Will scope migration tests to forward-only and add a note that down migrations are a future enhancement, not a v1 requirement.

4. **encryption_key_version column redundancy (#13)** — Not integrating as a removal. The column serves as a database-level audit trail independent of ciphertext inspection. Both mechanisms have value. Will document the relationship.
