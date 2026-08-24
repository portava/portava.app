-- 2149_passport_stamps_write_boundary.sql
--
-- ⚠ STAGED. Apply to portava-ci ONLY. DO NOT APPLY TO PRODUCTION without the
--   owner's explicit approval — live authorization change (passport is enabled).
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- ── WHAT IS WRONG, PROVEN BY EXECUTION (portava-ci, self-rolling-back) ───────
-- As `authenticated` owning the row, via direct PostgREST (public anon key):
--   UPDATE passport_stamps SET verification_level='verified'
--    WHERE id=<own stamp> AND user_id=auth.uid();   => 1 row. SELF-VERIFY.
--
-- verification_level is the PLATFORM's trust assertion on a stamp: it is ranked
-- as a trust signal (PassportMapService verificationRank) and is the canonical
-- ID-verification predicate feeding trustScore + booking gates. A user asserting
-- it forges platform verification.
--
-- ROOT CAUSE (same class as 2144-2148): anon+authenticated hold INSERT/UPDATE on
-- every column; the RLS policy passport_stamps_own (USING/CHECK auth.uid()=user_id)
-- constrains the ROW, not the COLUMNS.
--
-- ── LEGITIMATE CLIENT-WRITABLE SET (owner decision) ─────────────────────────
-- "Users may control their passport content. Users may NOT assert platform
-- verification." Every server write uses the SERVICE-ROLE client (requireUser →
-- getServiceClient), so this grant governs only DIRECT-PostgREST writes. The
-- only client-facing edit route is PATCH /me/passport/stamps/:id (patchStampSchema
-- = { visibility }); stamps are otherwise platform-awarded (service-role). To keep
-- legitimate direct owner content writes possible, authenticated may INSERT/UPDATE
-- the user-owned content columns; it may NOT touch the verification/provenance/
-- canonical-identity columns.
--
-- CLASS A — user content (granted): stamp_type, country, city, neighborhood,
--   place_id, plan_id, trip_id, visibility (owner self-service; drives
--   passport_stamps_public_read). user_id is INSERT-only (ownership; never UPDATE).
-- CLASS B — protected (NOT client-writable):
--   verification_level  (MANDATE: platform verification / trust rank),
--   source_type         (award provenance in the award idempotency/eligibility
--                        key + hotel-blur privacy gate; values system/admin/
--                        moderation/trips are server-set),
--   catalog_id          (canonical universal-stamp-catalog identity / artwork key),
--   artwork_override    (admin artwork override; no client write path).
-- CLASS C — system/immutable (not granted): id, awarded_at, created_at, updated_at.
--
-- All CLASS B columns have safe defaults or are nullable, so a client INSERT that
-- omits them yields a valid UNVERIFIED row (verification_level 'unverified',
-- source_type 'system', catalog_id/artwork_override NULL). No default DDL needed.
--
-- ── WHAT THIS DOES NOT CHANGE ───────────────────────────────────────────────
-- No application code path (all server writes service-role). anon keeps SELECT
-- (passport_stamps_public_read: visibility='public'). No RLS/enum/policy/default/
-- service_role change — generated types untouched.
--
-- SAFE TO RE-RUN.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.passport_stamps') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.passport_stamps does not exist.';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.passport_stamps'::regclass) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: RLS is not enabled on passport_stamps.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies
     WHERE schemaname='public' AND tablename='passport_stamps' AND policyname='passport_stamps_public_read') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: passport_stamps_public_read absent; anon SELECT would need re-deriving.';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema='public' AND table_name='passport_stamps'
         AND column_name IN ('verification_level','visibility','user_id','stamp_type')) <> 4 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: expected columns drifted.';
  END IF;
END $$;

REVOKE ALL ON TABLE public.passport_stamps FROM anon;
REVOKE ALL ON TABLE public.passport_stamps FROM authenticated;

GRANT SELECT ON TABLE public.passport_stamps TO anon;
GRANT SELECT ON TABLE public.passport_stamps TO authenticated;

-- Owner content: INSERT includes user_id (ownership) + content; UPDATE excludes user_id.
GRANT INSERT (user_id, stamp_type, country, city, neighborhood, place_id, plan_id, trip_id, visibility)
  ON TABLE public.passport_stamps TO authenticated;
GRANT UPDATE (stamp_type, country, city, neighborhood, place_id, plan_id, trip_id, visibility)
  ON TABLE public.passport_stamps TO authenticated;

COMMENT ON TABLE public.passport_stamps IS
  'Passport stamp. verification_level (platform verification / trust rank), '
  'source_type (award provenance), catalog_id (canonical catalog identity) and '
  'artwork_override are set by the award/verification engine (service-role) and '
  'are NOT client-writable (2149): anon+authenticated hold SELECT, plus '
  'column-level INSERT/UPDATE on the user content columns (stamp_type, country, '
  'city, neighborhood, place_id, plan_id, trip_id, visibility) for authenticated. '
  'A self-inserted stamp is always unverified.';

DO $$
DECLARE anon_privs text; auth_privs text; forbidden text; ins int; upd int;
BEGIN
  SELECT COALESCE(string_agg(DISTINCT privilege_type, ',' ORDER BY privilege_type), '(none)')
    INTO anon_privs FROM information_schema.role_table_grants
   WHERE table_schema='public' AND table_name='passport_stamps' AND grantee='anon';
  IF anon_privs <> 'SELECT' THEN RAISE EXCEPTION 'POSTCONDITION FAILED: anon holds "%", expected SELECT only', anon_privs; END IF;

  SELECT COALESCE(string_agg(DISTINCT privilege_type, ',' ORDER BY privilege_type), '(none)')
    INTO auth_privs FROM information_schema.role_table_grants
   WHERE table_schema='public' AND table_name='passport_stamps' AND grantee='authenticated';
  IF auth_privs <> 'SELECT' THEN RAISE EXCEPTION 'POSTCONDITION FAILED: authenticated table-level "%", expected SELECT only', auth_privs; END IF;

  -- Protected columns must NOT be client-writable (INSERT or UPDATE).
  SELECT string_agg(DISTINCT grantee||'/'||privilege_type||'/'||column_name, ', ' ORDER BY grantee||'/'||privilege_type||'/'||column_name)
    INTO forbidden FROM information_schema.column_privileges
   WHERE table_schema='public' AND table_name='passport_stamps'
     AND grantee IN ('anon','authenticated') AND privilege_type IN ('INSERT','UPDATE')
     AND column_name IN ('verification_level','source_type','catalog_id','artwork_override',
                         'id','awarded_at','created_at','updated_at');
  IF forbidden IS NOT NULL THEN RAISE EXCEPTION 'POSTCONDITION FAILED: protected columns still client-writable: %', forbidden; END IF;

  SELECT count(*) INTO ins FROM information_schema.column_privileges
   WHERE table_schema='public' AND table_name='passport_stamps' AND grantee='authenticated' AND privilege_type='INSERT';
  SELECT count(*) INTO upd FROM information_schema.column_privileges
   WHERE table_schema='public' AND table_name='passport_stamps' AND grantee='authenticated' AND privilege_type='UPDATE';
  IF ins <> 9 THEN RAISE EXCEPTION 'POSTCONDITION FAILED: expected 9 INSERT columns, got %', ins; END IF;
  IF upd <> 8 THEN RAISE EXCEPTION 'POSTCONDITION FAILED: expected 8 UPDATE columns, got %', upd; END IF;

  IF EXISTS (SELECT 1 FROM information_schema.column_privileges
     WHERE table_schema='public' AND table_name='passport_stamps' AND grantee='anon' AND privilege_type IN ('INSERT','UPDATE')) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: anon retains a column INSERT/UPDATE grant.';
  END IF;
END $$;

COMMIT;
