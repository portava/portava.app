-- 2159_geo_zones_write_boundary.sql
--
-- ⚠ STAGED. Apply to portava-ci ONLY. DO NOT APPLY TO PRODUCTION without owner approval.
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- ── WHAT IS WRONG, PROVEN BY EXECUTION (portava-ci, self-rolling-back) ───────
-- geo_zones.verified / featured — an authenticated user can self-verify and
-- self-feature a geo zone via a direct PostgREST write (proven ALLOWED, verified).
-- geo_zones_public_read exposes zones, so verified/featured confer trust/placement.
-- TWO further RLS defects compound it:
--   * geo_zones_auth_insert has WITH CHECK (auth.uid() IS NOT NULL) only — no
--     created_by binding, so a client can INSERT a zone attributed to anyone
--     (submitter impersonation, exactly like discovery_places 2153);
--   * geo_zones_owner_update USING ((auth.uid()=created_by) OR is_system) — the
--     "OR is_system" lets ANY authenticated user update system zones.
--
-- ── FIX ─────────────────────────────────────────────────────────────────────
-- Every legitimate write is service-role (geo_zones_service_all, and the app
-- writers use getServiceClient). No user-facing direct zone-write feature depends
-- on the client grant. SELECT-only, matching 2148/2153: REVOKE ALL from
-- anon+authenticated, GRANT SELECT back (geo_zones_public_read / gz_select_all).
-- This closes the verified/featured forge, the created_by impersonation and the
-- is_system update-by-anyone in one move (the RLS write policies become
-- unreachable by clients). RLS/enum unchanged. SAFE TO RE-RUN.

BEGIN;
DO $$ BEGIN
  IF to_regclass('public.geo_zones') IS NULL THEN RAISE EXCEPTION 'PRECONDITION FAILED: missing'; END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.geo_zones'::regclass) THEN RAISE EXCEPTION 'PRECONDITION FAILED: RLS off'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='geo_zones' AND cmd='SELECT') THEN RAISE EXCEPTION 'PRECONDITION FAILED: no SELECT policy'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='geo_zones' AND cmd='ALL' AND 'service_role'=ANY(roles)) THEN RAISE EXCEPTION 'PRECONDITION FAILED: service_role ALL policy absent'; END IF;
END $$;
REVOKE ALL ON TABLE public.geo_zones FROM anon;
REVOKE ALL ON TABLE public.geo_zones FROM authenticated;
GRANT SELECT ON TABLE public.geo_zones TO anon;
GRANT SELECT ON TABLE public.geo_zones TO authenticated;
DO $$
DECLARE anon_p text; auth_p text; w int;
BEGIN
  SELECT COALESCE(string_agg(DISTINCT privilege_type,',' ORDER BY privilege_type),'(none)') INTO anon_p FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name='geo_zones' AND grantee='anon';
  IF anon_p <> 'SELECT' THEN RAISE EXCEPTION 'POSTCONDITION FAILED: anon=%',anon_p; END IF;
  SELECT COALESCE(string_agg(DISTINCT privilege_type,',' ORDER BY privilege_type),'(none)') INTO auth_p FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name='geo_zones' AND grantee='authenticated';
  IF auth_p <> 'SELECT' THEN RAISE EXCEPTION 'POSTCONDITION FAILED: authenticated=%',auth_p; END IF;
  SELECT count(*) INTO w FROM information_schema.column_privileges WHERE table_schema='public' AND table_name='geo_zones' AND grantee IN ('anon','authenticated') AND privilege_type IN ('INSERT','UPDATE');
  IF w <> 0 THEN RAISE EXCEPTION 'POSTCONDITION FAILED: % client write grants remain', w; END IF;
END $$;
COMMIT;
