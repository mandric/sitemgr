Good, I have all the context needed. Here is the section content:

# Section 1: Export Content Type Label Constants

## Overview

This section introduces named constants for the four content type labels (`"photo"`, `"video"`, `"audio"`, `"file"`) used throughout the media subsystem. Currently these values appear as raw string literals in `CONTENT_TYPE_MAP`, query filters in `db.ts`, and test fixtures. Centralizing them into exported constants in `constants.ts` prevents typo-driven bugs and provides a single source of truth.

This section has no dependencies and blocks section-02 (fix filter) and section-03 (fix fixtures), both of which import these constants.

## Tests

No dedicated test file is needed for this section. The constants are pure value definitions with no logic. They are validated indirectly by all tests in sections 2-4 that import and use them. The key validation is that existing tests continue to pass after the refactor (i.e., the constant values match what the code already expects).

## Implementation

### File: `/home/user/sitemgr/web/lib/media/constants.ts`

Add four named constants before `CONTENT_TYPE_MAP`, then update `CONTENT_TYPE_MAP` to reference them:

```typescript
export const CONTENT_TYPE_PHOTO = "photo";
export const CONTENT_TYPE_VIDEO = "video";
export const CONTENT_TYPE_AUDIO = "audio";
export const CONTENT_TYPE_FILE = "file";
```

Update `CONTENT_TYPE_MAP` (currently at line 15) to use the constants instead of string literals:

```typescript
export const CONTENT_TYPE_MAP: Record<string, string> = {
  image: CONTENT_TYPE_PHOTO,
  video: CONTENT_TYPE_VIDEO,
  audio: CONTENT_TYPE_AUDIO,
};
```

The fallback to `"file"` happens in `detectContentType()` (not in this map), but the `CONTENT_TYPE_FILE` constant is exported so that callers can reference it if needed.

### File: `/home/user/sitemgr/web/lib/media/db.ts`

Import the constants at the top of the file:

```typescript
import { CONTENT_TYPE_PHOTO } from "@/lib/media/constants";
```

Update two locations that currently use raw `"photo"` strings:

1. **Line 245** -- `contentTypeCounts["photo"]` becomes `contentTypeCounts[CONTENT_TYPE_PHOTO]`
2. **Line 405** -- `.eq("content_type", "photo")` becomes `.eq("content_type", CONTENT_TYPE_PHOTO)`

No other references to raw content type strings exist in `db.ts`. The `getEnrichStatus()` function does not yet have a content type filter -- that is added in section-02.

## Checklist

1. Add the four `CONTENT_TYPE_*` constants to `/home/user/sitemgr/web/lib/media/constants.ts`
2. Rewrite `CONTENT_TYPE_MAP` values to reference the new constants
3. Import `CONTENT_TYPE_PHOTO` in `/home/user/sitemgr/web/lib/media/db.ts`
4. Replace `contentTypeCounts["photo"]` (line 245) with `contentTypeCounts[CONTENT_TYPE_PHOTO]`
5. Replace `.eq("content_type", "photo")` (line 405) with `.eq("content_type", CONTENT_TYPE_PHOTO)`
6. Verify the file compiles: `npx tsc --noEmit --project /home/user/sitemgr/web/tsconfig.json` (or equivalent type-check command)