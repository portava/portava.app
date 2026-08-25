-- 2157_rent_buddy_packages_write_boundary.sql
--
-- ⚠ STAGED. Apply to portava-ci ONLY. DO NOT APPLY TO PRODUCTION without the
--   owner's explicit approval — live authorization change.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- ── WHAT IS WRONG, PROVEN BY EXECUTION (portava-ci, self-rolling-back) ───────
-- rent_buddy_packages.admin_review_status — a buddy self-sets the admin review verdict on their package.
-- As the owning `authenticated` user, a direct PostgREST write can self-set the
-- platform authority column(s) [admin_review_status,admin_reviewed_by,admin_reviewed_at] on the owner's own row — proven ALLOWED
-- (1 row) and adversarially re-verified. Same class as 2144-2154: anon+authenticated
-- hold TABLE-LEVEL INSERT/UPDATE on every column; the owner RLS policy scopes the
-- ROW, not the COLUMNS.
--
-- ── FIX ─────────────────────────────────────────────────────────────────────
-- Every server write uses the service-role client. REVOKE ALL from anon+authenticated,
-- GRANT SELECT back (owner/public read), and re-GRANT column-level INSERT/UPDATE on
-- the CONTENT columns only; [admin_review_status,admin_reviewed_by,admin_reviewed_at] stay server-owned. Owner-scoping RLS unchanged.
-- SAFE TO RE-RUN.

BEGIN;

DO $$ BEGIN
  IF to_regclass('public.rent_buddy_packages') IS NULL THEN RAISE EXCEPTION 'PRECONDITION FAILED: public.rent_buddy_packages missing'; END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.rent_buddy_packages'::regclass) THEN RAISE EXCEPTION 'PRECONDITION FAILED: RLS off'; END IF;
END $$;

REVOKE ALL ON TABLE public.rent_buddy_packages FROM anon;
REVOKE ALL ON TABLE public.rent_buddy_packages FROM authenticated;
GRANT SELECT ON TABLE public.rent_buddy_packages TO anon;
GRANT SELECT ON TABLE public.rent_buddy_packages TO authenticated;
GRANT INSERT (buddy_id, title, description, category, duration_h, price_usd, max_group, is_active, city, base_price, deposit_required, deposit_percent, payment_modes_allowed, included_stops, included_services, addon_ids, stops, meetup_rules) ON TABLE public.rent_buddy_packages TO authenticated;
GRANT UPDATE (title, description, category, duration_h, price_usd, max_group, is_active, city, base_price, deposit_required, deposit_percent, payment_modes_allowed, included_stops, included_services, addon_ids, stops, meetup_rules) ON TABLE public.rent_buddy_packages TO authenticated;

DO $$
DECLARE anon_p text; auth_p text; bad text;
BEGIN
  SELECT COALESCE(string_agg(DISTINCT privilege_type,',' ORDER BY privilege_type),'(none)') INTO anon_p
    FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name='rent_buddy_packages' AND grantee='anon';
  IF anon_p <> 'SELECT' THEN RAISE EXCEPTION 'POSTCONDITION FAILED: anon=%',anon_p; END IF;
  SELECT COALESCE(string_agg(DISTINCT privilege_type,',' ORDER BY privilege_type),'(none)') INTO auth_p
    FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name='rent_buddy_packages' AND grantee='authenticated';
  IF auth_p <> 'SELECT' THEN RAISE EXCEPTION 'POSTCONDITION FAILED: authenticated table-level=%',auth_p; END IF;
  SELECT string_agg(DISTINCT grantee||'/'||privilege_type||'/'||column_name,', ') INTO bad
    FROM information_schema.column_privileges WHERE table_schema='public' AND table_name='rent_buddy_packages'
      AND grantee IN ('anon','authenticated') AND privilege_type IN ('INSERT','UPDATE')
      AND column_name IN ('admin_review_status', 'admin_reviewed_by', 'admin_reviewed_at');
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'POSTCONDITION FAILED: protected column client-writable: %',bad; END IF;
END $$;

COMMIT;
