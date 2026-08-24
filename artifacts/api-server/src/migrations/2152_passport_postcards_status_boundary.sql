-- 2152_passport_postcards_status_boundary.sql
--
-- ⚠ STAGED. Apply to portava-ci ONLY. DO NOT APPLY TO PRODUCTION without the
--   owner's explicit approval — live authorization change (passport is enabled).
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
-- Depends on 2151 (which grants the postcard content columns incl. status).
--
-- ── WHAT IS WRONG, PROVEN BY EXECUTION (portava-ci, self-rolling-back) ───────
-- 2151 deliberately left passport_postcards.status client-writable (narrow
-- scope). But status is a MODERATION state (post_status enum
-- active/hidden/reported/deleted). As `authenticated` owning the row, via direct
-- PostgREST:
--   UPDATE passport_postcards SET status='active'
--    WHERE id=<own reported postcard> AND user_id=auth.uid();  => 1 row.
--
-- The public passport feed consumes status='active' (routes/passport.ts:489:
-- .eq("status","active").eq("visibility","public")). So an owner self-restoring a
-- reported/hidden postcard to 'active' RE-EXPOSES moderated content in the public
-- feed — an authorization / moderation-bypass defect.
--
-- ── LEGITIMATE WRITERS OF status: SERVICE-ROLE ONLY ─────────────────────────
-- Traced: create sets status='active' (postcards.ts:897 / posts.ts:588,
-- service-role); /remove sets a removed state (passport.ts:716, service-role);
-- moderation/report flows are service-role. The owner edit route
-- PATCH /me/passport/postcards/:id writes note/visibility/pinned_at — NOT status.
-- So status has NO client self-service; it is service-role-owned.
--
-- ── WHAT THIS DOES ──────────────────────────────────────────────────────────
-- Removes authenticated column INSERT + UPDATE authority over status only. The
-- rest of the approved 2151 content boundary is untouched (media_url, caption,
-- location_name/city/country, visibility, note, pinned_at remain client-writable;
-- post_id/user_id INSERT-only; the location-verification + stamp-award columns
-- remain protected). status has a safe DB default 'active', so a normal
-- authenticated INSERT that OMITS status still creates a valid active postcard;
-- a client can no longer forge status at INSERT or UPDATE time.
--
-- ── WHAT THIS DOES NOT CHANGE ───────────────────────────────────────────────
-- No application code path (all status writes are service-role). No RLS/enum/
-- policy/default/service_role change. SELECT unchanged. Generated types untouched.
--
-- SAFE TO RE-RUN.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.passport_postcards') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.passport_postcards does not exist.';
  END IF;
  -- status must exist and carry a safe default so clients can omit it on INSERT.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='passport_postcards' AND column_name='status'
       AND column_default IS NOT NULL) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: passport_postcards.status missing or has no default; a client INSERT omitting it would fail.';
  END IF;
  -- The 2151 content boundary must be in place (media_url etc. granted, verification protected).
  IF NOT EXISTS (SELECT 1 FROM information_schema.column_privileges
     WHERE table_schema='public' AND table_name='passport_postcards' AND grantee='authenticated'
       AND privilege_type='UPDATE' AND column_name='caption') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: 2151 content grant (caption UPDATE) absent — apply 2151 first.';
  END IF;
END $$;

-- Remove client authority over the moderation-state column ONLY.
REVOKE INSERT (status), UPDATE (status) ON TABLE public.passport_postcards FROM authenticated;
REVOKE INSERT (status), UPDATE (status) ON TABLE public.passport_postcards FROM anon;

COMMENT ON TABLE public.passport_postcards IS
  'Passport postcard. location_verified/verification_method/verified_distance_meters/'
  'verified_at (platform location verification), the stamp-award/revocation columns, '
  'AND status (post_status moderation state consumed by the public feed) are set by '
  'the server (service-role) and are NOT client-writable (2151+2152). '
  'anon+authenticated hold SELECT, plus column-level INSERT/UPDATE on postcard '
  'content (media_url, caption, location_name/city/country, visibility, note, '
  'pinned_at) for authenticated. status has DB default active, so a client INSERT '
  'omitting it still creates a valid active postcard.';

DO $$
DECLARE bad text; ins int; upd int;
BEGIN
  -- status must NOT be client-writable (INSERT or UPDATE) for either client role.
  SELECT string_agg(DISTINCT grantee||'/'||privilege_type, ', ' ORDER BY grantee||'/'||privilege_type)
    INTO bad FROM information_schema.column_privileges
   WHERE table_schema='public' AND table_name='passport_postcards'
     AND grantee IN ('anon','authenticated') AND privilege_type IN ('INSERT','UPDATE')
     AND column_name='status';
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'POSTCONDITION FAILED: status still client-writable via %', bad; END IF;

  -- The 2151 content grants must remain intact: INSERT 10, UPDATE 8 (was 11/9 with status).
  SELECT count(*) INTO ins FROM information_schema.column_privileges
   WHERE table_schema='public' AND table_name='passport_postcards' AND grantee='authenticated' AND privilege_type='INSERT';
  SELECT count(*) INTO upd FROM information_schema.column_privileges
   WHERE table_schema='public' AND table_name='passport_postcards' AND grantee='authenticated' AND privilege_type='UPDATE';
  IF ins <> 10 THEN RAISE EXCEPTION 'POSTCONDITION FAILED: expected 10 INSERT columns after removing status, got %', ins; END IF;
  IF upd <> 8 THEN RAISE EXCEPTION 'POSTCONDITION FAILED: expected 8 UPDATE columns after removing status, got %', upd; END IF;

  -- Content columns must still be writable (spot-check caption + visibility).
  IF NOT EXISTS (SELECT 1 FROM information_schema.column_privileges
     WHERE table_schema='public' AND table_name='passport_postcards' AND grantee='authenticated'
       AND privilege_type='UPDATE' AND column_name IN ('caption','visibility','note','pinned_at')
     GROUP BY grantee HAVING count(*)=4) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: 2151 content UPDATE columns not fully intact.';
  END IF;
END $$;

COMMIT;
