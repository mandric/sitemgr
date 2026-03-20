-- Model configurations: per-user enrichment model settings
-- Allows users to configure their own model provider instead of hardcoded Anthropic

CREATE TABLE model_configs (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    provider          text NOT NULL DEFAULT 'anthropic',
    base_url          text,
    model             text NOT NULL,
    api_key_encrypted text,
    is_active         boolean NOT NULL DEFAULT true,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Partial unique index: one active config per user per provider.
-- Inactive configs (is_active = false) are not constrained.
CREATE UNIQUE INDEX model_configs_user_provider_active
    ON model_configs (user_id, provider)
    WHERE is_active = true;

-- Row Level Security
ALTER TABLE model_configs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own model configs"
ON model_configs FOR SELECT
TO authenticated
USING ((SELECT auth.uid()) = user_id);

CREATE POLICY "Users can insert own model configs"
ON model_configs FOR INSERT
TO authenticated
WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE POLICY "Users can update own model configs"
ON model_configs FOR UPDATE
TO authenticated
USING ((SELECT auth.uid()) = user_id);

CREATE POLICY "Users can delete own model configs"
ON model_configs FOR DELETE
TO authenticated
USING ((SELECT auth.uid()) = user_id);
