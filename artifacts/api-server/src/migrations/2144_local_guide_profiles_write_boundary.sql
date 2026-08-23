-- 2144_local_guide_profiles_write_boundary.sql
--
-- ⚠ STAGED — NOT APPLIED TO ANY ENVIRONMENT. Apply to portava-ci first, verify,
--   then hand the production apply to the owner. This changes what an
--   authenticated user may write, so it is a live authorization change.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- ── THE PROBLEM ─────────────────────────────────────────────────────────────
-- Verified against PRODUCTION on 2026-08-23:
--
--   grants to `authenticated`:  DELETE, INSERT, REFERENCES, SELECT, TRIGGER,
--                               TRUNCATE, UPDATE
--   only UPDATE policy:         lgp_own_update
--                                 USING (user_id = auth.uid())
--                                 WITH CHECK — NONE
--
-- RLS is enabled, so the absent INSERT/DELETE policies do block those verbs. The
-- live hole is UPDATE: the policy restricts WHICH ROW you may update and says
-- nothing about WHICH COLUMNS. A guide can therefore PATCH their own row through
-- PostgREST and set anything on it:
--
--   guide_level     -> 5           self-promotion to the top tier
--   accuracy_score  -> 1           overwrite the derived quality score
--   helpful_votes   -> 9999        inflate the other input to guide_level
--   status          -> 'active'    self-approval, bypassing admin review
--   verified_at     -> now()
--
-- That makes the server-side derivation pointless. LocalGuideService.recomputeGuideAccuracy
-- computes accuracy from the real fate of a guide's submissions specifically so
-- the number cannot be asserted — and then the row it writes to is
-- client-writable. Same for setGuideStatus, which exists as an ADMIN path.
--
-- local_guide_profiles holds 0 rows on production today, so nothing is currently
-- exploited. This is a live capability, not a live incident.
--
-- ── THE FIX ─────────────────────────────────────────────────────────────────
-- Column-level UPDATE grants. A user may still edit the two fields that are
-- genuinely theirs to write — their bio and the cities they claim expertise in —
-- and nothing else. Everything derived, awarded, or adjudicated becomes
-- service-role only, which is how it is already written server-side.
--
-- WITH CHECK is added as well, so the row cannot be re-pointed at another user
-- mid-update. USING alone governs which rows you may TOUCH; WITH CHECK governs
-- what they may look like AFTERWARDS, and its absence is the second half of the
-- same defect.
--
-- The unused verbs are revoked too. TRUNCATE and TRIGGER on a user-facing table
-- are grants nobody intended; DELETE and INSERT are currently inert only because
-- no policy admits them, which is a thin guarantee to keep resting on.
--
-- ── WHAT THIS DOES NOT DO ───────────────────────────────────────────────────
-- It does not change any application code path. Every server write to this table
-- goes through the service-role client, which bypasses RLS and column grants
-- alike, so applyForGuide, recordContribution, recomputeGuideAccuracy and
-- setGuideStatus are all unaffected.
--
-- SAFE TO RE-RUN.

BEGIN;

-- ── Preconditions ───────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.local_guide_profiles') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.local_guide_profiles does not exist.';
  END IF;

  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.local_guide_profiles'::regclass) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: RLS is not enabled on local_guide_profiles. This migration narrows an existing boundary; it does not create one.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='local_guide_profiles'
       AND column_name IN ('bio','city_expertise')
     GROUP BY table_name HAVING count(*) = 2
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: expected both bio and city_expertise on local_guide_profiles — the self-editable column set is derived from them.';
  END IF;
END $$;

-- ── 1. Narrow the verbs ─────────────────────────────────────────────────────
REVOKE ALL ON TABLE public.local_guide_profiles FROM authenticated;
GRANT SELECT ON TABLE public.local_guide_profiles TO authenticated;

-- ── 2. Column-level UPDATE: only what is genuinely the user's to write ───────
GRANT UPDATE (bio, city_expertise) ON TABLE public.local_guide_profiles TO authenticated;

-- ── 3. Close the WITH CHECK gap ─────────────────────────────────────────────
DROP POLICY IF EXISTS "lgp_own_update" ON public.local_guide_profiles;
CREATE POLICY "lgp_own_update" ON public.local_guide_profiles
  FOR UPDATE TO authenticated
  USING      (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

COMMENT ON TABLE public.local_guide_profiles IS
  'Guide profile. guide_level, accuracy_score, helpful_votes, status and '
  'verified_at are DERIVED or ADJUDICATED server-side and are not client-writable '
  '(2144): authenticated holds column-level UPDATE on bio and city_expertise only.';

-- ── Postconditions ──────────────────────────────────────────────────────────
DO $$
DECLARE
  tbl_privs text;
  writable  text;
  wc        text;
BEGIN
  SELECT COALESCE(string_agg(DISTINCT privilege_type, ',' ORDER BY privilege_type), '')
    INTO tbl_privs
    FROM information_schema.role_table_grants
   WHERE table_schema='public' AND table_name='local_guide_profiles' AND grantee='authenticated';
  IF tbl_privs <> 'SELECT' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: authenticated holds table-level privileges "%", expected SELECT only', tbl_privs;
  END IF;

  SELECT COALESCE(string_agg(column_name, ',' ORDER BY column_name), '')
    INTO writable
    FROM information_schema.column_privileges
   WHERE table_schema='public' AND table_name='local_guide_profiles'
     AND grantee='authenticated' AND privilege_type='UPDATE';
  IF writable <> 'bio,city_expertise' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: client-updatable columns are "%", expected exactly bio,city_expertise', writable;
  END IF;

  SELECT pg_get_expr(p.polwithcheck, p.polrelid) INTO wc
    FROM pg_policy p
   WHERE p.polrelid = 'public.local_guide_profiles'::regclass AND p.polname = 'lgp_own_update';
  IF wc IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: lgp_own_update still has no WITH CHECK — a row could be re-pointed at another user mid-update.';
  END IF;
END $$;

COMMIT;
