-- Webhook service account: a narrowly-scoped auth user for the WhatsApp webhook.
-- Instead of the service role key (which bypasses ALL security), this account
-- gets specific RLS policies granting cross-user access only to tables the
-- webhook needs.
--
-- NOTE: The webhook auth user is NOT created here. Raw INSERTs into auth.users
-- break across GoTrue versions (missing columns, changed triggers, etc.).
-- Instead, the user is created via GoTrue's admin API:
--   - Local dev / CI: scripts/create-webhook-user.sh (runs after supabase start)
--   - Production: deployment step in CI workflow
--
-- The RLS policies below reference a well-known UUID and work regardless of
-- whether the user exists yet.

-- 1. RLS policies granting the webhook service account cross-user access
-- Postgres RLS uses OR logic across policies, so these are additive to existing user-scoped policies.

CREATE POLICY "Webhook service account can access all events"
ON events FOR ALL
TO authenticated
USING (
  (SELECT auth.uid()) = '00000000-0000-0000-0000-000000000001'::uuid
)
WITH CHECK (
  (SELECT auth.uid()) = '00000000-0000-0000-0000-000000000001'::uuid
);

CREATE POLICY "Webhook service account can access all enrichments"
ON enrichments FOR ALL
TO authenticated
USING (
  (SELECT auth.uid()) = '00000000-0000-0000-0000-000000000001'::uuid
)
WITH CHECK (
  (SELECT auth.uid()) = '00000000-0000-0000-0000-000000000001'::uuid
);

CREATE POLICY "Webhook service account can access all watched_keys"
ON watched_keys FOR ALL
TO authenticated
USING (
  (SELECT auth.uid()) = '00000000-0000-0000-0000-000000000001'::uuid
)
WITH CHECK (
  (SELECT auth.uid()) = '00000000-0000-0000-0000-000000000001'::uuid
);

CREATE POLICY "Webhook service account can access all conversations"
ON conversations FOR ALL
TO authenticated
USING (
  (SELECT auth.uid()) = '00000000-0000-0000-0000-000000000001'::uuid
)
WITH CHECK (
  (SELECT auth.uid()) = '00000000-0000-0000-0000-000000000001'::uuid
);

CREATE POLICY "Webhook service account can access all bucket_configs"
ON bucket_configs FOR ALL
TO authenticated
USING (
  (SELECT auth.uid()) = '00000000-0000-0000-0000-000000000001'::uuid
)
WITH CHECK (
  (SELECT auth.uid()) = '00000000-0000-0000-0000-000000000001'::uuid
);

CREATE POLICY "Webhook service account can access all model_configs"
ON model_configs FOR ALL
TO authenticated
USING (
  (SELECT auth.uid()) = '00000000-0000-0000-0000-000000000001'::uuid
)
WITH CHECK (
  (SELECT auth.uid()) = '00000000-0000-0000-0000-000000000001'::uuid
);

-- 3. Grant get_user_id_from_phone to authenticated role
-- Previously restricted to service_role only. The webhook service account
-- has role 'authenticated' and needs to resolve phone -> user_id.
GRANT EXECUTE ON FUNCTION get_user_id_from_phone(TEXT) TO authenticated;
