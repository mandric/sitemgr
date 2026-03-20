-- Schema info RPC function for integration test schema verification.
-- Returns public schema metadata (tables, columns, indexes, functions, policies).
-- Restricted to service_role only.

CREATE OR REPLACE FUNCTION public.schema_info()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result jsonb;
BEGIN
  SELECT jsonb_build_object(
    'tables', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'table_name', c.relname::text,
        'has_rls', c.relrowsecurity
      ) ORDER BY c.relname), '[]'::jsonb)
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
    ),
    'columns', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'table_name', table_name,
        'column_name', column_name,
        'is_nullable', (is_nullable = 'YES'),
        'data_type', data_type
      ) ORDER BY table_name, ordinal_position), '[]'::jsonb)
      FROM information_schema.columns
      WHERE table_schema = 'public'
    ),
    'indexes', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'index_name', indexname,
        'table_name', tablename
      ) ORDER BY indexname), '[]'::jsonb)
      FROM pg_indexes
      WHERE schemaname = 'public'
    ),
    'functions', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'function_name', routine_name,
        'argument_types', coalesce(
          (SELECT string_agg(p.data_type, ', ' ORDER BY p.ordinal_position)
           FROM information_schema.parameters p
           WHERE p.specific_schema = r.specific_schema
             AND p.specific_name = r.specific_name
             AND p.parameter_mode = 'IN'),
          ''
        ),
        'return_type', data_type
      ) ORDER BY routine_name), '[]'::jsonb)
      FROM information_schema.routines r
      WHERE routine_schema = 'public'
        AND routine_type = 'FUNCTION'
    ),
    'policies', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'table_name', tablename,
        'policy_name', policyname,
        'command', cmd,
        'roles', roles
      ) ORDER BY tablename, policyname), '[]'::jsonb)
      FROM pg_policies
      WHERE schemaname = 'public'
    )
  ) INTO result;

  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION schema_info() FROM PUBLIC;
REVOKE ALL ON FUNCTION schema_info() FROM authenticated;
REVOKE ALL ON FUNCTION schema_info() FROM anon;
GRANT EXECUTE ON FUNCTION schema_info() TO service_role;
