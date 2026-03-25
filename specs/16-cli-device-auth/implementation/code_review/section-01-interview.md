# Section 01 Code Review Interview

## Auto-fixes Applied

### 1. Tighten anon INSERT WITH CHECK clause (MEDIUM)
- **Issue:** `WITH CHECK (true)` allows anon to insert rows with `status='approved'`, pre-set `token_hash`, etc.
- **Fix:** Changed to `WITH CHECK (status = 'pending' AND user_id IS NULL AND token_hash IS NULL AND approved_at IS NULL AND email IS NULL)`
- **Rationale:** Prevents privilege escalation via direct Supabase client access.

### 2. Add column exclusivity assertion to RPC test (LOW)
- **Issue:** Test verified correct fields but didn't assert no extra fields returned.
- **Fix:** Added `expect(Object.keys(data[0]).sort()).toEqual([...].sort())` assertion.

### 3. Add negative test for anon INSERT with privileged fields (LOW)
- **Issue:** No test verifying the tightened policy rejects malicious inserts.
- **Fix:** Added test case "anon CANNOT insert with privileged fields".

## Items Let Go

- **Duplicate SchemaInfo interface** — minor duplication, can extract later
- **afterAll robustness** — negligible risk
- **Rate limiting on RPC** — handled by API layer in sections 03/04
