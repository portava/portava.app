-- 2118b_passport_stamps_policy_convergence.sql
--
-- STATUS: STAGED — NOT APPLIED. reconciliation-staging/, outside canonical.
--
-- Split out of 2118 — see that file's header for why. This is the
-- materially-riskier item of the packet's original four-table 2118 group.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- BLOCKED ON: Q2 (column shape — specifically, does `visibility` exist on
--             live `passport_stamps`), Q3 (policies with predicates)
--
-- ROLLBACK NOT DERIVABLE FROM THIS REPOSITORY for the DROPs (§8 item 9d) —
-- Q3's captured live text is the rollback.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHY THIS IS SPLIT AND WHY IT IS RISKIER
-- ==========================================
-- Three families across canonical/legacy/root, direct-read verified:
--
--   canonical (0042_passport_stamps.sql:17-18): `users_view_own_stamps`
--     (SELECT, auth.uid()=user_id), `users_insert_own_stamp` (INSERT,
--     auth.uid()=user_id). Canonical's own `CREATE TABLE passport_stamps`
--     has NO `visibility` column at all — id, user_id, stamp_type, country,
--     city, earned_at only.
--   legacy (artifacts/api-server/migrations/0042): `passport_stamps_owner_read`
--     (SELECT, auth.uid()=user_id), `passport_stamps_public_read` (SELECT,
--     visibility = 'public'), `passport_stamps_service_write` (FOR ALL,
--     auth.role() = 'service_role'). Legacy's OWN table declares
--     `visibility text NOT NULL DEFAULT 'public' CHECK (...)` — this family
--     depends on a column only this tree creates.
--   root: `passport_stamps_own` (FOR ALL, auth.uid()=user_id),
--     `passport_stamps_service` (FOR ALL TO service_role, true). Root's own
--     table has no `visibility` column either, and uses `awarded_at` where
--     canonical/legacy use `earned_at` (a column-naming difference this file
--     does not touch — out of scope, policy-layer only).
--
-- THE RISK, PRECISELY: unlike every other policy-touching file in this
-- package, one candidate policy here (`passport_stamps_public_read`)
-- references a column that TWO OF THREE trees' own `CREATE TABLE` never
-- declare. If canonical's or root's shape is what is actually live (no
-- `visibility` column), `passport_stamps_public_read` as legacy wrote it
-- could never have been created successfully in the first place — a
-- `CREATE POLICY ... USING (visibility = 'public')` against a table without
-- that column raises `column "visibility" does not exist` at creation time,
-- not at query time. So this policy's mere presence in a frozen file is not
-- evidence it is live, in a way that is NOT true of this package's other
-- policy-convergence files. This file's precondition checks for the column
-- before doing anything with that policy, and its behavior branches
-- accordingly rather than assuming either answer.
--
-- INTENDED FINAL STATE
-- =====================
-- `passport_stamps_select_own` (SELECT, owner) and
-- `passport_stamps_insert_own` (INSERT, owner) always. If `visibility`
-- exists live, `passport_stamps_public_read` (visibility = 'public') is
-- also created — matching legacy's intent, under canonical ownership. If
-- `visibility` does not exist, no public-read policy is created, matching
-- canonical's own (narrower) model, and the file logs that explicitly
-- rather than silently doing nothing. No UPDATE/DELETE policy for the
-- owner is created — none of the three trees' minimal/canonical-facing
-- families granted it, and stamps are treated as owner-readable,
-- owner-insertable, not owner-editable, consistent with canonical's own
-- (most conservative) model. No service_role policy recreated — redundant
-- with BYPASSRLS, consistent with this package's convention elsewhere.

BEGIN;

-- ── Precondition ─────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.passport_stamps') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.passport_stamps does not exist live.';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.passport_stamps'::regclass) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: passport_stamps does not have RLS enabled live.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'passport_stamps' AND column_name = 'user_id'
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: passport_stamps.user_id does not exist live.';
  END IF;
END $$;

-- ── The change ───────────────────────────────────────────────────────────
DROP POLICY IF EXISTS users_view_own_stamps         ON public.passport_stamps;
DROP POLICY IF EXISTS users_insert_own_stamp        ON public.passport_stamps;
DROP POLICY IF EXISTS passport_stamps_owner_read    ON public.passport_stamps;
DROP POLICY IF EXISTS passport_stamps_public_read   ON public.passport_stamps;
DROP POLICY IF EXISTS passport_stamps_service_write ON public.passport_stamps;
DROP POLICY IF EXISTS passport_stamps_own           ON public.passport_stamps;
DROP POLICY IF EXISTS passport_stamps_service       ON public.passport_stamps;

CREATE POLICY passport_stamps_select_own ON public.passport_stamps
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY passport_stamps_insert_own ON public.passport_stamps
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'passport_stamps' AND column_name = 'visibility'
  ) THEN
    EXECUTE $p$CREATE POLICY passport_stamps_public_read ON public.passport_stamps
      FOR SELECT USING (visibility = 'public')$p$;
    RAISE NOTICE '2118b: visibility column present — passport_stamps_public_read created.';
  ELSE
    RAISE NOTICE '2118b: visibility column absent live — no public-read policy created, matching canonical''s own narrower model. legacy''s passport_stamps_public_read could not have been live under this shape.';
  END IF;
END $$;

COMMENT ON TABLE public.passport_stamps IS
  '2118b: policy family converged onto owner-scoped SELECT/INSERT, plus a conditional public-read policy present only if the visibility column exists live. No UPDATE/DELETE granted to the owner; no service_role policy recreated (redundant with BYPASSRLS).';

-- ── Postcondition ────────────────────────────────────────────────────────
DO $$
DECLARE
  expected_count int;
  has_visibility boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'passport_stamps' AND column_name = 'visibility'
  ) INTO has_visibility;

  expected_count := CASE WHEN has_visibility THEN 3 ELSE 2 END;

  IF (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='passport_stamps') <> expected_count THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: expected % policies on passport_stamps (visibility column present = %), found a different count.', expected_count, has_visibility;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='passport_stamps'
      AND policyname IN ('users_view_own_stamps', 'users_insert_own_stamp', 'passport_stamps_owner_read',
                          'passport_stamps_service_write', 'passport_stamps_own', 'passport_stamps_service')
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: a superseded policy name is still present.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'service_role' AND rolbypassrls
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: service_role no longer has BYPASSRLS — nothing would be able to write awarded stamps.';
  END IF;
END $$;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- ROLLBACK
-- ═══════════════════════════════════════════════════════════════════════════
-- Cannot be written here — see BLOCKED ON banner. Once Q2 confirms the
-- visibility-column answer and Q3's pre-apply capture exists for whichever
-- of the superseded names above were actually live, the rollback is CREATE
-- POLICY of each captured name/predicate, verbatim, plus:
--   DROP POLICY IF EXISTS passport_stamps_select_own  ON public.passport_stamps;
--   DROP POLICY IF EXISTS passport_stamps_insert_own  ON public.passport_stamps;
--   DROP POLICY IF EXISTS passport_stamps_public_read ON public.passport_stamps;

-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFICATION (run after apply)
-- ═══════════════════════════════════════════════════════════════════════════
-- SELECT policyname, cmd, qual FROM pg_policies
--  WHERE schemaname = 'public' AND tablename = 'passport_stamps';
-- SELECT EXISTS (SELECT 1 FROM information_schema.columns
--   WHERE table_name='passport_stamps' AND column_name='visibility') AS has_visibility;
