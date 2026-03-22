-- Restrict get_user_id_from_phone to service_role and webhook service account.
--
-- Migration 20260321000000 granted EXECUTE to the entire 'authenticated' role,
-- which is too broad — any authenticated user could resolve phone → user_id.
-- This replaces the function body with an internal caller check:
--   - service_role: allowed (admin/test usage)
--   - webhook@sitemgr.internal: allowed (webhook handler)
--   - all others: permission denied

CREATE OR REPLACE FUNCTION get_user_id_from_phone(p_phone_number TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_user_id UUID;
    v_caller_email TEXT;
BEGIN
    -- Allow service_role unconditionally
    IF current_setting('role', TRUE) = 'service_role' THEN
        NULL;
    ELSE
        -- Check if caller is the webhook service account
        SELECT email INTO v_caller_email
        FROM auth.users WHERE id = auth.uid();

        IF v_caller_email IS DISTINCT FROM 'webhook@sitemgr.internal' THEN
            RAISE EXCEPTION 'permission denied for function get_user_id_from_phone';
        END IF;
    END IF;

    SELECT id INTO v_user_id
    FROM user_profiles
    WHERE phone_number = p_phone_number;

    RETURN v_user_id;
END;
$$;
