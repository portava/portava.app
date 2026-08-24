-- 2144_local_guide_profiles_write_boundary.sql
--
-- ⚠ STAGED. Applied to portava-ci ONLY. DO NOT APPLY TO PRODUCTION without the
--   owner's explicit approval — this is a live authorization change.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- ── WHAT IS WRONG, PROVEN EMPIRICALLY ───────────────────────────────────────
-- Measured against portava-ci on 2026-08-23 by assuming the `authenticated`
-- role with a JWT whose sub is the row owner, then attempting the write. Not
-- inferred from policy text — executed.
--
-- PRE-STATE:
--   grants: anon AND authenticated each hold
--           DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE
--   column-level UPDATE to authenticated covers ELEVEN columns, including
--           user_id, guide_level, accuracy_score, helpful_votes, status,
--           verified_at, contribution_count, created_at, updated_at
--   policies (all TO public):
--           lgp_public_read  SELECT  USING (status = 'active')
--           lgp_own_read     SELECT  USING (user_id = auth.uid())
--           lgp_own_update   UPDATE  USING (user_id = auth.uid())   NO WITH CHECK
--           lgp_insert       INSERT  CHECK (auth.uid() IS NOT NULL
--                                           AND user_id = auth.uid())
--
-- TWO INDEPENDENT SELF-PROMOTION PATHS, both confirmed to succeed:
--
--   1. UPDATE — an existing guide sets their own privileged columns:
--        UPDATE local_guide_profiles
--           SET guide_level=5, accuracy_score=1, helpful_votes=9999,
--               status='active', verified_at=now()
--         WHERE user_id = auth.uid();
--      => 1 row affected. Read back: guide_level=5, accuracy_score=1,
--         status=active, helpful_votes=9999, verified_at set.
--      The policy restricts which ROW may be touched and says nothing about
--      which COLUMNS, and there is no WITH CHECK to constrain the result.
--
--   2. INSERT — a user with NO guide profile creates one already promoted:
--        INSERT INTO local_guide_profiles (user_id, guide_level, accuracy_score,
--                                          status, bio)
--        VALUES (auth.uid(), 5, 1, 'active', '...');
--      => 1 row affected. Read back: guide_level=5, status=active.
--      lgp_insert verifies OWNERSHIP and nothing about the values.
--
-- Why status='active' matters beyond the badge: lgp_public_read exposes every
-- row with status='active', so self-activation is also self-publication.
--
-- WHY THIS DEFEATS THE SERVER. LocalGuideService.recomputeGuideAccuracy derives
-- accuracy_score from the real fate of a guide's submissions specifically so the
-- number cannot be asserted, and setGuideStatus exists as an ADMIN path. Both
-- write to a row the client can overwrite.
--
-- NOT CURRENTLY EXPLOITED: local_guide_profiles holds 0 rows on production and 0
-- on CI. This is a live capability, not a live incident.
--
-- ── WHAT THIS CHANGES ───────────────────────────────────────────────────────
-- 1. REVOKE ALL from anon AND authenticated. The first draft of this migration
--    revoked only from `authenticated`; measuring the live state showed anon
--    holds the identical grant set. anon's UPDATE/DELETE are blocked today by
--    predicate (auth.uid() is NULL, so lgp_own_update never matches a row) —
--    blocked by a predicate rather than by a privilege is a thin place to rest,
--    and one added anon-permitting policy would open it.
-- 2. GRANT SELECT back to BOTH. anon SELECT is load-bearing: lgp_public_read is
--    the public guide directory, and revoking it would break unauthenticated
--    browsing. Confirmed anon reads active rows today.
-- 3. GRANT UPDATE (bio, city_expertise) to authenticated ONLY. Those are the two
--    fields genuinely the user's to write. Everything derived (guide_level,
--    accuracy_score, helpful_votes, contribution_count), adjudicated (status,
--    verified_at), or structural (user_id, created_at, updated_at) becomes
--    service-role only — which is how every server path already writes them.
-- 4. Recreate lgp_own_update WITH a WITH CHECK. USING governs which rows you may
--    TOUCH; WITH CHECK governs what they may look like AFTERWARDS. Its absence
--    is the second half of the same defect: user_id is in the writable set, so
--    without it a row could be re-pointed at another user mid-update.
--
-- INSERT: the grant is revoked, so path 2 closes. lgp_insert is deliberately
-- LEFT IN PLACE rather than dropped — it is now a second layer rather than the
-- only one, and it still requires ownership if INSERT is ever re-granted.
-- DELETE: no DELETE policy exists, so RLS already refused it; the revoke removes
-- the standing privilege as well.
--
-- ── WHAT THIS DOES NOT CHANGE ───────────────────────────────────────────────
-- No application code path. Every server write to this table uses the
-- service-role client (routes/hiddenGems.ts obtains getServiceClient() and passes
-- it in), which bypasses RLS and column grants alike. applyForGuide,
-- recordContribution, recomputeGuideAccuracy and setGuideStatus are unaffected.
-- No client writes this table directly: the standalone app calls
-- POST /api/hidden-gems/guides/apply and never references the table.
--
-- No column, table, enum or index changes — generated types and the live-columns
-- snapshot are untouched.
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

  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema='public' AND table_name='local_guide_profiles'
         AND column_name IN ('bio','city_expertise','user_id')) <> 3 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: expected bio, city_expertise and user_id on local_guide_profiles — the self-editable column set and the ownership predicate depend on them.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname='public' AND tablename='local_guide_profiles' AND policyname='lgp_public_read'
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: lgp_public_read is absent. SELECT is granted back to anon on the assumption that this policy is the public guide directory; without it, re-granting anon SELECT would need re-deriving.';
  END IF;
END $$;

-- ── 1. Narrow the verbs, for BOTH client roles ──────────────────────────────
REVOKE ALL ON TABLE public.local_guide_profiles FROM anon;
REVOKE ALL ON TABLE public.local_guide_profiles FROM authenticated;

-- ── 2. Reads stay open; lgp_public_read / lgp_own_read still decide the rows ─
GRANT SELECT ON TABLE public.local_guide_profiles TO anon;
GRANT SELECT ON TABLE public.local_guide_profiles TO authenticated;

-- ── 3. The only client-writable fields ──────────────────────────────────────
GRANT UPDATE (bio, city_expertise) ON TABLE public.local_guide_profiles TO authenticated;

-- ── 4. Close the WITH CHECK gap ─────────────────────────────────────────────
DROP POLICY IF EXISTS "lgp_own_update" ON public.local_guide_profiles;
CREATE POLICY "lgp_own_update" ON public.local_guide_profiles
  FOR UPDATE TO authenticated
  USING      (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

COMMENT ON TABLE public.local_guide_profiles IS
  'Guide profile. guide_level, accuracy_score, helpful_votes, contribution_count, '
  'status and verified_at are DERIVED or ADJUDICATED server-side and are NOT '
  'client-writable (2144): anon and authenticated hold SELECT only, plus '
  'column-level UPDATE on bio and city_expertise for authenticated. Server paths '
  'use the service-role client and are unaffected.';

-- ── Postconditions ──────────────────────────────────────────────────────────
DO $$
DECLARE
  anon_privs text;
  auth_privs text;
  writable   text;
  wc         text;
BEGIN
  SELECT COALESCE(string_agg(DISTINCT privilege_type, ',' ORDER BY privilege_type), '')
    INTO anon_privs FROM information_schema.role_table_grants
   WHERE table_schema='public' AND table_name='local_guide_profiles' AND grantee='anon';
  IF anon_privs <> 'SELECT' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: anon holds "%", expected SELECT only', anon_privs;
  END IF;

  SELECT COALESCE(string_agg(DISTINCT privilege_type, ',' ORDER BY privilege_type), '')
    INTO auth_privs FROM information_schema.role_table_grants
   WHERE table_schema='public' AND table_name='local_guide_profiles' AND grantee='authenticated';
  IF auth_privs <> 'SELECT' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: authenticated holds table-level "%", expected SELECT only', auth_privs;
  END IF;

  SELECT COALESCE(string_agg(column_name, ',' ORDER BY column_name), '')
    INTO writable FROM information_schema.column_privileges
   WHERE table_schema='public' AND table_name='local_guide_profiles'
     AND grantee='authenticated' AND privilege_type='UPDATE';
  IF writable <> 'bio,city_expertise' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: client-updatable columns are "%", expected exactly bio,city_expertise', writable;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.column_privileges
     WHERE table_schema='public' AND table_name='local_guide_profiles'
       AND grantee='anon' AND privilege_type='UPDATE'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: anon retains a column-level UPDATE grant.';
  END IF;

  SELECT pg_get_expr(p.polwithcheck, p.polrelid) INTO wc
    FROM pg_policy p
   WHERE p.polrelid = 'public.local_guide_profiles'::regclass AND p.polname = 'lgp_own_update';
  IF wc IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: lgp_own_update still has no WITH CHECK — user_id is writable, so a row could be re-pointed at another user mid-update.';
  END IF;

  -- The public directory must survive.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
     WHERE table_schema='public' AND table_name='local_guide_profiles'
       AND grantee='anon' AND privilege_type='SELECT'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: anon lost SELECT — the public guide directory would break.';
  END IF;
END $$;

COMMIT;
