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

-- ── The second thing the textual guard cannot see: functions ──────────────────
-- A policy that calls a public boolean function whose body reads trip_members
-- reaches the membership table without naming it. The guard carries a captured
-- list of such functions (UNGATED_TRIP_MEMBERS_FUNCTIONS in
-- src/scripts/rlsDispositions.ts); this RPC lets the live suite verify that
-- list against pg_proc on every run, so it cannot rot when a function is
-- repaired (2534 gates can_see_trip) or dropped (2533 drops shares_trip_with).
-- Boolean-returning functions only: trigger and maintenance functions also
-- read trip_members and are not predicates. Same posture: service_role only.
CREATE OR REPLACE FUNCTION public.pg_trip_members_readers_snapshot()
RETURNS TABLE (
  schema_name     text,
  function_name   text,
  mentions_role   boolean,
  mentions_status boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $fn$
  SELECT ns.nspname::text,
         p.proname::text,
         p.prosrc ~ '\mrole\M',
         p.prosrc ~ '\mstatus\M'
    FROM pg_proc p
    JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname IN ('public', 'authz')
     AND p.prorettype = 'boolean'::regtype
     AND p.prosrc ~ '\mtrip_members\M';
$fn$;

REVOKE ALL ON FUNCTION public.pg_trip_members_readers_snapshot() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pg_trip_members_readers_snapshot() TO service_role;

COMMENT ON FUNCTION public.pg_trip_members_readers_snapshot() IS
  'Diagnostic: every boolean function in public/authz whose body reads trip_members, and whether it mentions role and status. Lets rlsPolicyShapeLive.test.ts verify the captured UNGATED_TRIP_MEMBERS_FUNCTIONS list against the live catalog instead of trusting it. service_role only. See migration 2532.';

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

  IF to_regprocedure('public.pg_trip_members_readers_snapshot()') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: pg_trip_members_readers_snapshot missing';
  END IF;
  IF has_function_privilege('anon', 'public.pg_trip_members_readers_snapshot()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.pg_trip_members_readers_snapshot()', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: pg_trip_members_readers_snapshot is reachable by anon/authenticated';
  END IF;
  -- authz.is_trip_crew (2334) reads trip_members and mentions both words; it
  -- must be visible here or the snapshot is not reading function bodies.
  IF NOT EXISTS (
    SELECT 1 FROM public.pg_trip_members_readers_snapshot()
     WHERE schema_name = 'authz' AND function_name = 'is_trip_crew' AND mentions_role AND mentions_status
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: pg_trip_members_readers_snapshot does not see authz.is_trip_crew';
  END IF;
END $$;

COMMIT;
