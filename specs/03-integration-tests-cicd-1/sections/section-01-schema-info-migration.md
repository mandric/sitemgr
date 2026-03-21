# Section 01: Schema Info Migration

## Overview

Create a Supabase migration that adds a `schema_info()` RPC function. This function exposes database metadata (tables, columns, indexes, RLS status, policies, functions) through PostgREST, enabling the schema-contract test suite to verify schema correctness through the same HTTP API the application uses.

## Context

The sitemgr project uses Supabase Postgres with 12 existing migrations. The schema has evolved through a multi-phase migration removing `phone_number` from `bucket_configs` and making `user_id` NOT NULL. Tests need to verify schema correctness but should use the HTTP API (PostgREST) consistently — not direct SQL connections.

## What to Build

### Migration File

Create `supabase/migrations/20260316000000_test_schema_info.sql` (timestamp after last migration `20260315000002`).

The migration creates a single function `schema_info()` that returns a JSON object with 5 sections:

```typescript
interface SchemaInfo {
  tables: Array<{ table_name: string; has_rls: boolean }>;
  columns: Array<{ table_name: string; column_name: string; is_nullable: boolean; data_type: string }>;
  indexes: Array<{ index_name: string; table_name: string }>;
  functions: Array<{ function_name: string; argument_types: string; return_type: string }>;
  policies: Array<{ table_name: string; policy_name: string; command: string; roles: string[] }>;
}
```

### Data Sources

The function queries these system catalogs:

- **Tables + RLS:** `pg_class` joined with `pg_namespace` — filter to `public` schema, `relkind = 'r'` (ordinary tables). RLS status from `relrowsecurity` flag.
- **Columns:** `information_schema.columns` — filter to `table_schema = 'public'`. Extract `column_name`, `is_nullable`, `data_type`.
- **Indexes:** `pg_indexes` — filter to `schemaname = 'public'`.
- **Functions:** `information_schema.routines` — filter to `routine_schema = 'public'`, `routine_type = 'FUNCTION'`.
- **Policies:** `pg_policies` — filter to `schemaname = 'public'`. Extract `tablename`, `policyname`, `cmd`, `roles`.

### Access Control

```sql
REVOKE ALL ON FUNCTION schema_info() FROM PUBLIC;
REVOKE ALL ON FUNCTION schema_info() FROM authenticated;
REVOKE ALL ON FUNCTION schema_info() FROM anon;
GRANT EXECUTE ON FUNCTION schema_info() TO service_role;
```

**Security note:** This function ships to production. It returns read-only public schema metadata (not data), and is restricted to `service_role` which is never exposed to end users. PostgREST does not expose service-role-only functions through the anonymous or authenticated API.

### Function Signature

```sql
CREATE OR REPLACE FUNCTION public.schema_info()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$ ... $$;
```

Use `SECURITY DEFINER` so the function can access system catalogs regardless of the calling role. The `SET search_path = public` prevents search path manipulation.

## Tests to Write First

No formal test files — this is a migration. Verification happens in section-04 (schema-contract tests). After creating the migration:

- Verify: `supabase start` applies migration without errors
- Verify: `admin.rpc('schema_info')` returns JSON with expected shape (tables, columns, indexes, functions, policies arrays)
- Verify: Authenticated user calling `schema_info()` gets permission denied
- Verify: Anonymous user calling `schema_info()` gets permission denied

## Files to Create/Modify

| File | Action |
|------|--------|
| `supabase/migrations/20260316000000_test_schema_info.sql` | CREATE |

## Acceptance Criteria

1. Migration applies cleanly on `supabase start`
2. `schema_info()` returns JSON with all 5 sections populated
3. Tables section includes all 6 application tables with correct RLS flags
4. Columns section includes all columns with correct types and nullability
5. Only callable by service_role — authenticated and anon get permission denied
