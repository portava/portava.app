-- 2143_plan_geofences_policy_convergence.sql
--
-- Promotes reconciliation-staging/2100_plan_geofences_policy_convergence.sql
-- into the canonical tree, with its Q3 blocker resolved and one real defect in
-- it fixed. POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- ── WHY 2143 AND NOT 2100 ───────────────────────────────────────────────────
-- 2100-2118b is the reserved reconciliation-staging band, which Phase-0 already
-- collided with once (2100-2102/2109 were renumbered to 2120-2123). 2142 is the
-- highest canonical prefix in use, so this is 2143.
--
-- ── THE PROBLEM ─────────────────────────────────────────────────────────────
-- public.plan_geofences carried THREE disjoint RLS policy families across the
-- canonical migration, CI, and production. RLS policies OR together, so every
-- family that survived a merge is simultaneously in force. RECONCILIATION-PACKET.md
-- §3.4(1) calls this its highest-priority item: possibly an open live defect
-- rather than mere drift.
--
--   src/migrations/0035  trip_members_manage_geofences — ONE policy, FOR ALL,
--                        granting any trip member full control including DELETE.
--   CI                   plan_geofences_{select,insert,update}_accepted
--                        + plan_geofences_delete_owner
--   PRODUCTION           pgf_{select,insert,update,delete}_accepted
--                        + plan_geofences_service [ALL]
--
-- ── WHAT Q3 ACTUALLY FOUND (captured read-only 2026-08-23) ──────────────────
-- Compared at PREDICATE level, not by policy name. SELECT/INSERT/UPDATE are
-- byte-identical on both environments:
--
--   EXISTS (SELECT 1 FROM trips
--            WHERE trips.id = plan_geofences.trip_id
--              AND (trips.owner_id = auth.uid()
--                   OR EXISTS (SELECT 1 FROM trip_members tm
--                               WHERE tm.trip_id = trips.id
--                                 AND tm.user_id = auth.uid()
--                                 AND tm.role = 'member'::member_role)))
--
-- DELETE is the only substantive difference, and PRODUCTION IS LOOSER:
--   production  pgf_delete_accepted        → owner OR member with role='member'
--   CI          plan_geofences_delete_owner → trip owner ONLY
--
-- ── THE DEFECT THIS FIXES IN THE STAGED FILE ────────────────────────────────
-- 2100's DROP list was written before Q3 and names only
-- pgf_select_accepted among the pgf_* family. Production also carries
-- pgf_insert_accepted, pgf_update_accepted and pgf_delete_accepted. Applying
-- 2100 verbatim to production would leave those three in force ALONGSIDE the
-- four new ones — seven policies, ORed together, so the looser DELETE would
-- SURVIVE THE CONVERGENCE ENTIRELY and the file's own "exactly 4" postcondition
-- would fail after the change had already been made. The DROP list below covers
-- every name observed in either environment.
--
-- ── WHY TIGHTENING DELETE IS SAFE ───────────────────────────────────────────
-- Verified against the code, not assumed: NOTHING in src/ deletes a
-- plan_geofences row. There is no DELETE endpoint and no .delete() call on the
-- table anywhere; every geofence route is POST or GET. The API also uses the
-- service-role client, which bypasses RLS altogether. So this policy governs
-- only direct PostgREST access with a user JWT, and tightening it cannot break
-- an application flow because no application flow deletes these rows.
-- plan_geofences is also empty on production (0 rows) at time of writing.
--
-- ── ROLES ───────────────────────────────────────────────────────────────────
-- Bound TO authenticated rather than left to PUBLIC. The predicate already
-- requires auth.uid() to match, so anon could never satisfy it, but binding the
-- role makes that explicit instead of incidental. This also tightens CI, whose
-- policies are currently bound to public.
--
-- plan_geofences_service is dropped and NOT recreated: service_role bypasses RLS
-- unconditionally, so a permissive ALL policy for it grants nothing it did not
-- already have.
--
-- SAFE TO RE-RUN. Every DROP is IF EXISTS and every CREATE follows a DROP.

BEGIN;

-- ── Preconditions ───────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.plan_geofences') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.plan_geofences does not exist.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='plan_geofences' AND column_name='trip_id'
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: plan_geofences.trip_id is missing. Every predicate depends on it.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='trips' AND column_name='owner_id'
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: trips.owner_id is missing. The trip-owner predicate depends on it.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='trip_members' AND column_name='role'
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: trip_members.role is missing. The accepted-member predicate depends on it.';
  END IF;

  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.plan_geofences'::regclass) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: RLS is not enabled on plan_geofences. This migration converges policies; it does not enable RLS.';
  END IF;
END $$;

-- ── Drop every name observed in ANY tree or environment ─────────────────────
-- IF EXISTS makes each a no-op wherever that name is not live.
DROP POLICY IF EXISTS "trip_members_manage_geofences"  ON public.plan_geofences; -- canonical 0035:21 (FOR ALL, any member)
DROP POLICY IF EXISTS "plan_geofences_trip_members"    ON public.plan_geofences; -- root 0035:22
DROP POLICY IF EXISTS "pgf_select_member"              ON public.plan_geofences; -- legacy pre-0038
DROP POLICY IF EXISTS "pgf_select_accepted"            ON public.plan_geofences; -- legacy 0038:19 / live PROD
DROP POLICY IF EXISTS "pgf_insert_accepted"            ON public.plan_geofences; -- live PROD — MISSING from staged 2100
DROP POLICY IF EXISTS "pgf_update_accepted"            ON public.plan_geofences; -- live PROD — MISSING from staged 2100
DROP POLICY IF EXISTS "pgf_delete_accepted"            ON public.plan_geofences; -- live PROD — MISSING from staged 2100; this is the looser DELETE
DROP POLICY IF EXISTS "plan_geofences_service"         ON public.plan_geofences; -- redundant with service_role BYPASSRLS
-- Converged names, dropped so this file is idempotent on CI where they already exist.
DROP POLICY IF EXISTS "plan_geofences_select_accepted" ON public.plan_geofences;
DROP POLICY IF EXISTS "plan_geofences_insert_accepted" ON public.plan_geofences;
DROP POLICY IF EXISTS "plan_geofences_update_accepted" ON public.plan_geofences;
DROP POLICY IF EXISTS "plan_geofences_delete_owner"    ON public.plan_geofences;

-- ── The converged family ────────────────────────────────────────────────────
CREATE POLICY "plan_geofences_select_accepted" ON public.plan_geofences
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM trips
       WHERE trips.id = plan_geofences.trip_id
         AND (trips.owner_id = auth.uid()
              OR EXISTS (SELECT 1 FROM trip_members tm
                          WHERE tm.trip_id = trips.id
                            AND tm.user_id = auth.uid()
                            AND tm.role = 'member'::member_role))
    )
  );

CREATE POLICY "plan_geofences_insert_accepted" ON public.plan_geofences
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM trips
       WHERE trips.id = plan_geofences.trip_id
         AND (trips.owner_id = auth.uid()
              OR EXISTS (SELECT 1 FROM trip_members tm
                          WHERE tm.trip_id = trips.id
                            AND tm.user_id = auth.uid()
                            AND tm.role = 'member'::member_role))
    )
  );

CREATE POLICY "plan_geofences_update_accepted" ON public.plan_geofences
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM trips
       WHERE trips.id = plan_geofences.trip_id
         AND (trips.owner_id = auth.uid()
              OR EXISTS (SELECT 1 FROM trip_members tm
                          WHERE tm.trip_id = trips.id
                            AND tm.user_id = auth.uid()
                            AND tm.role = 'member'::member_role))
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM trips
       WHERE trips.id = plan_geofences.trip_id
         AND (trips.owner_id = auth.uid()
              OR EXISTS (SELECT 1 FROM trip_members tm
                          WHERE tm.trip_id = trips.id
                            AND tm.user_id = auth.uid()
                            AND tm.role = 'member'::member_role))
    )
  );

-- Owner-only. This is the one substantive tightening; see the safety note above.
CREATE POLICY "plan_geofences_delete_owner" ON public.plan_geofences
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM trips
       WHERE trips.id = plan_geofences.trip_id
         AND trips.owner_id = auth.uid()
    )
  );

COMMENT ON TABLE public.plan_geofences IS
  'Policy family converged by 2143: one owner+accepted-member family across '
  'SELECT/INSERT/UPDATE, owner-only DELETE, all bound TO authenticated. Replaces '
  'three disjoint families (canonical 0035 FOR ALL, legacy/prod pgf_*, CI '
  'plan_geofences_*). See RECONCILIATION-PACKET.md §3.4(1), §7.';

-- ── Postconditions ──────────────────────────────────────────────────────────
DO $$
DECLARE
  n int;
  delete_qual text;
BEGIN
  SELECT count(*) INTO n
    FROM pg_policies WHERE schemaname='public' AND tablename='plan_geofences';
  IF n <> 4 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: expected exactly 4 policies on plan_geofences, found %. A leftover policy ORs with the new family and would defeat the convergence.', n;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname='public' AND tablename='plan_geofences'
       AND policyname IN ('trip_members_manage_geofences','pgf_select_accepted',
                          'pgf_insert_accepted','pgf_update_accepted',
                          'pgf_delete_accepted','plan_geofences_service',
                          'plan_geofences_trip_members','pgf_select_member')
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: a superseded policy name is still live.';
  END IF;

  -- The tightening is the point of this migration, so assert it landed: the
  -- DELETE predicate must NOT reference trip_members.
  SELECT pg_get_expr(p.polqual, p.polrelid) INTO delete_qual
    FROM pg_policy p
    WHERE p.polrelid = 'public.plan_geofences'::regclass
      AND p.polname = 'plan_geofences_delete_owner';
  IF delete_qual IS NULL OR delete_qual LIKE '%trip_members%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: DELETE is not owner-only (predicate: %)', COALESCE(delete_qual, 'missing');
  END IF;
END $$;

COMMIT;
