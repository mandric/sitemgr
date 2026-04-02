# Integration Notes: Opus Review Feedback

## Integrating

1. **SECURITY INVOKER note** — Adding explicit note that RPC must NOT use SECURITY DEFINER. Good catch.
2. **Correct index claim** — Removing misleading claim about idx_events_content_hash covering the query. Performance is fine at expected scale.
3. **Multipart ETag limitation** — Adding a note. Not actionable now but should be documented.
4. **Update s3Metadata call** — Adding to Section 1. The third arg should pass actual ETag, not empty string.
5. **LANGUAGE sql STABLE** — Adding to RPC section. Matches existing patterns.
6. **CLI extra_copies formula** — Adding: `sum(group.copies - 1)`.
7. **ETag quote stripping method** — Specifying `.replace(/"/g, "")` to match listS3Objects.
8. **Remove contentHash variable** — Making explicit (not just import removal).

## NOT Integrating

- **Test plan in claude-plan.md** — Already covered in claude-plan-tdd.md. No need to duplicate.
