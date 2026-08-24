-- 2151_passport_postcards_write_boundary.sql
--
-- ⚠ STAGED. Apply to portava-ci ONLY. DO NOT APPLY TO PRODUCTION without the
--   owner's explicit approval — live authorization change (passport is enabled).
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- ── WHAT IS WRONG, PROVEN BY EXECUTION (portava-ci, self-rolling-back) ───────
-- As `authenticated` owning the row, via direct PostgREST (public anon key):
--   UPDATE passport_postcards SET location_verified=true,
--          verification_method='gps_current_location', verified_distance_meters=0
--    WHERE id=<own postcard> AND user_id=auth.uid();   => 1 row. FORGE.
--
-- location_verified / verification_method / verified_distance_meters / verified_at
-- are the platform's assertion that the author's GPS matched the tagged place
-- (the geotag verdict), feeding passport authenticity + stamp eligibility. A user
-- asserting them forges "the platform verified this location".
--
-- ROOT CAUSE (same class as 2144-2150): anon+authenticated hold INSERT/UPDATE on
-- every column; the RLS policy postcards_update (USING/CHECK user_id=auth.uid())
-- constrains the ROW, not the COLUMNS.
--
-- ── LEGITIMATE CLIENT-WRITABLE SET (owner decision) ─────────────────────────
-- "Users may control postcard content. Users may NOT assert platform location
-- verification." Every server write uses the service-role client; the owner edit
-- route PATCH /me/passport/postcards/:id writes note/visibility/pinned_at. To keep
-- legitimate direct owner content writes possible, authenticated may INSERT/UPDATE
-- the postcard content columns; it may NOT touch the location-verification columns
-- or the platform stamp-award/revocation columns.
--
-- CLASS A — user content + self-service (granted): media_url, caption,
--   location_name, location_city, location_country (user-SUPPLIED location, NOT
--   platform-verified), visibility, note, pinned_at, status. INSERT adds post_id
--   and user_id (ownership; user_id never UPDATE).
-- CLASS B — protected (NOT client-writable):
--   location_verified, verification_method, verified_distance_meters, verified_at
--     (MANDATE: platform location verification / geotag verdict);
--   stamp_eligible, stamp_reason, stamp_style, stamp_revoked, stamp_revoked_reason,
--   stamp_revoked_at, stamp_revoked_by (platform stamp-award / revocation state;
--     stamp_revoked_by is a moderator id — never client-writable).
-- CLASS C — system/derived (not granted): id, created_at, updated_at, deleted_at,
--   media_count, has_video, primary_media_type.
--
-- All CLASS B columns have safe defaults or are nullable (location_verified false,
-- verification_method 'unavailable', stamp_eligible/stamp_revoked false, the rest
-- NULL), so a client INSERT omitting them yields a valid UNVERIFIED postcard.
--
-- ── NOT IN SCOPE (separate finding) ─────────────────────────────────────────
-- status (post_status enum) is left client-writable here per the owner's
-- direction to keep this migration narrowly focused on location verification.
-- Caller tracing shows the public passport feed selects status='active'
-- (routes/passport.ts:489), so a client self-restoring a reported/hidden postcard
-- to 'active' is a MODERATION BYPASS — but postcard status has no client
-- self-service in the API (all status writes are service-role), so it can be
-- closed cleanly in a follow-up (revoke status from the client grant). Filed
-- separately; NOT bundled here.
--
-- ── WHAT THIS DOES NOT CHANGE ───────────────────────────────────────────────
-- No application code path (all server writes service-role). anon keeps SELECT
-- (postcards_select: can_see_postcard(id)). No RLS/enum/policy/default/service_role
-- change — generated types untouched.
--
-- SAFE TO RE-RUN.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.passport_postcards') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.passport_postcards does not exist.';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.passport_postcards'::regclass) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: RLS is not enabled on passport_postcards.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies
     WHERE schemaname='public' AND tablename='passport_postcards' AND cmd='SELECT') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: no SELECT policy on passport_postcards; client reads would need re-deriving.';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema='public' AND table_name='passport_postcards'
         AND column_name IN ('location_verified','verification_method','verified_distance_meters','verified_at','post_id','user_id','media_url')) <> 7 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: expected columns drifted.';
  END IF;
END $$;

REVOKE ALL ON TABLE public.passport_postcards FROM anon;
REVOKE ALL ON TABLE public.passport_postcards FROM authenticated;

GRANT SELECT ON TABLE public.passport_postcards TO anon;
GRANT SELECT ON TABLE public.passport_postcards TO authenticated;

GRANT INSERT (post_id, user_id, media_url, caption, location_name, location_city, location_country, visibility, note, pinned_at, status)
  ON TABLE public.passport_postcards TO authenticated;
GRANT UPDATE (media_url, caption, location_name, location_city, location_country, visibility, note, pinned_at, status)
  ON TABLE public.passport_postcards TO authenticated;

COMMENT ON TABLE public.passport_postcards IS
  'Passport postcard. location_verified, verification_method, '
  'verified_distance_meters, verified_at (platform location verification) and the '
  'stamp-award/revocation columns (stamp_eligible, stamp_reason, stamp_style, '
  'stamp_revoked*, stamp_revoked_by) are set by the server (service-role) and are '
  'NOT client-writable (2151): anon+authenticated hold SELECT, plus column-level '
  'INSERT/UPDATE on postcard content (media_url, caption, location_name/city/'
  'country, visibility, note, pinned_at, status) for authenticated. status is '
  'left writable here; the reported->active moderation-bypass is a separate finding.';

DO $$
DECLARE anon_privs text; auth_privs text; forbidden text; ins int; upd int;
BEGIN
  SELECT COALESCE(string_agg(DISTINCT privilege_type, ',' ORDER BY privilege_type), '(none)')
    INTO anon_privs FROM information_schema.role_table_grants
   WHERE table_schema='public' AND table_name='passport_postcards' AND grantee='anon';
  IF anon_privs <> 'SELECT' THEN RAISE EXCEPTION 'POSTCONDITION FAILED: anon holds "%", expected SELECT only', anon_privs; END IF;
  SELECT COALESCE(string_agg(DISTINCT privilege_type, ',' ORDER BY privilege_type), '(none)')
    INTO auth_privs FROM information_schema.role_table_grants
   WHERE table_schema='public' AND table_name='passport_postcards' AND grantee='authenticated';
  IF auth_privs <> 'SELECT' THEN RAISE EXCEPTION 'POSTCONDITION FAILED: authenticated table-level "%", expected SELECT only', auth_privs; END IF;

  -- location-verification + stamp-award columns must NOT be client-writable.
  SELECT string_agg(DISTINCT grantee||'/'||privilege_type||'/'||column_name, ', ' ORDER BY grantee||'/'||privilege_type||'/'||column_name)
    INTO forbidden FROM information_schema.column_privileges
   WHERE table_schema='public' AND table_name='passport_postcards'
     AND grantee IN ('anon','authenticated') AND privilege_type IN ('INSERT','UPDATE')
     AND column_name IN ('location_verified','verification_method','verified_distance_meters','verified_at',
                         'stamp_eligible','stamp_reason','stamp_style','stamp_revoked','stamp_revoked_reason',
                         'stamp_revoked_at','stamp_revoked_by','id','created_at','updated_at','deleted_at',
                         'media_count','has_video','primary_media_type');
  IF forbidden IS NOT NULL THEN RAISE EXCEPTION 'POSTCONDITION FAILED: protected columns still client-writable: %', forbidden; END IF;

  SELECT count(*) INTO ins FROM information_schema.column_privileges
   WHERE table_schema='public' AND table_name='passport_postcards' AND grantee='authenticated' AND privilege_type='INSERT';
  SELECT count(*) INTO upd FROM information_schema.column_privileges
   WHERE table_schema='public' AND table_name='passport_postcards' AND grantee='authenticated' AND privilege_type='UPDATE';
  IF ins <> 11 THEN RAISE EXCEPTION 'POSTCONDITION FAILED: expected 11 INSERT columns, got %', ins; END IF;
  IF upd <> 9 THEN RAISE EXCEPTION 'POSTCONDITION FAILED: expected 9 UPDATE columns, got %', upd; END IF;

  IF EXISTS (SELECT 1 FROM information_schema.column_privileges
     WHERE table_schema='public' AND table_name='passport_postcards' AND grantee='anon' AND privilege_type IN ('INSERT','UPDATE')) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: anon retains a column INSERT/UPDATE grant.';
  END IF;
END $$;

COMMIT;
