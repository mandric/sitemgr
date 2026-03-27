-- Device code authorization flow table.
-- Tracks pending/approved/expired device authorization requests
-- for the CLI device code auth flow (RFC 8628-inspired).
--
-- RLS: anon can INSERT only. All reads go through get_device_code_status() RPC.
-- Service role bypasses RLS for updates (approve endpoint).

CREATE TABLE device_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_code text NOT NULL UNIQUE,
  user_code text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'expired', 'denied', 'consumed')),
  user_id uuid REFERENCES auth.users(id),
  device_name text,
  email text,
  token_hash text,
  client_ip inet,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  last_polled_at timestamptz
);

-- Partial unique index: only one pending row per user_code at a time
CREATE UNIQUE INDEX idx_device_codes_user_code_pending
  ON device_codes (user_code) WHERE status = 'pending';

-- Cleanup queries use expires_at
CREATE INDEX idx_device_codes_expires_at
  ON device_codes (expires_at);

ALTER TABLE device_codes ENABLE ROW LEVEL SECURITY;

-- Anon can insert (CLI initiates the flow before authentication)
-- Constrain to prevent anon from setting privileged fields directly.
CREATE POLICY "Anon can initiate device code flow"
  ON device_codes FOR INSERT
  TO anon
  WITH CHECK (
    status = 'pending'
    AND user_id IS NULL
    AND token_hash IS NULL
    AND approved_at IS NULL
    AND email IS NULL
  );

-- No SELECT policy for anon. Reads go through the RPC function.
-- Service role bypasses RLS for all operations (approve endpoint updates rows).

CREATE OR REPLACE FUNCTION get_device_code_status(p_device_code text)
RETURNS TABLE (
  status text,
  token_hash text,
  email text,
  expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    dc.status,
    dc.token_hash,
    dc.email,
    dc.expires_at
  FROM device_codes dc
  WHERE dc.device_code = p_device_code;
END;
$$;

-- Allow anon and authenticated to call the RPC function
GRANT EXECUTE ON FUNCTION get_device_code_status(text) TO anon;
GRANT EXECUTE ON FUNCTION get_device_code_status(text) TO authenticated;
