-- 3741_trip_presence_current_security_invoker.sql
--
-- public.trip_presence_current stops reading trip_presence with its OWNER's
-- rights. POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band). Lane G
-- (mission 4, grants / inverse schema audit), band 3740-3759.
--
-- One reloption on one view. No row, no policy, no grant, no flag changes.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE DEFECT (verifier F2, 2026-10-07; confirmed on production by the lead's
-- read-only catalog query: owner postgres, reloptions NULL)
-- ══════════════════════════════════════════════════════════════════════════════
-- 2776 created the view without `security_invoker` and granted SELECT on it to
-- `authenticated`. Its comment says "the view inherits trip_presence's RLS (it
-- is not SECURITY DEFINER …)". That is backwards: in PostgreSQL a view WITHOUT
-- security_invoker = true checks the tables it reads with its OWNER's
-- privileges, and the owner is not subject to RLS on a table that does not
-- FORCE it (trip_presence enables RLS, 2763, and does not force it). So every
-- signed-in user could read every trip_presence row of every trip through
-- `/rest/v1/trip_presence_current` — visibility = 'private' rows included —
-- and trip_presence_select_crew (authz.is_trip_crew) was never consulted.
-- Production held 0 rows on 2026-10-07. It is the only client-readable definer
-- view in public apart from PostGIS's geometry_columns / geography_columns.
-- (2776's comment is corrected in docs/migrations.md, not in 2776, whose bytes
-- are applied and checksummed.)
--
-- With security_invoker = true the view reads trip_presence as the CALLER:
-- trip_presence_select_crew decides the rows, exactly as 2776 intended. The
-- server reads it as service_role, which bypasses RLS either way, so no server
-- path changes. Every function the view calls (trip_presence_freshness, a plain
-- SQL function) keeps the EXECUTE grant it has today.
--
-- Guard: checkClientPrivilegeBoundary.ts rule 5 (same change) fails CI on any
-- view the chain leaves client-readable without security_invoker.
-- Rollback: db/rollback/2026-10-07-3741-trip-presence-current-security-invoker-rollback.sql
-- (re-opens the read; for recovery only).

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.trip_presence_current') IS NULL THEN
    RAISE EXCEPTION '3741 PRECONDITION FAILED: public.trip_presence_current does not exist (2776 creates it).';
  END IF;
  IF (SELECT relkind FROM pg_class WHERE oid = 'public.trip_presence_current'::regclass) <> 'v' THEN
    RAISE EXCEPTION '3741 PRECONDITION FAILED: public.trip_presence_current is not a view.';
  END IF;
  -- Only the owner (or a member of the owning role) may change a view's options.
  IF NOT pg_has_role((SELECT relowner FROM pg_class WHERE oid = 'public.trip_presence_current'::regclass), 'USAGE') THEN
    RAISE EXCEPTION '3741 PRECONDITION FAILED: % does not own public.trip_presence_current; apply as its owner.', current_user;
  END IF;
  -- The rows must be filtered by something once the view stops bypassing it.
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.trip_presence'::regclass) THEN
    RAISE EXCEPTION '3741 PRECONDITION FAILED: RLS is not enabled on public.trip_presence; security_invoker would leave nothing deciding the rows.';
  END IF;
END $pre$;

ALTER VIEW public.trip_presence_current SET (security_invoker = true);

COMMIT;

DO $post$
DECLARE
  v_inv boolean;
BEGIN
  SELECT COALESCE((SELECT lower(o.option_value) IN ('true', 'on', '1', 'yes')
                     FROM pg_options_to_table(c.reloptions) o WHERE o.option_name = 'security_invoker'), false)
    INTO v_inv
    FROM pg_class c WHERE c.oid = 'public.trip_presence_current'::regclass;
  IF NOT v_inv THEN
    RAISE EXCEPTION '3741 POSTCONDITION FAILED: public.trip_presence_current is not security_invoker; it reads trip_presence past its RLS.';
  END IF;
  IF has_table_privilege('anon', 'public.trip_presence_current', 'SELECT') THEN
    RAISE EXCEPTION '3741 POSTCONDITION FAILED: anon can read public.trip_presence_current (2776 revoked it).';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.trip_presence'::regclass) THEN
    RAISE EXCEPTION '3741 POSTCONDITION FAILED: RLS is not enabled on public.trip_presence.';
  END IF;
END $post$;
