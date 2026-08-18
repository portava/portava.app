-- 2101_drop_mismatched_public_read_policies.sql
--
-- STATUS: STAGED — NOT APPLIED. Lives in reconciliation-staging/, outside the
-- canonical tree. See ../README.md for the run-order manifest and gating.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- BLOCKED ON: Q3 (policies with predicates; RECONCILIATION-PACKET.md §4.1)
--
-- Q3 must confirm that the four policy names this file drops are actually
-- live, with the predicates below, before this file runs.
--
-- ROLLBACK NOT DERIVABLE FROM THIS REPOSITORY. Per §8 item 9d: capture Q3's
-- exact live output for user_follows, profiles, and passport_postcards
-- before applying. This file's own header quotes what the repo SAYS these
-- policies are (verbatim, from artifacts/api-server/migration.sql), but that
-- is a repo claim, not a live capture — §9 open question 2 documents repo
-- "applied" claims being wrong in both directions in this exact project. Do
-- not treat the quoted text below as a substitute for capturing live text
-- immediately before running this file.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT THIS RESOLVES
-- ==================
-- RECONCILIATION-PACKET.md §3.4(2) and §7 row 2101 — DISJOINT_POLICY_FAMILY.
-- `artifacts/api-server/migration.sql` (a loose, ungoverned file — see
-- packet §2.2/§2.3) declares a policy family on three tables that canonical
-- never named and therefore never dropped:
--
--   user_follows          "Follows are viewable by authenticated users"
--                          (migration.sql:60-61) — FOR SELECT TO authenticated
--                          USING (true). Any authenticated user can read
--                          every row in user_follows.
--
--   profiles               "Public profiles are viewable" (migration.sql:71-75)
--                          — FOR SELECT USING
--                          (passport_visibility = 'public' OR auth.uid() = id)
--                          This one is NOT USING(true) — it already carries a
--                          visibility predicate, unlike the packet's summary
--                          language ("USING (true)") suggested at a glance.
--                          Verified by direct read: the predicate is real and
--                          not obviously wrong on its own. What makes it a
--                          convergence target anyway is that it is a THIRD,
--                          differently-named profiles policy family that
--                          canonical's 2033_rls_hardening.sql does not know
--                          about and cannot have superseded (see below).
--
--   passport_postcards     "Owner can manage own postcards" (FOR ALL,
--                          USING auth.uid() = user_id, migration.sql:84-86)
--                          and "Public postcards visible to all" (FOR SELECT,
--                          migration.sql:89-98) — USING status='active' AND
--                          visibility='public' AND EXISTS (a profiles join on
--                          passport_visibility='public').
--
-- Canonical's 2033_rls_hardening.sql drops DIFFERENT names entirely —
-- "follows_select", "user_follows_hide_blocked" (2033:515-522, user_follows)
-- and "profiles_hide_blocked" (2033:485, profiles) — and never references
-- `passport_postcards` or any of the four names above at all (grepped, zero
-- matches). DROP POLICY's identity is the name; a DROP with the wrong name
-- is a no-op, so 2033 believed it closed this surface and could not have.
--
-- WHY THIS IS SAFE TO WRITE (BUT NOT YET SAFE TO RUN)
-- =====================================================
-- Every policy this file drops has USING(true)-or-broader semantics on at
-- least the SELECT side (user_follows: unconditionally; passport_postcards
-- public-read: gated only on the row's own public/active flags, not on the
-- requester), except profiles' "Public profiles are viewable" which is
-- narrower than the others but still a name canonical's model does not
-- track. Dropping all four and relying on canonical's already-declared
-- 2033 policies removes reachable surface area; it does not add any. No
-- policy canonical's model wants is touched — this migration only removes
-- names outside that model.
--
-- INTENDED FINAL STATE
-- =====================
-- Zero policies remain under any of the four names below on user_follows,
-- profiles, or passport_postcards. Canonical's own 2033-era policies
-- ("follows_select", "user_follows_hide_blocked", "profiles_hide_blocked",
-- and whatever canonical declares for passport_postcards elsewhere) are
-- UNCHANGED by this file — this migration only removes the disjoint family,
-- it does not touch canonical's declared policies.

BEGIN;

-- ── Precondition ─────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.user_follows') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.user_follows does not exist live.';
  END IF;
  IF to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.profiles does not exist live.';
  END IF;
  IF to_regclass('public.passport_postcards') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.passport_postcards does not exist live.';
  END IF;

  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.user_follows'::regclass) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: user_follows does not have RLS enabled live.';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.profiles'::regclass) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: profiles does not have RLS enabled live.';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.passport_postcards'::regclass) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: passport_postcards does not have RLS enabled live.';
  END IF;

  -- This migration is a pure DROP of specific names. It does not require the
  -- four names to exist (IF EXISTS below), but it DOES require that
  -- canonical's own policies remain intact under the names 2033 uses, so a
  -- read path is not left with zero SELECT policies if the four drop.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'user_follows'
      AND policyname = 'follows_select'
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: canonical policy "follows_select" is not live on user_follows. Dropping the migration.sql family without a surviving canonical SELECT policy would leave user_follows unreadable by any role except service_role — investigate before proceeding.';
  END IF;
END $$;

-- ── The change ───────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Follows are viewable by authenticated users" ON public.user_follows;       -- migration.sql:60
DROP POLICY IF EXISTS "Public profiles are viewable"                ON public.profiles;             -- migration.sql:71
DROP POLICY IF EXISTS "Owner can manage own postcards"               ON public.passport_postcards;   -- migration.sql:84
DROP POLICY IF EXISTS "Public postcards visible to all"              ON public.passport_postcards;   -- migration.sql:89

COMMENT ON TABLE public.user_follows IS
  'Mis-named public-read policy family from artifacts/api-server/migration.sql dropped 2101; canonical family (follows_select, user_follows_hide_blocked, from 2033_rls_hardening.sql) is the sole surviving policy set.';

COMMENT ON TABLE public.passport_postcards IS
  'Mis-named policy family from artifacts/api-server/migration.sql dropped 2101 — this table had NO canonical policies at all before this file (2033 never references it); a canonical-owned family must be authored separately once Q3 confirms what remains readable.';

-- ── Postcondition ────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'user_follows'
      AND policyname = 'Follows are viewable by authenticated users'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: the dropped user_follows policy is still present.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'profiles'
      AND policyname = 'Public profiles are viewable'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: the dropped profiles policy is still present.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'passport_postcards'
      AND policyname IN ('Owner can manage own postcards', 'Public postcards visible to all')
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: a dropped passport_postcards policy is still present.';
  END IF;

  -- user_follows must still be readable by SOME policy after this drop.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'user_follows' AND cmd IN ('SELECT', 'ALL')
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: user_follows has no surviving SELECT policy — this migration would have made the table unreadable by anon/authenticated.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'service_role' AND rolbypassrls
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: service_role no longer has BYPASSRLS.';
  END IF;
END $$;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- ROLLBACK
-- ═══════════════════════════════════════════════════════════════════════════
-- Cannot be written here — see the BLOCKED ON banner. Once Q3's pre-apply
-- capture exists for user_follows, profiles, and passport_postcards, the
-- rollback is CREATE POLICY of each dropped name using the CAPTURED live
-- text. The text quoted in this file's header (from migration.sql) is
-- provided for cross-reference only, to speed up recognizing the captured
-- output — it must not be pasted back in as the rollback without confirming
-- it against what Q3 actually returns for these four names.

-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFICATION (run after apply)
-- ═══════════════════════════════════════════════════════════════════════════
-- Expect zero rows:
--   SELECT tablename, policyname FROM pg_policies
--    WHERE schemaname = 'public'
--      AND policyname IN ('Follows are viewable by authenticated users',
--                          'Public profiles are viewable',
--                          'Owner can manage own postcards',
--                          'Public postcards visible to all');
--
-- Confirm user_follows, profiles still have a surviving canonical SELECT
-- policy each, and passport_postcards' remaining policy surface (if any) is
-- reviewed as its own follow-up — this file leaves it with none.
