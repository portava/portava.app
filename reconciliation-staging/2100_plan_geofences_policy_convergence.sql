-- 2100_plan_geofences_policy_convergence.sql
--
-- STATUS: STAGED — NOT APPLIED. Lives in reconciliation-staging/, outside the
-- canonical tree, precisely so that dropping this file in does not make
-- audit:schema red or imply it is ready to run. See ../README.md for the
-- run-order manifest and full gating.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- BLOCKED ON: Q3 (policies with predicates — pg_get_expr(polqual),
--             pg_get_expr(polwithcheck), roles; RECONCILIATION-PACKET.md §4.1)
--
-- Q3 must confirm, for table plan_geofences: which of the three disjoint
-- policy families below are actually live right now, verbatim, predicate by
-- predicate. RLS policies OR together, so if more than one family survived
-- whatever merge produced the live schema, ALL of them are simultaneously in
-- effect and this file's DROP/CREATE list must match exactly what Q3 finds,
-- not what any one file here claims.
--
-- ROLLBACK NOT DERIVABLE FROM THIS REPOSITORY. Per the packet's rollback
-- section (§8, item 9d): "Capture Q3's exact output for the affected tables
-- immediately before applying, and pre-write the CREATE POLICY statements
-- that reconstruct them verbatim. This is the rollback script — it cannot be
-- written from the repo, only from live." The precondition block below
-- guards against the file being applied against a shape it does not expect,
-- but a guard that aborts safely is not the same thing as a rollback for a
-- policy that WAS successfully dropped. Do not run this file until:
--   1. Q3 has returned for plan_geofences, and
--   2. the exact live CREATE POLICY text for every policy this file would
--      drop has been captured and is ready to re-apply if needed.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT THIS RESOLVES
-- ==================
-- RECONCILIATION-PACKET.md §3.4(1) and §7 row 2100 — DISJOINT_POLICY_FAMILY,
-- highest-priority item in the packet because it may be an open live defect,
-- not merely drift.
--
-- Three disjoint policy names exist across the three merged trees, and
-- because Postgres RLS policies OR together, any subset of them that
-- survived the merge is simultaneously in force:
--
--   canonical  0035_plan_geofences.sql:21-27
--     "trip_members_manage_geofences" FOR ALL, USING only
--       EXISTS (SELECT 1 FROM trip_members tm
--               WHERE tm.trip_id = plan_geofences.trip_id
--                 AND tm.user_id = auth.uid())
--     No role restriction, no WITH CHECK, and the join does not filter on
--     trip_members.role or any acceptance/invite state — ANY row in
--     trip_members for this trip, including a pending/invited member,
--     satisfies it. FOR ALL means this also grants INSERT/UPDATE/DELETE.
--
--   legacy (frozen, artifacts/api-server/migrations/0038_plan_geofences_rls_fix.sql:12-33)
--     Written specifically to close the read side of this hole. Drops
--     "pgf_select_member" (a name canonical never used — so this DROP is a
--     no-op against canonical's family and cannot have retired it) and
--     creates "pgf_select_accepted": SELECT-only, USING
--       trips.owner_id = auth.uid()
--       OR EXISTS (SELECT 1 FROM trip_members tm
--                  WHERE tm.trip_id = trips.id
--                    AND tm.user_id = auth.uid()
--                    AND tm.role = 'member')
--     i.e. trip owner or an ACCEPTED member (role = 'member') only.
--
--   root (migrations/0035_plan_geofences.sql:22-28)
--     A third, independent pair: "plan_geofences_trip_members" FOR ALL,
--     unfiltered (same shape as canonical's, different name), plus
--     "plan_geofences_service" FOR ALL TO service_role USING (true).
--
-- IF all three families are simultaneously live: 0038's SELECT-only
-- hardening is defeated by whichever unfiltered FOR ALL family (canonical's
-- or root's, or both) also survived, and — because FOR ALL grants writes —
-- an invited-but-not-yet-accepted trip member could additionally
-- INSERT/UPDATE/DELETE geofences that trigger location-based notifications
-- for other members. This migration exists to make that impossible
-- regardless of which subset Q3 finds live, by converging on ONE explicit
-- family covering every command.
--
-- WHY THIS IS SAFE TO WRITE (BUT NOT YET SAFE TO RUN)
-- =====================================================
-- Strictly tightening: the target state is a strict narrowing of what any of
-- the three source families individually grant. DROP ... IF EXISTS no-ops on
-- a name that isn't live. The new INSERT/UPDATE/DELETE policies are new
-- restrictions where today there is either an unfiltered FOR ALL (too wide)
-- or nothing explicit at all (relying on the FOR ALL family for writes).
--
-- INTENDED FINAL STATE
-- =====================
-- One SELECT policy restricted to trip owner + accepted members (restores
-- legacy 0038's intent, expressed under a name canonical will own). Explicit
-- INSERT/UPDATE/DELETE policies scoped to trip owner + accepted members only
-- — closing the write path that canonical's FOR ALL opened and that 0038
-- never addressed (0038 only ever touched SELECT). service_role keeps
-- unrestricted access via BYPASSRLS, not via a policy — Supabase's
-- service_role bypasses RLS entirely, so no service_role policy is needed
-- here (unlike the root tree's belt-and-braces "plan_geofences_service"
-- policy, which is redundant with BYPASSRLS and is not recreated).

BEGIN;

-- ── Precondition ─────────────────────────────────────────────────────────
-- Abort if the table, or the columns this migration's policies depend on,
-- do not match what every source file above assumes. This is a safety net
-- for drift the repo cannot see — it is NOT a substitute for Q3.
DO $$
BEGIN
  IF to_regclass('public.plan_geofences') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.plan_geofences does not exist live. This migration assumes the table from 0035_plan_geofences.sql is live; re-derive from Q1 before proceeding.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'plan_geofences' AND column_name = 'trip_id'
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: plan_geofences.trip_id is missing live. Every source policy family joins on this column.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'trip_members' AND column_name = 'role'
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: trip_members.role is missing live. The accepted-member predicate (role = ''member'') depends on it.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'trips' AND column_name = 'owner_id'
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: trips.owner_id is missing live. The trip-owner predicate depends on it.';
  END IF;

  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.plan_geofences'::regclass) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: plan_geofences does not have RLS enabled live. This migration only converges policies, it does not enable RLS — re-derive from Q1.';
  END IF;
END $$;

-- ── The change ───────────────────────────────────────────────────────────
-- Drop every name any tree used for this table's member-facing policies.
-- IF EXISTS makes each a no-op for whichever names are not actually live.
DROP POLICY IF EXISTS "trip_members_manage_geofences" ON public.plan_geofences; -- canonical 0035:21
DROP POLICY IF EXISTS "pgf_select_member"              ON public.plan_geofences; -- legacy pre-0038 name (0038 already drops this; repeated for idempotency)
DROP POLICY IF EXISTS "pgf_select_accepted"             ON public.plan_geofences; -- legacy 0038:19 — recreated below under canonical ownership
DROP POLICY IF EXISTS "plan_geofences_trip_members"     ON public.plan_geofences; -- root 0035:22
DROP POLICY IF EXISTS "plan_geofences_service"          ON public.plan_geofences; -- root 0035:26 — redundant with service_role BYPASSRLS, not recreated

CREATE POLICY "plan_geofences_select_accepted" ON public.plan_geofences
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM trips
      WHERE trips.id = plan_geofences.trip_id
        AND (
          trips.owner_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM trip_members tm
            WHERE tm.trip_id = trips.id
              AND tm.user_id = auth.uid()
              AND tm.role = 'member'
          )
        )
    )
  );

CREATE POLICY "plan_geofences_insert_accepted" ON public.plan_geofences
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM trips
      WHERE trips.id = plan_geofences.trip_id
        AND (
          trips.owner_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM trip_members tm
            WHERE tm.trip_id = trips.id
              AND tm.user_id = auth.uid()
              AND tm.role = 'member'
          )
        )
    )
  );

CREATE POLICY "plan_geofences_update_accepted" ON public.plan_geofences
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM trips
      WHERE trips.id = plan_geofences.trip_id
        AND (
          trips.owner_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM trip_members tm
            WHERE tm.trip_id = trips.id
              AND tm.user_id = auth.uid()
              AND tm.role = 'member'
          )
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM trips
      WHERE trips.id = plan_geofences.trip_id
        AND (
          trips.owner_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM trip_members tm
            WHERE tm.trip_id = trips.id
              AND tm.user_id = auth.uid()
              AND tm.role = 'member'
          )
        )
    )
  );

CREATE POLICY "plan_geofences_delete_owner" ON public.plan_geofences
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM trips
      WHERE trips.id = plan_geofences.trip_id
        AND trips.owner_id = auth.uid()
    )
  );

COMMENT ON TABLE public.plan_geofences IS
  'Policy family converged 2100: single owner+accepted-member family across SELECT/INSERT/UPDATE, owner-only DELETE. Replaces three disjoint FOR ALL/SELECT families merged from canonical 0035, legacy 0038, and root 0035. See RECONCILIATION-PACKET.md §3.4(1), §7.';

-- ── Postcondition ────────────────────────────────────────────────────────
DO $$
DECLARE
  policy_count int;
BEGIN
  SELECT count(*) INTO policy_count
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'plan_geofences';

  IF policy_count <> 4 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: expected exactly 4 policies on plan_geofences after convergence, found %', policy_count;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'plan_geofences'
      AND policyname IN ('trip_members_manage_geofences', 'pgf_select_member',
                          'plan_geofences_trip_members', 'plan_geofences_service')
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: a superseded policy name is still present on plan_geofences.';
  END IF;

  -- service_role must retain BYPASSRLS — this migration must never touch
  -- role attributes. Confirm the assumption it relies on rather than the
  -- table grants, since service_role's access here is via BYPASSRLS, not a
  -- table grant or a policy.
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'service_role' AND rolbypassrls
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: service_role no longer has BYPASSRLS. This migration assumed that property and did not intend to change it — investigate before relying on this table''s access model.';
  END IF;
END $$;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- ROLLBACK
-- ═══════════════════════════════════════════════════════════════════════════
-- Cannot be written here — see the BLOCKED ON banner above. Once Q3's
-- pre-apply capture exists, the rollback is: drop the four policies created
-- above, then CREATE POLICY each captured live policy verbatim from that
-- capture. A best-effort reconstruction from repo text alone (e.g.
-- recreating canonical's "trip_members_manage_geofences" exactly as written
-- in 0035:21-27) is NOT a substitute: it would restore what the FILE says,
-- not what was actually LIVE immediately before this migration ran, and
-- those may differ. Do not use repo text as the rollback.

-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFICATION (run after apply, against the target database)
-- ═══════════════════════════════════════════════════════════════════════════
-- Expect exactly 4 rows, the four names created above:
--   SELECT policyname, cmd, qual, with_check
--     FROM pg_policies
--    WHERE schemaname = 'public' AND tablename = 'plan_geofences'
--    ORDER BY policyname;
--
-- Expect zero rows (no superseded name survives):
--   SELECT policyname FROM pg_policies
--    WHERE schemaname = 'public' AND tablename = 'plan_geofences'
--      AND policyname IN ('trip_members_manage_geofences', 'pgf_select_member',
--                          'plan_geofences_trip_members', 'plan_geofences_service');
--
-- Manual read-path check: as a pending (non-'member'-role) trip_members row,
-- confirm SELECT/INSERT/UPDATE/DELETE against plan_geofences for that trip
-- all return zero rows / are rejected by RLS.
