# Claude Code Web Session — Local Supabase Setup

How to run the full test suite (unit, integration, E2E) inside a Claude Code web session.

## TL;DR

The `SessionStart` hook (`.claude/hooks/session-start.sh`) handles everything automatically:
installs CLIs, starts Supabase, generates `.env.local`, creates the storage bucket.

If you need to do it manually:

```bash
supabase start -x edge-runtime   # edge-runtime has no DNS in this container
cd web && npm test                # unit tests (no Supabase needed)
cd web && npm run test:e2e        # E2E tests (needs Supabase + next dev)
```

## Container Constraints & Workarounds

### 1. Edge Runtime — excluded (`-x edge-runtime`)

The Supabase Edge Runtime container tries to fetch Deno dependencies from
`deno.land` and `jsr.io` at boot. The Claude Code web container has **no
external DNS resolution**, so these fetches fail and the edge-runtime health
check times out (~5 min), blocking `supabase start`.

**Fix:** `supabase start -x edge-runtime`

**Impact:** None. Edge Functions are not used in v1 — the WhatsApp webhook
runs as a Vercel API route (`/api/whatsapp`).

### 2. Realtime — may need IPv4 fix

Some container environments resolve `host.docker.internal` to IPv6 only,
which the Realtime container doesn't handle well. If Realtime fails to start:

```bash
# Option A: exclude it (if your tests don't need realtime subscriptions)
supabase start -x edge-runtime -x realtime

# Option B: patch the generated docker-compose to force IPv4
# After first `supabase start` fails, find the compose file:
COMPOSE=$(find /tmp -name 'docker-compose.yml' -path '*supabase*' 2>/dev/null | head -1)
# Add under the realtime service:
#   extra_hosts:
#     - "host.docker.internal:host-gateway"
# Then retry: supabase start -x edge-runtime
```

### 3. No external network access

The container cannot reach the internet. This means:
- `npm install` works (dependencies are pre-cached or bundled)
- `supabase start` pulls images from a local Docker cache
- Any test that calls an external API (Anthropic, Twilio) must be mocked

## What the SessionStart Hook Does

1. Installs `gh`, `supabase`, `vercel` CLIs (if missing)
2. Installs Playwright + Chromium (if missing)
3. Runs `npm install` in `web/`
4. Starts Supabase with `-x edge-runtime`
5. Generates `web/.env.local` with connection details
6. Creates the `media` storage bucket

## Running Tests

### Unit tests (no Supabase required)

```bash
cd web && npm test
```

All env vars are stubbed via `vi.stubEnv()` in test files — no real secrets needed.

### Integration tests

```bash
# Requires Supabase running
./tests/integration_test.sh
```

Or the FTS smoke test directly:

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
  -c "SELECT * FROM search_events('dog beach')"
```

### E2E tests (Playwright)

```bash
cd web && npm run test:e2e
```

Requires:
- Supabase running (for auth/storage)
- `web/.env.local` with `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
- Playwright + Chromium installed

The Playwright config auto-starts `next dev` on port 3000.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `supabase start` hangs for 5+ min | Edge runtime health check timeout | Use `-x edge-runtime` |
| `dns error: failed to lookup address` in edge-runtime logs | No external DNS in container | Use `-x edge-runtime` |
| Realtime container crash loops | IPv6-only `host.docker.internal` | Use `-x realtime` or add `extra_hosts` |
| `supabase: command not found` | CLI not installed | `npm install -g supabase` |
| E2E tests fail with connection refused | `.env.local` missing or Supabase not running | Run `supabase status` to verify |
