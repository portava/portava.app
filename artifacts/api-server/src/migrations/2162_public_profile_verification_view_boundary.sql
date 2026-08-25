-- 2162_public_profile_verification_view_boundary.sql
--
-- ⚠ STAGED. Apply to portava-ci ONLY without owner approval. This migration is a
--   NO-OP on production (verified 2026-08-24 read-only): prod already has this
--   view as security_invoker=true with service_role-only grants. It exists to
--   converge CI (which had drifted to security_invoker=false + full anon/auth DML)
--   onto that same already-correct production state.
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- ── WHAT IS WRONG ON CI, PROVEN BY EXECUTION (portava-ci, self-rolling-back) ──
-- public.public_profile_verification is a VIEW over public.profiles. On CI it had
-- drifted to security_invoker=FALSE (SECURITY DEFINER, owner postgres) with
-- anon+authenticated holding full DML. Executing as owner it BYPASSED profiles
-- RLS: a stranger/anon could UPDATE verification_status='verified' onto ANY
-- profile through the view (the direct base UPDATE is RLS-blocked), and could read
-- verification for profiles that profiles_select hides (private / non-friend).
--
-- ── FIX ─────────────────────────────────────────────────────────────────────
-- Converge to production's state exactly: security_invoker=true (base RLS applies
-- to the caller) AND service_role-only (REVOKE ALL from anon+authenticated, with
-- NO SELECT re-granted). On prod nothing reads this view with the anon key — the
-- app reads verification via service-role routes — so service_role-only is the
-- correct posture, NOT anon/authenticated SELECT. NOTE: the residual self-
-- verification-of-own-row path (a caller flipping their OWN profiles row via the
-- base column grant) is closed by the companion migration 2163 (profiles
-- verification trigger); 2162 + 2163 together fully close verification forgery.
-- SAFE TO RE-RUN. NO-OP on production.

BEGIN;
DO $$ BEGIN
  IF to_regclass('public.public_profile_verification') IS NULL THEN RAISE EXCEPTION 'PRECONDITION FAILED: missing'; END IF;
  IF (SELECT relkind FROM pg_class WHERE oid='public.public_profile_verification'::regclass) <> 'v' THEN RAISE EXCEPTION 'PRECONDITION FAILED: not a view'; END IF;
END $$;
ALTER VIEW public.public_profile_verification SET (security_invoker = true);
REVOKE ALL ON public.public_profile_verification FROM anon;
REVOKE ALL ON public.public_profile_verification FROM authenticated;
DO $$
DECLARE si text; n int;
BEGIN
  SELECT COALESCE((SELECT option_value FROM pg_options_to_table((SELECT reloptions FROM pg_class WHERE oid='public.public_profile_verification'::regclass)) WHERE option_name='security_invoker'),'false') INTO si;
  IF si <> 'true' THEN RAISE EXCEPTION 'POSTCONDITION FAILED: security_invoker=%', si; END IF;
  SELECT count(*) INTO n FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name='public_profile_verification' AND grantee IN ('anon','authenticated');
  IF n <> 0 THEN RAISE EXCEPTION 'POSTCONDITION FAILED: % anon/authenticated grant(s) remain on the view (expected service_role-only)', n; END IF;
END $$;
COMMIT;
