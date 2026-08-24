-- 2146_rent_buddy_applications_write_boundary.sql
--
-- ⚠ STAGED. Apply to portava-ci ONLY. DO NOT APPLY TO PRODUCTION without the
--   owner's explicit approval — live authorization change.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- ── WHAT IS WRONG, PROVEN BY EXECUTION (portava-ci, self-rolling-back) ───────
-- As `authenticated` with a JWT whose sub owns the row:
--   UPDATE rent_buddy_applications SET admin_status='active', status='approved'
--    WHERE user_id = auth.uid();   => 1 row affected. SELF-APPROVAL.
--
-- A user can approve their OWN buddy application, bypassing the admin review
-- (PATCH /admin/applications/:appId, which is the only legitimate writer of
-- status/admin_status). This feeds directly into buddy activation.
--
-- ROOT CAUSE (same class as 2144/2145): anon+authenticated held the full grant
-- set incl. UPDATE on every column; the owner RLS policy (rb_apps_own, FOR ALL,
-- USING auth.uid()=user_id) constrains the ROW but not the COLUMNS.
--
-- ── LEGITIMATE CLIENT-EDITABLE SET: EMPTY ──────────────────────────────────
-- Every write path was traced. The application is CREATED by POST /rent-a-buddy/
-- apply and reviewed by the admin routes — ALL via the service-role client.
-- There is NO user route that updates an existing application, and the
-- standalone client never references the table. So no column is legitimately
-- client-writable: clients get SELECT only. The owner reads their own
-- application through rb_apps_own; the table is private (no public-read policy),
-- so anon gets nothing.
--
-- ── WHAT THIS DOES NOT CHANGE ───────────────────────────────────────────────
-- No application code path (all writes are service-role). No column/table/enum
-- change — generated types untouched. No policy change.
--
-- SAFE TO RE-RUN.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.rent_buddy_applications') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.rent_buddy_applications does not exist.';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.rent_buddy_applications'::regclass) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: RLS is not enabled on rent_buddy_applications.';
  END IF;
  -- The table must remain private: no permissive public-read policy.
  IF EXISTS (
    SELECT 1 FROM pg_policy p WHERE p.polrelid='public.rent_buddy_applications'::regclass
      AND p.polcmd IN ('r','*') AND pg_get_expr(p.polqual,p.polrelid) = 'true'
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: a public-read policy exists; anon SELECT would be needed and this migration assumes it is not.';
  END IF;
END $$;

-- Clients read only; every write is service-role.
REVOKE ALL ON TABLE public.rent_buddy_applications FROM anon;
REVOKE ALL ON TABLE public.rent_buddy_applications FROM authenticated;
GRANT SELECT ON TABLE public.rent_buddy_applications TO authenticated;

COMMENT ON TABLE public.rent_buddy_applications IS
  'Buddy application. status and admin_status are ADJUDICATED by admin review '
  '(service-role) and are NOT client-writable (2146): authenticated holds SELECT '
  'only (own rows via rb_apps_own); anon has no access; the table is created and '
  'reviewed exclusively through the service-role client.';

DO $$
DECLARE auth_privs text; anon_privs text; forbidden text;
BEGIN
  SELECT COALESCE(string_agg(DISTINCT privilege_type, ',' ORDER BY privilege_type), '(none)')
    INTO auth_privs FROM information_schema.role_table_grants
   WHERE table_schema='public' AND table_name='rent_buddy_applications' AND grantee='authenticated';
  IF auth_privs <> 'SELECT' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: authenticated holds "%", expected SELECT only', auth_privs;
  END IF;

  SELECT COALESCE(string_agg(DISTINCT privilege_type, ',' ORDER BY privilege_type), '(none)')
    INTO anon_privs FROM information_schema.role_table_grants
   WHERE table_schema='public' AND table_name='rent_buddy_applications' AND grantee='anon';
  IF anon_privs <> '(none)' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: anon holds "%", expected no grants', anon_privs;
  END IF;

  SELECT string_agg(column_name, ',' ORDER BY column_name) INTO forbidden
    FROM information_schema.column_privileges
   WHERE table_schema='public' AND table_name='rent_buddy_applications'
     AND grantee IN ('anon','authenticated') AND privilege_type='UPDATE';
  IF forbidden IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: columns still client-updatable: %', forbidden;
  END IF;
END $$;

COMMIT;
