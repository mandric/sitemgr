-- Webhook service account: a narrowly-scoped auth user for the WhatsApp webhook.
-- Instead of the service role key (which bypasses ALL security), this account
-- gets specific RLS policies granting cross-user access only to tables the
-- webhook needs.

-- 1. Create the webhook service account user
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM auth.users WHERE email = 'webhook@sitemgr.internal'
  ) THEN
    INSERT INTO auth.users (
      id, email, encrypted_password, email_confirmed_at,
      role, aud, instance_id
    ) VALUES (
      '00000000-0000-0000-0000-000000000001',
      'webhook@sitemgr.internal',
      crypt('unused-password-webhook-uses-service-token', gen_salt('bf')),
      now(),
      'authenticated',
      'authenticated',
      '00000000-0000-0000-0000-000000000000'
    );
  END IF;
END $$;

-- Identity record so signInWithPassword works
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM auth.identities WHERE user_id = '00000000-0000-0000-0000-000000000001'
  ) THEN
    INSERT INTO auth.identities (
      id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at
    ) VALUES (
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000001',
      jsonb_build_object('sub', '00000000-0000-0000-0000-000000000001', 'email', 'webhook@sitemgr.internal'),
      'email',
      '00000000-0000-0000-0000-000000000001',
      now(), now(), now()
    );
  END IF;
END $$;

-- 2. RLS policies granting the webhook service account cross-user access
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
