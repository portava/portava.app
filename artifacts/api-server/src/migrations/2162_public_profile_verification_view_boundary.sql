-- 2162_public_profile_verification_view_boundary.sql
--
-- ⚠ STAGED. Apply to portava-ci ONLY. DO NOT APPLY TO PRODUCTION without owner approval.
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- ── WHAT IS WRONG, PROVEN BY EXECUTION (portava-ci, self-rolling-back) ───────
-- public.public_profile_verification is a VIEW over public.profiles created with
-- security_invoker = FALSE (SECURITY DEFINER default), owned by postgres
-- (rolbypassrls=true). anon+authenticated hold full DML on the view. Because the
-- view executes as its owner, DML/reads BYPASS profiles' RLS:
--   * WRITE BYPASS: as an authenticated (or even anon) STRANGER, UPDATE ... SET
--     verification_status='verified', verification_level='trusted_traveler',
--     verified_since=now() WHERE profile_id=<victim> -> ALLOWED(1), landing on
--     the victim's profiles row. The SAME UPDATE directly on profiles is
--     RLS-blocked (profiles_update USING id=auth.uid() -> 0 rows). The view IS
--     the bypass.
--   * READ LEAK: the definer view returns verification for profiles that
--     profiles_select would hide (private / non-friend / blocked).
-- (The 6 computed CASE badge columns are non-updatable; the write vector is the
-- passthrough columns verification_status / verification_level / verified_since.)
--
-- ── FIX ─────────────────────────────────────────────────────────────────────
-- ALTER VIEW ... SET (security_invoker = true): base access now runs as the
-- CALLER, so profiles_update RLS blocks cross-user writes and profiles_select RLS
-- blocks the private-profile read leak, while public badge reads keep working
-- (profiles_select permits is_private=false, non-blocked rows). Adversarially
-- proven sufficient for BOTH demonstrated vectors. The view is never written to
-- in code, so it is additionally made SELECT-only (REVOKE ALL, GRANT SELECT) —
-- a read-only display view. NOTE: the residual self-verification-of-own-row path
-- (a caller flipping their OWN profiles row via the direct base column grant) is
-- closed by the companion migration 2163 (profiles verification trigger); this
-- migration + 2163 together fully close verification forgery. SAFE TO RE-RUN.

BEGIN;
DO $$ BEGIN
  IF to_regclass('public.public_profile_verification') IS NULL THEN RAISE EXCEPTION 'PRECONDITION FAILED: missing'; END IF;
  IF (SELECT relkind FROM pg_class WHERE oid='public.public_profile_verification'::regclass) <> 'v' THEN RAISE EXCEPTION 'PRECONDITION FAILED: not a view'; END IF;
END $$;
ALTER VIEW public.public_profile_verification SET (security_invoker = true);
REVOKE ALL ON public.public_profile_verification FROM anon;
REVOKE ALL ON public.public_profile_verification FROM authenticated;
GRANT SELECT ON public.public_profile_verification TO anon;
GRANT SELECT ON public.public_profile_verification TO authenticated;
DO $$
DECLARE si text; anon_p text; auth_p text;
BEGIN
  SELECT COALESCE((SELECT option_value FROM pg_options_to_table((SELECT reloptions FROM pg_class WHERE oid='public.public_profile_verification'::regclass)) WHERE option_name='security_invoker'),'false') INTO si;
  IF si <> 'true' THEN RAISE EXCEPTION 'POSTCONDITION FAILED: security_invoker=%', si; END IF;
  SELECT COALESCE(string_agg(DISTINCT privilege_type,',' ORDER BY privilege_type),'(none)') INTO anon_p FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name='public_profile_verification' AND grantee='anon';
  IF anon_p <> 'SELECT' THEN RAISE EXCEPTION 'POSTCONDITION FAILED: anon=%', anon_p; END IF;
  SELECT COALESCE(string_agg(DISTINCT privilege_type,',' ORDER BY privilege_type),'(none)') INTO auth_p FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name='public_profile_verification' AND grantee='authenticated';
  IF auth_p <> 'SELECT' THEN RAISE EXCEPTION 'POSTCONDITION FAILED: authenticated=%', auth_p; END IF;
END $$;
COMMIT;
