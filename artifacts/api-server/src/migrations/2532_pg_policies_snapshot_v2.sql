-- 2532_pg_policies_snapshot_v2.sql
--
-- A second diagnostic snapshot of public-schema RLS policies that keeps USING
-- and WITH CHECK apart. The first one (2199's pg_policies_snapshot) fuses them
-- into one string, so no consumer of it can tell a FOR ALL policy that wrote
-- WITH CHECK from one that did not -- and that distinction is the whole
-- question for the "FOR ALL without WITH CHECK reuses USING as the write
-- check" class the live shape guard now enforces.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2532 (B5).
--
-- Function-only, additive: creates one function. Touches no table, column,
-- policy or row. Idempotent (CREATE OR REPLACE). pg_policies_snapshot (v1) is
-- left exactly as 2199 made it; rlsPolicyShapeLive.test.ts's older rules still
-- read it.
--
-- SECURITY. Same posture as 2199, asserted below rather than assumed:
-- SECURITY DEFINER so it can read pg_policies for every table; service_role
-- ONLY -- policy expressions describe the authorization logic itself and are
-- not for anon or authenticated to enumerate; search_path pinned. pg_policies is
-- a catalog view, not reachable through PostgREST, which is why an RPC exists
-- at all.
--
-- CONSUMER: src/test/rlsPolicyShapeLive.test.ts (via test:rls-policy-shape,
-- CI-database only). Until this is applied to portava-ci, that suite's FOR ALL
-- rule FAILS -- by design, not by accident: a rule that cannot see the column
-- it judges must not report green.

BEGIN;

CREATE OR REPLACE FUNCTION public.pg_policies_snapshot_v2()
RETURNS TABLE (
  tablename  text,
  policyname text,
  cmd        text,
  roles      text,
  permissive text,
  qual       text,
  with_check text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $fn$
  SELECT p.tablename::text,
         p.policyname::text,
         p.cmd::text,
         p.roles::text,
         p.permissive::text,
         p.qual::text,
         p.with_check::text
    FROM pg_policies p
   WHERE p.schemaname = 'public';
$fn$;

REVOKE ALL ON FUNCTION public.pg_policies_snapshot_v2() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pg_policies_snapshot_v2() TO service_role;

COMMENT ON FUNCTION public.pg_policies_snapshot_v2() IS
  'Diagnostic: public-schema RLS policy shapes with USING (qual) and WITH CHECK kept separate, plus cmd, roles and permissiveness, for the policy-shape regression guard (rlsPolicyShapeLive.test.ts). Supersedes pg_policies_snapshot for rules that must tell a FOR ALL policy with WITH CHECK from one without. service_role only -- policy expressions describe the authorization logic itself. See migration 2532.';

DO $$
BEGIN
  IF to_regprocedure('public.pg_policies_snapshot_v2()') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: pg_policies_snapshot_v2 missing';
  END IF;
  IF has_function_privilege('anon', 'public.pg_policies_snapshot_v2()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.pg_policies_snapshot_v2()', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: pg_policies_snapshot_v2 is reachable by anon/authenticated';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.pg_policies_snapshot_v2()', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: service_role cannot execute pg_policies_snapshot_v2';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'pg_policies_snapshot_v2'
       AND p.prosecdef
       AND array_to_string(p.proconfig, ',') LIKE '%search_path%'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: pg_policies_snapshot_v2 is not SECURITY DEFINER with a pinned search_path';
  END IF;
  -- It must see what pg_policies sees, and it must examine something.
  IF (SELECT count(*) FROM public.pg_policies_snapshot_v2())
     <> (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: pg_policies_snapshot_v2 row count differs from pg_policies';
  END IF;
  IF (SELECT count(*) FROM public.pg_policies_snapshot_v2()) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: pg_policies_snapshot_v2 returned zero policies on a database that must have some';
  END IF;
  -- The two columns the function exists to separate must actually be separate.
  IF NOT EXISTS (SELECT 1 FROM public.pg_policies_snapshot_v2() WHERE qual IS NOT NULL AND with_check IS NULL)
     OR NOT EXISTS (SELECT 1 FROM public.pg_policies_snapshot_v2() WHERE with_check IS NOT NULL) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: pg_policies_snapshot_v2 does not distinguish qual from with_check';
  END IF;
END $$;

COMMIT;
