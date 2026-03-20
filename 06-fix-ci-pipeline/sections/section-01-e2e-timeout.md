# Section 01: E2E beforeAll Timeout Fix

## Overview

Add an explicit 60-second timeout to `test.beforeAll()` in the Playwright E2E test file `web/e2e/agent.spec.ts`. The current test performs user signup + email confirmation via Mailpit with exponential backoff that can take up to ~50 seconds, but Playwright's default beforeAll timeout is 30 seconds.

## File to Modify

**`web/e2e/agent.spec.ts`**

## Current Code (line 69)

```typescript
test.beforeAll(async ({ browser }) => {
  // ... signup + confirmation flow ...
  await page.close();
});
```

## Required Change

Add a timeout options object as the second argument to `test.beforeAll`:

```typescript
test.beforeAll(async ({ browser }) => {
  // ... signup + confirmation flow (unchanged) ...
  await page.close();
}, { timeout: 60000 });
```

The closing `});` on line 101 becomes `}, { timeout: 60000 });`.

## Why This Change

- `getConfirmationLink()` retries up to 10 times with exponential backoff capped at 5s per attempt → worst case ~50s
- Playwright default `beforeAll` timeout is 30s → insufficient
- 60s provides 10s headroom
- Options-object syntax (`{ timeout: 60000 }`) is more explicit and portable than `test.setTimeout()` inside the callback
- Uses `60000` (no numeric separator) to match existing code style (`30000`, `10000`, `20000` elsewhere in the file)

## Testing

### Pre-implementation
- Confirm `test.beforeAll` at line 69 has no timeout parameter

### Post-implementation
- Run `npx playwright test` locally — beforeAll completes without timeout
- No TypeScript type errors from the options object
- The beforeAll body is completely unchanged — only the closing line changes
