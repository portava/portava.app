-- 2163_profiles_verification_privileged.sql
--
-- ⚠ STAGED. Apply to portava-ci ONLY. DO NOT APPLY TO PRODUCTION without owner approval.
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- ── WHAT IS WRONG, PROVEN BY EXECUTION (portava-ci, self-rolling-back) ───────
-- public.profiles grants anon+authenticated TABLE-LEVEL INSERT/UPDATE, and all
-- nine platform-verification columns are therefore client-writable:
--   verification_status, verification_level, verified_since, id_verified_at,
--   selfie_verified_at, home_country_verified_at, host_verified_at,
--   buddy_verified_at, safety_flags_count.
-- profiles_update RLS (USING id=auth.uid()) lets a user write their OWN row, so a
-- user can self-verify directly:  UPDATE profiles SET verification_status=
-- 'verified' WHERE id=auth.uid()  — no view needed. (The SECURITY DEFINER view
-- public_profile_verification, fixed in 2162, additionally amplified this to
-- cross-user + anon forgery.) These columns are the source of the verified-
-- traveler / host / buddy trust badges (read by public_profile_verification and
-- trust surfaces) and are written ONLY by routes/admin.ts via the service-role
-- client — never by a legitimate user path.
--
-- Because profiles holds a TABLE-LEVEL grant, a column-level REVOKE cannot carve
-- these columns out. The repo already defends the other profiles authority
-- columns (role, is_official) with BEFORE INSERT/UPDATE triggers gated by
-- public.caller_may_write_profile_role(); this migration adds the SAME guard for
-- the verification columns — reusing the existing authorization primitive rather
-- than inventing new logic. A normal signup inserting the column DEFAULTS
-- (unverified / none / 0 / null) is unaffected; only a NON-default insert or a
-- CHANGE by a non-privileged caller is rejected (42501). service_role /
-- postgres / supabase_admin pass caller_may_write_profile_role() and are
-- unaffected. SAFE TO RE-RUN (CREATE OR REPLACE + idempotent trigger swap).

BEGIN;
DO $$ BEGIN
  IF to_regclass('public.profiles') IS NULL THEN RAISE EXCEPTION 'PRECONDITION FAILED: profiles missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='caller_may_write_profile_role')
    THEN RAISE EXCEPTION 'PRECONDITION FAILED: caller_may_write_profile_role() missing'; END IF;
  PERFORM 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='profiles'
    AND column_name IN ('verification_status','verification_level','verified_since','id_verified_at','selfie_verified_at','home_country_verified_at','host_verified_at','buddy_verified_at','safety_flags_count')
    HAVING count(*) = 9;
  IF NOT FOUND THEN RAISE EXCEPTION 'PRECONDITION FAILED: expected 9 verification columns on profiles'; END IF;
END $$;

CREATE OR REPLACE FUNCTION public.enforce_profile_verification_privileged()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public', 'pg_catalog'
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Only a NON-default verification value needs privilege; a normal signup that
    -- inserts the defaults (unverified / none / 0 / null) must not be blocked.
    IF ( COALESCE(NEW.verification_status, 'unverified') IS DISTINCT FROM 'unverified'
      OR COALESCE(NEW.verification_level, 'none')        IS DISTINCT FROM 'none'
      OR NEW.verified_since             IS NOT NULL
      OR NEW.id_verified_at             IS NOT NULL
      OR NEW.selfie_verified_at         IS NOT NULL
      OR NEW.home_country_verified_at   IS NOT NULL
      OR NEW.host_verified_at           IS NOT NULL
      OR NEW.buddy_verified_at          IS NOT NULL
      OR COALESCE(NEW.safety_flags_count, 0) IS DISTINCT FROM 0 )
      AND NOT public.caller_may_write_profile_role() THEN
      RAISE EXCEPTION 'profiles verification columns cannot be set on insert by this caller'
        USING ERRCODE = '42501',
              HINT = 'Use a service-role client, or connect directly as postgres/supabase_admin.';
    END IF;

  ELSIF TG_OP = 'UPDATE' THEN
    -- IS DISTINCT FROM (null-safe): a no-op write of the same value never trips.
    IF ( NEW.verification_status     IS DISTINCT FROM OLD.verification_status
      OR NEW.verification_level      IS DISTINCT FROM OLD.verification_level
      OR NEW.verified_since          IS DISTINCT FROM OLD.verified_since
      OR NEW.id_verified_at          IS DISTINCT FROM OLD.id_verified_at
      OR NEW.selfie_verified_at      IS DISTINCT FROM OLD.selfie_verified_at
      OR NEW.home_country_verified_at IS DISTINCT FROM OLD.home_country_verified_at
      OR NEW.host_verified_at        IS DISTINCT FROM OLD.host_verified_at
      OR NEW.buddy_verified_at       IS DISTINCT FROM OLD.buddy_verified_at
      OR NEW.safety_flags_count      IS DISTINCT FROM OLD.safety_flags_count )
      AND NOT public.caller_may_write_profile_role() THEN
      RAISE EXCEPTION 'profiles verification columns are not self-writable'
        USING ERRCODE = '42501',
              HINT = 'Use a service-role client, or connect directly as postgres/supabase_admin.';
    END IF;
  END IF;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_profiles_verification_privileged ON public.profiles;
CREATE TRIGGER trg_profiles_verification_privileged
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.enforce_profile_verification_privileged();

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_profiles_verification_privileged' AND NOT tgisinternal
                 AND tgrelid='public.profiles'::regclass)
    THEN RAISE EXCEPTION 'POSTCONDITION FAILED: trigger not installed'; END IF;
END $$;
COMMIT;
