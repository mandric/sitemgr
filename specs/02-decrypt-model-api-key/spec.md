# Spec: Decrypt api_key_encrypted Before Use

## Problem

In `web/bin/smgr.ts` (lines 663–669), the CLI loads a user's model config from the database and passes `api_key_encrypted` directly as the API key — without decrypting it:

```typescript
modelConfig = {
  provider: configRow.provider,
  baseUrl: configRow.base_url,
  model: configRow.model,
  apiKey: configRow.api_key_encrypted,  // ciphertext, not plaintext
};
```

This `modelConfig` is later passed to `enrichImage()` in `web/lib/media/enrichment.ts`, which uses `config.apiKey` in an HTTP `Authorization: Bearer` header:

```typescript
headers: {
  "Content-Type": "application/json",
  ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
},
```

The API receives ciphertext like `current:base64...` instead of the actual API key, causing all enrichment requests through custom model configs to fail with 401/403 authentication errors.

## Affected Flow

```
model_configs table (api_key_encrypted: "current:<base64 ciphertext>")
  → getModelConfig() returns row as-is (correct — db layer doesn't transform)
  → smgr.ts assigns configRow.api_key_encrypted to modelConfig.apiKey (BUG)
  → enrichImage() sends ciphertext as Bearer token
  → External API rejects with auth error
```

## Available Infrastructure

The codebase already has full encryption support:

- **`web/lib/crypto/encryption.ts`**: `encryptSecret()` / `decryptSecret()` (AES-256-GCM)
- **`web/lib/crypto/encryption-versioned.ts`**: `decryptSecretVersioned()` — handles label-prefixed ciphertext (`current:...`, `previous:...`, `next:...`) and routes to the correct key via `ENCRYPTION_KEY_CURRENT` / `ENCRYPTION_KEY_PREVIOUS` / `ENCRYPTION_KEY_NEXT` env vars.

The versioned decryption function is the correct one to use, since stored values use the `current:base64...` format.

## Proposed Fix

### In `smgr.ts`, decrypt the key after loading from the database

```typescript
import { decryptSecretVersioned } from "@/lib/crypto/encryption-versioned";

// Inside the model config loading block:
if (configRow) {
  let apiKey: string | null = null;
  if (configRow.api_key_encrypted) {
    apiKey = await decryptSecretVersioned(configRow.api_key_encrypted);
  }
  modelConfig = {
    provider: configRow.provider,
    baseUrl: configRow.base_url,
    model: configRow.model,
    apiKey,
  };
}
```

### Why decrypt in smgr.ts (not in db.ts or enrichment.ts)

Per `CLAUDE.md`: the db layer's job is query encapsulation, not return value transformation. `getModelConfig()` correctly returns the row as-is. The caller (`smgr.ts`) is the right place to decrypt because:

1. It's the boundary between storage and usage.
2. It already knows it needs a plaintext key for enrichment.
3. `db.ts` would need `ENCRYPTION_KEY_*` env vars as a dependency, coupling the data layer to the crypto layer unnecessarily.
4. Future callers may want the encrypted form (e.g., for re-encryption or migration).

## Files to Change

| File | Change |
|------|--------|
| `web/bin/smgr.ts` | Import `decryptSecretVersioned`; decrypt `api_key_encrypted` before assigning to `modelConfig.apiKey` |

## Environment Requirements

`smgr.ts` must have access to `ENCRYPTION_KEY_CURRENT` (and optionally `ENCRYPTION_KEY_PREVIOUS` / `ENCRYPTION_KEY_NEXT`) in its runtime environment. This should already be the case for production CLI usage — verify in deployment docs.

## Testing

- **Unit**: Stub `ENCRYPTION_KEY_CURRENT` via `vi.stubEnv()` with a test fixture key. Encrypt a known API key, store it in a mock `getModelConfig` return, verify the decrypted value matches the original plaintext.
- **Integration**: `smgr-cli.test.ts` — if it exercises enrichment with a model config, verify the Authorization header contains a valid (decrypted) key.
- **Edge case**: `api_key_encrypted` is `null` (e.g., local Ollama model) — `apiKey` should remain `null`, no decryption attempted.

## Risks

- **Missing env var**: If `ENCRYPTION_KEY_CURRENT` is not set in the CLI's environment, `decryptSecretVersioned()` will throw. This is the correct behavior — fail loudly rather than send ciphertext to an external API. Add a clear error message if needed.
- **Key rotation**: If the stored value was encrypted with a previous key, `decryptSecretVersioned()` handles this automatically via the label prefix routing. No special handling needed.
