-- 2153_discovery_places_write_boundary.sql
--
-- ⚠ STAGED. Apply to portava-ci ONLY. DO NOT APPLY TO PRODUCTION without the
--   owner's explicit approval — live authorization change (Discovery is enabled).
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- ── WHAT IS WRONG, PROVEN BY EXECUTION (portava-ci, self-rolling-back) ───────
-- discovery_places is exposed to a direct-PostgREST INSERT forge. The RLS policy
-- discovery_places_auth_insert has WITH CHECK (auth.uid() IS NOT NULL) ONLY — it
-- constrains neither submitted_by, verified, nor status. As `authenticated`:
--   INSERT INTO discovery_places (name, place_type, submitted_by, verified, status)
--     VALUES ('x','restaurant', auth.uid(), true, 'active');   => 1 row.  and
--   ... VALUES ('x','restaurant', <ANOTHER user's id>, true, 'active');  => 1 row.
-- The public discovery feed reads discovery_places_public_read (status='active'),
-- so this injects a fake VERIFIED + ACTIVE place into Discovery AND lets a client
-- impersonate another user as the submitter.
--
-- (The owner-UPDATE path reads as "0 rows" only because there is no owner-SELECT
-- policy — only public_read status='active' — so a submitter's own pending place
-- is RLS-invisible and UPDATE...WHERE cannot find it. The live vector is INSERT.)
--
-- ROOT CAUSE (same class as 2144-2152): anon+authenticated hold TABLE-LEVEL
-- INSERT/UPDATE/DELETE (all 7 privileges) on the table; RLS constrains rows, not
-- the authority columns, and the INSERT check does not bind submitted_by.
--
-- ── LEGITIMATE CLIENT-WRITABLE SET: EMPTY ───────────────────────────────────
-- Every server write uses the SERVICE-ROLE client: rows are created/updated by
-- trackOsmPlaceSave and the visuals/compass/collections services (getServiceClient),
-- and discovery_places_service (FOR ALL, service_role) already authorizes them.
-- There is no user-facing direct place-submission route. So no column is
-- legitimately client-writable: clients get SELECT only (the authorized read path
-- for the public feed via discovery_places_public_read, status='active').
--
-- ── WHAT THIS DOES ──────────────────────────────────────────────────────────
-- REVOKE ALL from anon+authenticated (removes the table-level DML incl. INSERT),
-- GRANT SELECT back to both. service_role is untouched (keeps FOR ALL). No RLS/
-- enum/policy/default change — generated types untouched. Closes the INSERT forge
-- and the submitter impersonation; the owner-UPDATE/DELETE paths were already
-- inert for clients (pending rows RLS-invisible) and are now removed at the grant
-- level too.
--
-- SAFE TO RE-RUN.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.discovery_places') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.discovery_places does not exist.';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.discovery_places'::regclass) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: RLS is not enabled on discovery_places.';
  END IF;
  -- The public feed depends on the client SELECT policy staying in place.
  IF NOT EXISTS (SELECT 1 FROM pg_policies
     WHERE schemaname='public' AND tablename='discovery_places' AND cmd='SELECT') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: no SELECT policy on discovery_places; client reads would need re-deriving.';
  END IF;
  -- service_role must retain its FOR ALL policy so server writes keep working.
  IF NOT EXISTS (SELECT 1 FROM pg_policies
     WHERE schemaname='public' AND tablename='discovery_places' AND cmd='ALL' AND 'service_role'=ANY(roles)) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: discovery_places_service (service_role ALL) absent.';
  END IF;
END $$;

REVOKE ALL ON TABLE public.discovery_places FROM anon;
REVOKE ALL ON TABLE public.discovery_places FROM authenticated;
GRANT SELECT ON TABLE public.discovery_places TO anon;
GRANT SELECT ON TABLE public.discovery_places TO authenticated;

COMMENT ON TABLE public.discovery_places IS
  'Discovery place. Created/updated exclusively by the server (service-role): '
  'trackOsmPlaceSave + visuals/compass services. verified, status, '
  'image_accuracy_status, header_image_status, submitted_by and every other column '
  'are NOT client-writable (2153): anon+authenticated hold SELECT only (public feed '
  'via discovery_places_public_read, status=active). A direct PostgREST write with '
  'the public key can neither forge a verified/active place nor impersonate a submitter.';

DO $$
DECLARE anon_privs text; auth_privs text; svc_ins boolean; client_write int;
BEGIN
  SELECT COALESCE(string_agg(DISTINCT privilege_type, ',' ORDER BY privilege_type), '(none)')
    INTO anon_privs FROM information_schema.role_table_grants
   WHERE table_schema='public' AND table_name='discovery_places' AND grantee='anon';
  IF anon_privs <> 'SELECT' THEN RAISE EXCEPTION 'POSTCONDITION FAILED: anon holds "%", expected SELECT only', anon_privs; END IF;

  SELECT COALESCE(string_agg(DISTINCT privilege_type, ',' ORDER BY privilege_type), '(none)')
    INTO auth_privs FROM information_schema.role_table_grants
   WHERE table_schema='public' AND table_name='discovery_places' AND grantee='authenticated';
  IF auth_privs <> 'SELECT' THEN RAISE EXCEPTION 'POSTCONDITION FAILED: authenticated holds "%", expected SELECT only', auth_privs; END IF;

  -- No client column INSERT/UPDATE/DELETE may survive.
  SELECT count(*) INTO client_write FROM information_schema.column_privileges
   WHERE table_schema='public' AND table_name='discovery_places'
     AND grantee IN ('anon','authenticated') AND privilege_type IN ('INSERT','UPDATE');
  IF client_write <> 0 THEN RAISE EXCEPTION 'POSTCONDITION FAILED: % client column INSERT/UPDATE grants remain', client_write; END IF;

  -- service_role must retain INSERT (server write path).
  SELECT EXISTS (SELECT 1 FROM information_schema.role_table_grants
     WHERE table_schema='public' AND table_name='discovery_places' AND grantee='service_role' AND privilege_type='INSERT') INTO svc_ins;
  IF NOT svc_ins THEN RAISE EXCEPTION 'POSTCONDITION FAILED: service_role lost INSERT.'; END IF;
END $$;

COMMIT;
