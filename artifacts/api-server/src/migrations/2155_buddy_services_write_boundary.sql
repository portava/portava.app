-- 2155_buddy_services_write_boundary.sql
--
-- ⚠ STAGED. Apply to portava-ci ONLY. DO NOT APPLY TO PRODUCTION without the
--   owner's explicit approval — live authorization change.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- ── WHAT IS WRONG, PROVEN BY EXECUTION (portava-ci, self-rolling-back) ───────
-- buddy_services.approved — a buddy self-approves their own service listing (bypasses admin review).
-- As the owning `authenticated` user, a direct PostgREST write can self-set the
-- platform authority column(s) [approved,approved_at] on the owner's own row — proven ALLOWED
-- (1 row) and adversarially re-verified. Same class as 2144-2154: anon+authenticated
-- hold TABLE-LEVEL INSERT/UPDATE on every column; the owner RLS policy scopes the
-- ROW, not the COLUMNS.
--
-- ── FIX ─────────────────────────────────────────────────────────────────────
-- Every server write uses the service-role client. REVOKE ALL from anon+authenticated,
-- GRANT SELECT back (owner/public read), and re-GRANT column-level INSERT/UPDATE on
-- the CONTENT columns only; [approved,approved_at] stay server-owned. Owner-scoping RLS unchanged.
-- SAFE TO RE-RUN.

BEGIN;

DO $$ BEGIN
  IF to_regclass('public.buddy_services') IS NULL THEN RAISE EXCEPTION 'PRECONDITION FAILED: public.buddy_services missing'; END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.buddy_services'::regclass) THEN RAISE EXCEPTION 'PRECONDITION FAILED: RLS off'; END IF;
END $$;

REVOKE ALL ON TABLE public.buddy_services FROM anon;
REVOKE ALL ON TABLE public.buddy_services FROM authenticated;
GRANT SELECT ON TABLE public.buddy_services TO anon;
GRANT SELECT ON TABLE public.buddy_services TO authenticated;
GRANT INSERT (buddy_id, category, title, description, hourly_rate_usd, half_day_usd, full_day_usd, min_hours, max_hours, max_group_size, is_active) ON TABLE public.buddy_services TO authenticated;
GRANT UPDATE (category, title, description, hourly_rate_usd, half_day_usd, full_day_usd, min_hours, max_hours, max_group_size, is_active) ON TABLE public.buddy_services TO authenticated;

DO $$
DECLARE anon_p text; auth_p text; bad text;
BEGIN
  SELECT COALESCE(string_agg(DISTINCT privilege_type,',' ORDER BY privilege_type),'(none)') INTO anon_p
    FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name='buddy_services' AND grantee='anon';
  IF anon_p <> 'SELECT' THEN RAISE EXCEPTION 'POSTCONDITION FAILED: anon=%',anon_p; END IF;
  SELECT COALESCE(string_agg(DISTINCT privilege_type,',' ORDER BY privilege_type),'(none)') INTO auth_p
    FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name='buddy_services' AND grantee='authenticated';
  IF auth_p <> 'SELECT' THEN RAISE EXCEPTION 'POSTCONDITION FAILED: authenticated table-level=%',auth_p; END IF;
  SELECT string_agg(DISTINCT grantee||'/'||privilege_type||'/'||column_name,', ') INTO bad
    FROM information_schema.column_privileges WHERE table_schema='public' AND table_name='buddy_services'
      AND grantee IN ('anon','authenticated') AND privilege_type IN ('INSERT','UPDATE')
      AND column_name IN ('approved', 'approved_at');
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'POSTCONDITION FAILED: protected column client-writable: %',bad; END IF;
END $$;

COMMIT;
