# Codebase Research — Content Type Filtering

## Critical Discovery: Production Uses Simple Labels, NOT MIME Types

The spec assumes production data uses MIME types (`"image/jpeg"`), but the **actual production code maps MIME types to simple labels**:

### Production Path (web/lib/agent/core.ts → detectContentType)

```
file.jpg → mime-types lookup → "image/jpeg" → CONTENT_TYPE_MAP → "photo"
```

**CONTENT_TYPE_MAP (web/lib/media/constants.ts:15-19):**
```typescript
export const CONTENT_TYPE_MAP: Record<string, string> = {
  image: "photo",
  video: "video",
  audio: "audio",
};
```

**detectContentType (web/lib/media/utils.ts:24-30):**
```typescript
export function detectContentType(pathOrKey: string): string {
  const mime = lookup(pathOrKey);
  if (mime) {
    const major = mime.split("/")[0];
    return CONTENT_TYPE_MAP[major] ?? "file";
  }
  return "file";
}
```

**Result:** Production events store `content_type: "photo"`, NOT `"image/jpeg"`.

---

## Current Filtering Code

| Function | File:Line | Current Filter | Issue |
|----------|-----------|---------------|-------|
| `getEnrichStatus()` | db.ts:263 | No content_type filter | Counts all media types |
| `getStats()` | db.ts:244 | `contentTypeCounts["photo"]` | Correct for production data, wrong for test fixtures using MIME types |
| `getPendingEnrichments()` | db.ts:405 | `.eq("content_type", "photo")` | Correct for production data |

## Test Data Inconsistency

| Location | content_type value | Matches production? |
|----------|-------------------|-------------------|
| `seedUserData()` (setup.ts:176) | `"image/jpeg"` | NO |
| smgr-cli.test.ts:234, 347 | `"photo"` | YES |
| media-lifecycle.test.ts:124, 176 | `"image/jpeg"` | NO |
| media-lifecycle.test.ts:189 | `"video/mp4"` | NO |

## Key Implication

The spec's proposed fix (`.like("content_type", "image/%")`) would **break production filtering** because production data contains `"photo"`, not `"image/jpeg"`. The real fix may be:

1. **Option A:** Keep `"photo"` filtering, fix `getEnrichStatus()` to add `.eq("content_type", "photo")`, fix test fixtures to use `"photo"` consistently
2. **Option B:** Change production to store MIME types, then use `.like("content_type", "image/%")` everywhere — but this is a larger change affecting existing data

This needs to be resolved in the interview.

## Database Schema

- `content_type TEXT` column on events table
- Indexed: `CREATE INDEX idx_events_content_type ON events(content_type)`
- `stats_by_content_type()` RPC groups by content_type, returns counts
- `search_events()` RPC does exact match on content_type

## Testing Setup

- Vitest framework
- Integration tests in `web/__tests__/integration/`
- `seedUserData()` helper in `setup.ts` creates test events
- Tests use real Supabase (local) for integration tests
