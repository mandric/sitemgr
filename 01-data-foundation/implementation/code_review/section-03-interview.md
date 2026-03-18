# Section 03 Code Review Interview

## Interview Decisions

### findEventByHash client assignment
- **Finding:** Uses getUserClient but called from indexing pipeline; may silently fail when RLS is tightened
- **Decision:** Keep as getUserClient per plan. Will address in section-08 (phone-to-user_id migration)
- **User chose:** "Keep as getUserClient"

## Auto-fixes (not applied)
- No client caching: Out of scope, inherited from old code
- Whitespace sanitization: Inherited, not changing

## Let go
- Test with undefined vs empty string: Both paths work; minor
- JSDoc placement: Implementation is correct
- vi.hoisted: Positive improvement, no action needed
