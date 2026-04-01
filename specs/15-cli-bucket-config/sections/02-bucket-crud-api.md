# Section 02: Bucket CRUD API Routes

## Goal

Create REST API routes for bucket config management (list, add, delete, test connectivity). These routes are what the CLI calls instead of talking to S3 directly.

## Files to Create

### `web/app/api/buckets/route.ts`

**GET /api/buckets** — List user's bucket configs.
- Auth: `authenticateRequest` + `isAuthenticated` pattern (same as `/api/events`)
- Query: `supabase.from("bucket_configs").select("id, bucket_name, region, endpoint_url, created_at, last_synced_key").eq("user_id", user.id).order("created_at", { ascending: false })`
- Response: `{ data: [...] }` — no secrets in response (no `access_key_id`, no `secret_access_key`)
- On error: `{ error }` with status 500

**POST /api/buckets** — Add a bucket config.
- Auth: same pattern
- Body: `{ bucket_name, endpoint_url, region?, access_key_id, secret_access_key }`
- Validate required fields, return 400 if missing
- Encrypt `secret_access_key` with `encryptSecretVersioned`
- Insert with `user_id: user.id`
- On duplicate (code 23505): return 409 with `"Bucket already configured"`
- Response: `{ data: { id, bucket_name, region, endpoint_url, created_at } }` (no secrets)
- Status 201 on success

### `web/app/api/buckets/[id]/route.ts`

**DELETE /api/buckets/[id]** — Remove a bucket config.
- Auth: same pattern
- Delete from `bucket_configs` where `id = params.id` and `user_id = user.id`
- Response: `{ data: null }` with status 200
- On error: `{ error }` with status 500

### `web/app/api/buckets/[id]/test/route.ts`

**POST /api/buckets/[id]/test** — Test S3 connectivity.
- Auth: same pattern
- Use `getBucketConfig(supabase, user.id, params.id)` from bucket-service
- If not found: 404
- If decryption error: 500
- Call `testBucketConnectivity(s3, config.bucket_name)`
- Response: `{ data: { success, has_objects, message } }`

## Pattern Reference

Follow the exact pattern from `web/app/api/events/route.ts` and `web/app/api/stats/route.ts`:
```typescript
import { authenticateRequest, isAuthenticated } from "@/lib/supabase/api-auth";

export async function GET(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (!isAuthenticated(auth)) return auth;
  // ... use auth.supabase and auth.user
}
```

For dynamic route params, follow `web/app/api/events/[id]/route.ts` pattern:
```typescript
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  // ...
}
```

## Tests to Write

### `web/__tests__/bucket-crud-api.test.ts`

Mock `authenticateRequest` to return a fake auth context. Mock Supabase client methods.

1. `GET /api/buckets` — returns list, no secrets in response
2. `GET /api/buckets` — returns 401 when unauthenticated
3. `POST /api/buckets` — creates bucket, encrypts secret, returns 201
4. `POST /api/buckets` — returns 400 on missing fields
5. `POST /api/buckets` — returns 409 on duplicate bucket name
6. `DELETE /api/buckets/[id]` — deletes bucket, returns 200
7. `DELETE /api/buckets/[id]` — returns 401 when unauthenticated
8. `POST /api/buckets/[id]/test` — returns connectivity result
9. `POST /api/buckets/[id]/test` — returns 404 when bucket not found

Follow test patterns from `web/__tests__/unit/api-auth.test.ts` (mocking approach) and `web/__tests__/health-route.test.ts`.

## Acceptance Criteria

- [ ] All 4 routes exist and respond correctly
- [ ] No secrets (`access_key_id`, `secret_access_key`) leak in GET/POST responses
- [ ] Encryption uses `encryptSecretVersioned`
- [ ] RLS enforced via `user_id` filter (the Supabase client is scoped to the user's JWT)
- [ ] All unit tests pass
- [ ] `npm run typecheck` passes
