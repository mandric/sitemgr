I have all the context I need. Now I'll produce the section content.

# Section 06: Web UI -- Device Approval Page

## Overview

This section implements the `/auth/device` page where authenticated users approve a CLI device code. The page is a simple React client component that reads a `code` query parameter from the URL, displays the code to the user, and calls `POST /api/auth/device/approve` when the user clicks "Approve."

**Dependencies:**
- section-05-api-approve must be complete (the `POST /api/auth/device/approve` endpoint must exist)

**Files to create:**
- `web/app/auth/device/page.tsx` -- the page component
- `web/components/device-approve-form.tsx` -- the client component with form logic
- `web/__tests__/device-approve-form.test.tsx` -- unit tests

## Tests (Write First)

All tests go in `web/__tests__/device-approve-form.test.tsx`. These are unit-level component tests that mock `fetch` and validate rendering states. They run in the `unit` vitest project.

Since the existing codebase has no component test infrastructure (no jsdom environment, no React Testing Library), the tests should use a lightweight approach: test the logic functions extracted from the component, or set up minimal component testing.

**Practical approach:** Because vitest is configured with `environment: "node"` for unit tests and the project has no existing component test setup (no `@testing-library/react`, no jsdom), write tests that validate the approval logic as an extracted async function rather than full DOM rendering tests. This avoids introducing a large new test dependency for a single component.

**Test file:** `web/__tests__/device-approve-form.test.ts`

Tests to write:

1. **Test: `approveDevice` calls fetch with correct URL and body** -- Mock `globalThis.fetch`, call the extracted `approveDevice(userCode)` function, assert it called `POST /api/auth/device/approve` with `{ user_code: userCode }`.

2. **Test: `approveDevice` returns success on 200 response** -- Mock fetch to return `{ ok: true, json: () => ({ success: true }) }`, verify the function returns a success result.

3. **Test: `approveDevice` returns error message on 404 response** -- Mock fetch to return 404 with `{ error: "Code not found or expired" }`, verify the function returns the error.

4. **Test: `approveDevice` returns error on network failure** -- Mock fetch to throw, verify the function returns a generic error.

5. **Test: `parseCodeFromUrl` extracts code from query string** -- Given a URL search string `?code=ABCD-1234`, returns `"ABCD-1234"`.

6. **Test: `parseCodeFromUrl` returns null when no code param** -- Given `?other=value`, returns `null`.

7. **Test: `parseCodeFromUrl` normalizes code to uppercase** -- Given `?code=abcd-1234`, returns `"ABCD-1234"`.

The helper functions under test (`approveDevice` and `parseCodeFromUrl`) should be exported from a small utility file or directly from the component file so tests can import them.

**Suggested test structure:**

```typescript
// web/__tests__/device-approve-form.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { approveDevice, parseCodeFromUrl } from "@/components/device-approve-form";

describe("parseCodeFromUrl", () => {
  // Test: extracts code from ?code=ABCD-1234
  // Test: returns null when no code param
  // Test: normalizes to uppercase
});

describe("approveDevice", () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  // Test: calls fetch with correct URL and body
  // Test: returns success on 200
  // Test: returns error message on 404
  // Test: returns error on network failure
});
```

## Implementation Details

### Page Component: `web/app/auth/device/page.tsx`

This is a thin server component wrapper that follows the same pattern as `/auth/login/page.tsx` and `/auth/forgot-password/page.tsx`: a centered layout with a max-width card.

**Pattern to follow** (from `web/app/auth/login/page.tsx`):

```typescript
import { DeviceApproveForm } from "@/components/device-approve-form";

export default function Page() {
  return (
    <div className="flex min-h-svh w-full items-center justify-center p-6 md:p-10">
      <div className="w-full max-w-sm">
        <DeviceApproveForm />
      </div>
    </div>
  );
}
```

### Authentication / Middleware

The existing middleware in `web/middleware.ts` already handles auth redirection for all non-`/api/`, non-`/auth/` paths. Since the page is under `/auth/device`, it is **not** automatically redirected to login by middleware (the middleware explicitly skips paths starting with `/auth`).

This means the component itself must check for authentication and handle the unauthenticated case. Two options:

1. **Client-side approach (recommended):** The form component calls `POST /api/auth/device/approve` which returns 401 if not authenticated. On 401, redirect the user to `/auth/login?redirect=/auth/device?code=XXXX-XXXX` (URL-encoded).

2. **Server-side approach:** Make the page a server component that checks auth and redirects. This is more complex and doesn't match existing patterns.

Use option 1 -- the client component handles the 401 by redirecting to login with the return URL.

### Form Component: `web/components/device-approve-form.tsx`

A `"use client"` component using the same shadcn/ui Card pattern as `login-form.tsx`.

**Exported utilities** (for testability):

- `parseCodeFromUrl(searchParams: string): string | null` -- Extracts and uppercases the `code` query parameter.
- `approveDevice(userCode: string): Promise<{ success: boolean; error?: string }>` -- Calls `POST /api/auth/device/approve` with `{ user_code: userCode }`, returns parsed result. Handles network errors gracefully.

**Component states:**

| State | Condition | What to render |
|-------|-----------|----------------|
| Input | No code in URL or user wants to type manually | Card with text input for code, "Approve" button |
| Prefilled | Code present in URL `?code=XXXX-XXXX` | Card showing the code prominently, "Approve" button |
| Loading | After clicking Approve | Button disabled with "Approving..." text |
| Success | API returned 200 | "Device approved! You can close this tab and return to your terminal." |
| Error | API returned 404 or network error | Error message in red, option to try again |

**Component behavior:**

1. On mount, read `code` from `window.location.search` using `useSearchParams()` from `next/navigation`.
2. If code is present, pre-fill the input and display it prominently.
3. If no code, show an empty input field for manual entry.
4. On form submit, call `approveDevice(userCode)`.
5. If the response indicates 401, redirect to `/auth/login` with the current URL as the redirect parameter (use `encodeURIComponent` to preserve the `?code=` query param in the redirect URL).
6. On success, show the success message.
7. On error, show the error message.

**UI components to use** (all already in the project):
- `Card`, `CardContent`, `CardHeader`, `CardTitle`, `CardDescription` from `@/components/ui/card`
- `Input` from `@/components/ui/input`
- `Button` from `@/components/ui/button`
- `Label` from `@/components/ui/label`

**Key design details:**
- The code input should use `font-mono text-2xl tracking-widest text-center` for the `XXXX-XXXX` display, making it easy to visually verify.
- The input field should accept the code with or without the dash (normalize on submit).
- Card title: "Approve Device"
- Card description: "A CLI is requesting access to your account."
- When code is pre-filled from URL, show it as a large styled display rather than an editable input (with a small "Not this code?" link to switch to manual input mode).

### Redirect Flow

When an unauthenticated user visits `/auth/device?code=ABCD-1234`:

1. Middleware sees path starts with `/auth` and lets it through.
2. The component renders and user clicks "Approve."
3. The approve API returns 401.
4. The component redirects to: `/auth/login?redirect=%2Fauth%2Fdevice%3Fcode%3DABCD-1234`
5. After login, the existing auth flow redirects back to `/auth/device?code=ABCD-1234`.
6. The component loads again, code is pre-filled, user clicks "Approve" -- this time it succeeds.

Note: The existing login flow must support the `redirect` query parameter for post-login redirection. Check if `login-form.tsx` already reads a `redirect` param and navigates there after successful login. If not, this may need a small addition (but that is outside this section's scope -- document the dependency).

### No Server-Side Rendering Concerns

The page is entirely client-rendered (`"use client"`). It reads query params on the client and makes fetch calls. No SSR data fetching needed.