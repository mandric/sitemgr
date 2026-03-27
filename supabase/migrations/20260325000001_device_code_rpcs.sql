-- Additional RPC functions for device code flow.
-- consume_device_code: atomically marks a code as consumed and nulls token_hash.
-- expire_device_code: marks a pending code as expired.
-- update_device_code_polled_at: updates last_polled_at timestamp.

CREATE OR REPLACE FUNCTION consume_device_code(p_device_code text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE device_codes
  SET status = 'consumed', token_hash = NULL
  WHERE device_code = p_device_code
    AND status = 'approved';
END;
$$;

CREATE OR REPLACE FUNCTION expire_device_code(p_device_code text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE device_codes
  SET status = 'expired'
  WHERE device_code = p_device_code
    AND status = 'pending';
END;
$$;

CREATE OR REPLACE FUNCTION update_device_code_polled_at(p_device_code text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE device_codes
  SET last_polled_at = now()
  WHERE device_code = p_device_code;
END;
$$;

GRANT EXECUTE ON FUNCTION consume_device_code(text) TO anon;
GRANT EXECUTE ON FUNCTION consume_device_code(text) TO authenticated;
GRANT EXECUTE ON FUNCTION expire_device_code(text) TO anon;
GRANT EXECUTE ON FUNCTION expire_device_code(text) TO authenticated;
GRANT EXECUTE ON FUNCTION update_device_code_polled_at(text) TO anon;
GRANT EXECUTE ON FUNCTION update_device_code_polled_at(text) TO authenticated;
