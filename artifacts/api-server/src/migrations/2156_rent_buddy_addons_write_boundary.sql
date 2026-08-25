-- 2156_rent_buddy_addons_write_boundary.sql
--
-- ⚠ STAGED. Apply to portava-ci ONLY. DO NOT APPLY TO PRODUCTION without the
--   owner's explicit approval — live authorization change.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- ── WHAT IS WRONG, PROVEN BY EXECUTION (portava-ci, self-rolling-back) ───────
-- rent_buddy_addons.admin_approved — a buddy self-approves their own paid add-on.
-- As the owning `authenticated` user, a direct PostgREST write can self-set the
-- platform authority column(s) [admin_approved,requires_admin_approval] on the owner's own row — proven ALLOWED
-- (1 row) and adversarially re-verified. Same class as 2144-2154: anon+authenticated
-- hold TABLE-LEVEL INSERT/UPDATE on every column; the owner RLS policy scopes the
-- ROW, not the COLUMNS.
--
-- ── FIX ─────────────────────────────────────────────────────────────────────
-- Every server write uses the service-role client. REVOKE ALL from anon+authenticated,
-- GRANT SELECT back (owner/public read), and re-GRANT column-level INSERT/UPDATE on
-- the CONTENT columns only; [admin_approved,requires_admin_approval] stay server-owned. Owner-scoping RLS unchanged.
-- SAFE TO RE-RUN.

BEGIN;

DO $$ BEGIN
  IF to_regclass('public.rent_buddy_addons') IS NULL THEN RAISE EXCEPTION 'PRECONDITION FAILED: public.rent_buddy_addons missing'; END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.rent_buddy_addons'::regclass) THEN RAISE EXCEPTION 'PRECONDITION FAILED: RLS off'; END IF;
END $$;

REVOKE ALL ON TABLE public.rent_buddy_addons FROM anon;
REVOKE ALL ON TABLE public.rent_buddy_addons FROM authenticated;
GRANT SELECT ON TABLE public.rent_buddy_addons TO anon;
GRANT SELECT ON TABLE public.rent_buddy_addons TO authenticated;
GRANT INSERT (buddy_id, title, description, price_usd, is_active, category) ON TABLE public.rent_buddy_addons TO authenticated;
GRANT UPDATE (title, description, price_usd, is_active, category) ON TABLE public.rent_buddy_addons TO authenticated;

DO $$
DECLARE anon_p text; auth_p text; bad text;
BEGIN
  SELECT COALESCE(string_agg(DISTINCT privilege_type,',' ORDER BY privilege_type),'(none)') INTO anon_p
    FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name='rent_buddy_addons' AND grantee='anon';
  IF anon_p <> 'SELECT' THEN RAISE EXCEPTION 'POSTCONDITION FAILED: anon=%',anon_p; END IF;
  SELECT COALESCE(string_agg(DISTINCT privilege_type,',' ORDER BY privilege_type),'(none)') INTO auth_p
    FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name='rent_buddy_addons' AND grantee='authenticated';
  IF auth_p <> 'SELECT' THEN RAISE EXCEPTION 'POSTCONDITION FAILED: authenticated table-level=%',auth_p; END IF;
  SELECT string_agg(DISTINCT grantee||'/'||privilege_type||'/'||column_name,', ') INTO bad
    FROM information_schema.column_privileges WHERE table_schema='public' AND table_name='rent_buddy_addons'
      AND grantee IN ('anon','authenticated') AND privilege_type IN ('INSERT','UPDATE')
      AND column_name IN ('admin_approved', 'requires_admin_approval');
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'POSTCONDITION FAILED: protected column client-writable: %',bad; END IF;
END $$;

COMMIT;
