# Interview Transcript

## Q1: Should we flip the priority and lead with fixing brittle scripts before writing docs?

**Answer:** Scripts first (Recommended)

Fix brittle extraction and missing encryption key before writing docs — higher immediate value.

---

## Q2: Should we move bucket creation from the shell script into a SQL migration?

**Answer:** Yes, move to migration (Recommended)

Idempotent, version-controlled, auto-runs on `supabase start` and `db reset`.

---

## Q3: For ENCRYPTION_KEY_CURRENT in local dev — what should the local value be?

**Answer:** Generate random key on first setup

Script generates a random 32-byte hex key, writes it to `.env.local` — developer doesn't need to think about it.

---

## Q4: Should .env.local be the single source of truth for env vars (test-integration.sh sources it rather than re-extracting)?

**Answer:** Yes, .env.local as source of truth (Recommended)

`test-integration.sh` sources `.env.local`, no more duplicate extraction logic.

---

## Q5: The legacy tests/integration_test.sh references non-existent files — delete or keep with deprecation?

**Answer:** Delete it

It references non-existent files (`python3 prototype/smgr.py`) and creates confusion about which runner is canonical.

---

## Q6: For component scripts, should they output to stdout or write directly to .env.local?

**Answer:** Write to .env.local directly

Simpler — script just does the thing, developer sources the file after.

---

## Q7: How detailed should verify.sh be?

**Answer:** Basic: API reachable + env vars set

Fast check — curl Supabase health endpoint, verify key env vars are non-empty.

---

## Q8: Should component docs be standalone references or a linear quickstart narrative?

**Answer:** Quickstart narrative (Recommended)

One linear flow a developer follows start to finish — simpler and more actionable.
