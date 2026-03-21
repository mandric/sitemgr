I now have all the information needed to write the section. The two occurrences of `ENCRYPTION_KEY` in `scripts/deploy.sh` are on line 36 (in the `REQUIRED_VARS` array) and line 139 (in the `supabase secrets set` call). `scripts/lib.sh` has no references to `ENCRYPTION_KEY`. `.github/workflows/ci.yml` has no references either.

# Section 9: Fix `scripts/deploy.sh` Deprecated Key Name

## Overview

`scripts/deploy.sh` references `ENCRYPTION_KEY` at two locations. Per `docs/ENV_VARS.md`, the name `ENCRYPTION_KEY` was removed and replaced by `ENCRYPTION_KEY_CURRENT`. Leaving the old name in `deploy.sh` is a latent production bug: the required-variable check will pass when `ENCRYPTION_KEY` is set (the old Vercel secret name), but any code that reads `ENCRYPTION_KEY_CURRENT` at runtime will get an empty value.

This section has no dependencies on other sections and can be implemented in parallel.

---

## Verification Test (run after changes)

```bash
# Test: no remaining references to deprecated ENCRYPTION_KEY
grep '\bENCRYPTION_KEY\b' scripts/deploy.sh scripts/lib.sh .github/workflows/*.yml \
  | grep -v 'ENCRYPTION_KEY_CURRENT\|ENCRYPTION_KEY_PREVIOUS\|ENCRYPTION_KEY_NEXT' \
  && echo "FAIL: deprecated name still present" || echo "PASS"
```

This grep should produce no matching lines after the fix. The pattern uses `\b` word boundaries so it matches the bare name `ENCRYPTION_KEY` but not the longer names that contain it as a prefix.

---

## Files to Modify

### `scripts/deploy.sh`

Two locations require changes.

**Location 1 — `REQUIRED_VARS` array (line 36):**

The array currently contains `"ENCRYPTION_KEY"`. Change it to `"ENCRYPTION_KEY_CURRENT"`.

```bash
REQUIRED_VARS=(
    "SUPABASE_ACCESS_TOKEN"
    "SUPABASE_PROJECT_REF"
    "ANTHROPIC_API_KEY"
    "TWILIO_ACCOUNT_SID"
    "TWILIO_AUTH_TOKEN"
    "TWILIO_WHATSAPP_FROM"
    "ENCRYPTION_KEY_CURRENT"   # was: ENCRYPTION_KEY
)
```

**Location 2 — `supabase secrets set` block (line 139):**

The `supabase secrets set` call currently passes `ENCRYPTION_KEY="$ENCRYPTION_KEY"`. Change the key name and the variable reference to `ENCRYPTION_KEY_CURRENT`:

```bash
supabase secrets set \
    ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
    TWILIO_ACCOUNT_SID="$TWILIO_ACCOUNT_SID" \
    TWILIO_AUTH_TOKEN="$TWILIO_AUTH_TOKEN" \
    TWILIO_WHATSAPP_FROM="$TWILIO_WHATSAPP_FROM" \
    ENCRYPTION_KEY_CURRENT="$ENCRYPTION_KEY_CURRENT"   # was: ENCRYPTION_KEY="$ENCRYPTION_KEY"
```

Note: The argument to `supabase secrets set` sets the secret name inside Supabase Edge Functions. Changing this name means any Edge Function that previously read `ENCRYPTION_KEY` from Deno.env must also be updated — but since the web app now uses Vercel API routes (not Edge Functions) and the encryption code reads `ENCRYPTION_KEY_CURRENT`, this rename is correct.

### `scripts/lib.sh` — No changes needed

Searching `scripts/lib.sh` for `ENCRYPTION_KEY` yields no matches. No edits required.

### `.github/workflows/ci.yml` — No changes needed

Searching `.github/workflows/ci.yml` for `ENCRYPTION_KEY` yields no matches. No edits required.

---

## Context

The encryption module at `web/lib/crypto/encryption-versioned.ts` reads `ENCRYPTION_KEY_CURRENT` from the environment. The naming convention for encryption keys is status-based:

- `ENCRYPTION_KEY_CURRENT` — active key for new encryptions (required in production)
- `ENCRYPTION_KEY_PREVIOUS` — old key used during rotation (optional)
- `ENCRYPTION_KEY_NEXT` — future key for gradual rollout (optional)

The bare name `ENCRYPTION_KEY` is entirely removed from the codebase. Any Vercel or Supabase environment configuration that still uses `ENCRYPTION_KEY` must be updated to `ENCRYPTION_KEY_CURRENT` separately (in the respective dashboards).