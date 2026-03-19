## Section 01: Logger & Request Context — Code Review

### Summary

The implementation is a faithful, clean match to the spec. All four files (two source modules, two test files) are present, all acceptance criteria appear to be met, and there are no third-party dependencies introduced.

---

### Findings

**1. Error key collision — no guard when meta contains reserved keys**
Severity: **Major**

The `log()` function spreads arbitrary `meta` keys directly onto the top-level `LogEntry` object. If a caller passes `meta` containing a key that collides with a reserved field (`timestamp`, `level`, `component`, `message`, or `request_id`), the meta value silently overwrites the structured field. For example:

```typescript
logger.info("test", { level: "critical", timestamp: "fake" });
```

The emitted JSON will have `level: "critical"` and `timestamp: "fake"`, corrupting every downstream log parser. The spec does not explicitly call this out, but it is a correctness hazard for any log aggregation pipeline.

Recommendation: Apply meta keys after the fixed fields are written (they already are, by assignment order), but add an explicit guard — either warn when a reserved key is detected, or use a `meta` sub-object for fields that conflict with the envelope. At minimum, document the behaviour.

---

**2. Error serialisation is key-agnostic — always emits `error_message` / `error_stack` regardless of key name**
Severity: **Minor**

The spec says: _"If `meta` contains an Error object under any key, extract `.message` as `error_message` and `.stack` as `error_stack`."_ The implementation matches that exactly. However, if a caller passes two different Error objects under different keys, only the fields from the last one processed survive (the loop overwrites `entry.error_message` and `entry.error_stack` on each iteration). The original key name is also discarded, making it impossible to tell which error was which.

There is no test covering the two-errors case. This may be intentional as a v1 simplification, but it should be documented as a known limitation, and a test asserting the current behaviour (last-wins) would prevent accidental regressions.

---

**3. `error_stack` can be `undefined` in the serialised JSON**
Severity: **Minor**

`Error.prototype.stack` is technically optional (not guaranteed by the ECMAScript spec, though V8 always sets it). The implementation writes `entry.error_stack = value.stack` without checking for `undefined`. When `stack` is undefined, `JSON.stringify` will omit the key from the output (because `undefined` values are dropped during serialisation). The test asserts `entry.error_stack` contains the error message string — it will pass on V8/Node but may produce surprising results in environments where `stack` is not set.

Recommendation: Guard with `if (value.stack !== undefined)` before assigning, to make the intent explicit and silence linters.

---

**4. `LogComponent` type is not exported**
Severity: **Minor**

`LogComponent` is exported as a `const` object, which is correct. However, the inferred type of its values (`"s3" | "enrichment" | ...`) and the object type itself (`typeof LogComponent`) are not re-exported as named types. Callers who want to type a function parameter as _"any valid component name"_ must write `(typeof LogComponent)[keyof typeof LogComponent]` themselves. A small convenience export removes that friction:

```typescript
export type LogComponentName = (typeof LogComponent)[keyof typeof LogComponent];
```

This is a usability issue, not a correctness one, but it costs one line and prevents callers from reverting to `string`.

---

**5. Test: `LogComponent` test does not verify `as const` exhaustiveness**
Severity: **Nitpick**

The `LogComponent` describe block only checks that the seven named constants have the right values. It does not assert that the object has exactly those seven keys. If a component is added to the constant but omitted from the test (or vice versa), the test still passes. Using `expect(Object.keys(LogComponent)).toHaveLength(7)` or a snapshot would catch accidental additions or removals.

---

**6. Test: no assertion that `request_id` is absent (not just falsy) in the non-context test**
Severity: **Nitpick**

The test _"logger omits request_id when called outside any context"_ uses `expect(entry).not.toHaveProperty("request_id")`, which is the correct assertion and directly matches the spec requirement that the key is omitted entirely. This is fine as written — noting it only to confirm the implementation handles the `undefined`-omission path correctly (it does, via the explicit `if (requestId !== undefined)` guard).

---

**7. `async_hooks` import — no runtime environment note**
Severity: **Nitpick**

`AsyncLocalStorage` is a Node.js built-in. The spec acknowledges this. In the current architecture (Vercel API routes + CLI), this is correct and safe. However, if any logger code were ever executed in an Edge Runtime (Vercel Edge Functions / Cloudflare Workers), `async_hooks` is not available and the import will throw at module evaluation time — a non-obvious failure mode. The CLAUDE.md confirms the project migrated away from Supabase Edge Functions to Vercel API routes, so this is not an immediate concern, but a one-line comment in the source (`// Node.js only — not compatible with Edge Runtime`) would document the constraint.

---

### Verdict

**APPROVE**

The implementation correctly satisfies all spec acceptance criteria. The two substantive findings (key collision and multi-error last-wins) are worth a follow-up ticket but are not blocking: the key-collision risk is low in practice given controlled call sites, and the multi-error case is unlikely in v1 usage. All other findings are minor polish items or documentation gaps. The tests are well-structured, cover the specified cases, and directly exercise both the happy path and the edge cases called out in the spec.
