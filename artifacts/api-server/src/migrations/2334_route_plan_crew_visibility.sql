-- 2334_route_plan_crew_visibility.sql
--
-- The five route-plan CREW policies stop hand-rolling their own membership test
-- and start routing through one helper that means exactly what the API means by
-- "accepted trip member".
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2334.
--
-- Policy-only: it creates one function, replaces five policies, and touches no
-- table, column, grant or row. Idempotent (CREATE OR REPLACE / DROP IF EXISTS
-- then CREATE), so re-running it is a no-op.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THIS IS NOT
-- ══════════════════════════════════════════════════════════════════════════════
-- The trips census (docs/architecture/census-trips.md) recorded these tables as
-- having "owner-only RLS -- a trip's crew cannot read the trip's own route
-- plan". THAT IS NOT WHAT THE DATABASE SAYS, and it never was. Measured
-- 2026-09-07 from pg_policies on BOTH databases -- production
-- (ajrurzioarfkagpuxfnb) and portava-ci (hwokxgbmezheskbzskfr), byte-identical
-- to each other and to 0058/0059 as committed -- every one of the three tables
-- already carries a crew SELECT policy alongside its owner policy:
--
--   route_plans         route_plans_owner_select   + route_plans_member_select
--   route_stops         route_stops_owner_all      + route_stops_member_select
--   route_legs          route_legs_owner_all       + route_legs_member_select
--   route_plan_members  rpm_select_own             + rpm_select_trip
--
-- Crew visibility was delivered with the original feature. No migration is
-- needed to add it and this one does not add it. What IS wrong is narrower, and
-- runs in BOTH directions at once.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE ACTUAL DEFECT: RLS AND THE API DISAGREE ABOUT WHO THE CREW IS
-- ══════════════════════════════════════════════════════════════════════════════
-- Every route-plan HTTP handler authorizes through `requireTripMember` in
-- src/lib/http.ts (via `isAcceptedTripMember`). That helper is the definition of
-- record. It accepts a viewer when:
--
--   (a) a trip_members row exists for (trip, viewer) AND
--         role   IN ('owner','co_host','member','viewer')   -- http.ts:470
--         status IS NULL OR status = 'accepted'             -- http.ts:474
--   (b) NO trip_members row exists AND trips.owner_id = viewer  -- http.ts:454-462
--       (the trip owner is not always given an explicit membership row;
--        gemsFeed.test.ts:600 pins this case)
--
-- The five policies below instead each inlined the SAME hand-written predicate:
--
--   tm.role IN ('owner','member')          -- and nothing else
--
-- which differs from the definition of record on three counts:
--
--   ── FAIL-OPEN (the serious one) ─────────────────────────────────────────────
--   `status` IS NOT CHECKED AT ALL. trip_members.status is `text NOT NULL
--   DEFAULT 'accepted'`, so it is a live column with live non-accepted values: a
--   row carrying role='member' + status='invited' is a PENDING INVITEE. The API
--   denies that viewer. The policy admits them -- they can read the trip's route
--   plan, every stop with its precise {label,lat,lng}, and every leg, straight
--   off PostgREST with their own JWT.
--
--   THIS IS NOT HYPOTHETICAL. Measured on production 2026-09-07, aggregate only:
--     role     status     rows
--     owner    accepted     38
--     invited  accepted      2
--     member   invited       1   <- admitted by RLS, denied by the API
--     member   accepted      1
--
--   And the grant that makes it reachable is real: anon AND authenticated hold
--   the full DELETE/INSERT/REFERENCES/SELECT/TRIGGER/TRUNCATE/UPDATE set on all
--   four tables (Supabase's ALTER DEFAULT PRIVILEGES at CREATE TABLE time; no
--   migration asked for it). So RLS is the ONLY thing standing between an
--   end-user JWT and these rows. It is load-bearing, not decorative. 0059 says
--   so in its own words: "the API layer applies the same logic; this policy
--   closes direct-PostgREST access."
--
--   `rpm_insert_own` carries the same hole on a WRITE: a pending invitee could
--   insert themselves into route_plan_members for a plan they may not read.
--
--   ── FAIL-CLOSED (two of them) ───────────────────────────────────────────────
--   `co_host` and `viewer` are accepted crew everywhere in the application and
--   are omitted from every one of these policies. member_role has five labels
--   (owner, member, invited, co_host, viewer); the policies named two.
--
--   A trip owner with no trip_members row is crew per (b) above and is omitted
--   too, because the policies join trip_members and never consult trips.owner_id.
--   Measured on production: 5 of 43 trips have an owner with no membership row.
--
-- Fail-closed halves are a correctness bug, not a breach. The fail-open half is
-- the reason this migration exists.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY A NEW HELPER AND NOT public.is_accepted_trip_member()
-- ══════════════════════════════════════════════════════════════════════════════
-- public.is_accepted_trip_member(uuid) already exists and is the obvious
-- candidate. It carries THE IDENTICAL DEFECT -- `role in ('owner','member')`,
-- no status check, no owner fallback -- so reusing it would change nothing.
--
-- It is also NOT this lane's to repair: it is a shared helper referenced by
-- other subsystems' policies, and widening it would silently re-authorize
-- tables this migration has not measured. Fixing it is a separate, larger
-- change that must enumerate every dependent policy first. This migration
-- therefore introduces a helper scoped to the predicate it actually verified,
-- and leaves the shared one exactly as it found it. That divergence is recorded
-- here deliberately so the next reader does not assume the two agree.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY authz AND NOT public
-- ══════════════════════════════════════════════════════════════════════════════
-- PostgREST exposes functions in its configured db-schemas; `authz` (created by
-- 2182) is not one. A membership predicate in `public` is an RPC oracle -- any
-- caller could ask it questions. In `authz` it is reachable only from policy
-- evaluation. This follows 2199's authz.viewer_in_call precedent exactly,
-- including the rule below about not "hardening" it by revoking EXECUTE.

BEGIN;

DO $$
BEGIN
  IF to_regnamespace('authz') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: schema authz missing -- apply 2182 first.';
  END IF;
  IF to_regclass('public.route_plans')        IS NULL
     OR to_regclass('public.route_stops')     IS NULL
     OR to_regclass('public.route_legs')      IS NULL
     OR to_regclass('public.route_plan_members') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: route plan tables missing -- apply 0058/0059 first.';
  END IF;
  IF to_regclass('public.trips') IS NULL OR to_regclass('public.trip_members') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: trips/trip_members missing.';
  END IF;
  -- The status gate below is the point of this migration. If the column ever
  -- goes away, these policies must be revisited rather than silently widened.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'trip_members' AND column_name = 'status'
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: trip_members.status missing -- the accepted-status gate cannot be expressed.';
  END IF;
END $$;

-- ── The one definition of "crew", mirroring lib/http.ts requireTripMember ─────
--
-- The CASE is not decoration. requireTripMember consults the membership row
-- when one exists and falls back to trips.owner_id ONLY when none does. Writing
-- this as a flat OR would admit a trip owner whose own membership row says
-- status='removed' -- a viewer the API denies. The branch keeps the two
-- definitions identical rather than merely similar.
--
-- coalesce(status,'accepted') mirrors http.ts:474 ("rows with no status are
-- treated as accepted for backwards compatibility with pre-migration data").
-- The column is NOT NULL today, so this is inert -- and it is kept so the
-- predicate does not quietly change meaning if that constraint is ever relaxed.
CREATE OR REPLACE FUNCTION authz.is_trip_crew(t_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
  SELECT CASE
    WHEN t_id IS NULL OR auth.uid() IS NULL THEN false
    WHEN EXISTS (
      SELECT 1 FROM public.trip_members m
      WHERE m.trip_id = t_id AND m.user_id = auth.uid()
    ) THEN EXISTS (
      SELECT 1 FROM public.trip_members m
      WHERE m.trip_id = t_id
        AND m.user_id = auth.uid()
        AND m.role IN ('owner', 'co_host', 'member', 'viewer')
        AND coalesce(m.status, 'accepted') = 'accepted'
    )
    ELSE EXISTS (
      SELECT 1 FROM public.trips t
      WHERE t.id = t_id AND t.owner_id = auth.uid()
    )
  END;
$fn$;

COMMENT ON FUNCTION authz.is_trip_crew(uuid) IS
  'True when the CURRENT viewer (auth.uid(), read inside the function -- never a parameter) is an ACCEPTED member of the given trip, using exactly the rule lib/http.ts requireTripMember applies: role in (owner, co_host, member, viewer) AND status accepted when a membership row exists, else trips.owner_id when none does. SECURITY DEFINER so the membership read bypasses RLS on trips/trip_members and cannot recurse into the policies that call it. Lives in authz so PostgREST does not expose it as an RPC oracle. Must remain EXECUTE-able by anon and authenticated: RLS predicates evaluate with the querying role''s privileges, so revoking it does not harden anything, it breaks every crew read. Deliberately NOT public.is_accepted_trip_member, which omits status, co_host, viewer and the owner fallback -- see migration 2334.';

-- Required for correctness, not an oversight. See 2199's header.
GRANT EXECUTE ON FUNCTION authz.is_trip_crew(uuid) TO anon, authenticated, service_role;

-- ── route_plans ───────────────────────────────────────────────────────────────
-- `trip_id IS NOT NULL` is retained from 0058: a detached plan has no crew, and
-- is_trip_crew(NULL) is false anyway. Kept explicit so the intent survives.
DROP POLICY IF EXISTS "route_plans_member_select" ON public.route_plans;
CREATE POLICY "route_plans_member_select" ON public.route_plans
  FOR SELECT USING (
    trip_id IS NOT NULL AND authz.is_trip_crew(trip_id)
  );

-- ── route_stops ───────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "route_stops_member_select" ON public.route_stops;
CREATE POLICY "route_stops_member_select" ON public.route_stops
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.route_plans rp
      WHERE rp.id = route_stops.route_plan_id
        AND rp.trip_id IS NOT NULL
        AND authz.is_trip_crew(rp.trip_id)
    )
  );

-- ── route_legs ────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "route_legs_member_select" ON public.route_legs;
CREATE POLICY "route_legs_member_select" ON public.route_legs
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.route_plans rp
      WHERE rp.id = route_legs.route_plan_id
        AND rp.trip_id IS NOT NULL
        AND authz.is_trip_crew(rp.trip_id)
    )
  );

-- ── route_plan_members ────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "rpm_select_trip" ON public.route_plan_members;
CREATE POLICY "rpm_select_trip" ON public.route_plan_members
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.route_plans rp
      WHERE rp.id = route_plan_members.route_plan_id
        AND rp.trip_id IS NOT NULL
        AND authz.is_trip_crew(rp.trip_id)
    )
  );

-- The write. Structure preserved from 0059 exactly -- self-only, and either a
-- trip-linked plan whose crew you belong to, or a detached plan you own. Only
-- the crew half changes, and only to stop admitting pending invitees.
DROP POLICY IF EXISTS "rpm_insert_own" ON public.route_plan_members;
CREATE POLICY "rpm_insert_own" ON public.route_plan_members
  FOR INSERT WITH CHECK (
    user_id = auth.uid()
    AND (
      EXISTS (
        SELECT 1 FROM public.route_plans rp
        WHERE rp.id = route_plan_members.route_plan_id
          AND rp.trip_id IS NOT NULL
          AND authz.is_trip_crew(rp.trip_id)
      )
      OR EXISTS (
        SELECT 1 FROM public.route_plans rp
        WHERE rp.id = route_plan_members.route_plan_id
          AND rp.owner_user_id = auth.uid()
          AND rp.trip_id IS NULL
      )
    )
  );

-- ── Postconditions ────────────────────────────────────────────────────────────
DO $$
DECLARE
  n_routed   int;
  n_legacy   int;
BEGIN
  -- All five crew policies must now route through the helper.
  SELECT count(*) INTO n_routed
  FROM pg_policies
  WHERE schemaname = 'public'
    AND (policyname, tablename) IN (
      ('route_plans_member_select', 'route_plans'),
      ('route_stops_member_select', 'route_stops'),
      ('route_legs_member_select',  'route_legs'),
      ('rpm_select_trip',           'route_plan_members'),
      ('rpm_insert_own',            'route_plan_members')
    )
    AND coalesce(qual, '') || coalesce(with_check, '') LIKE '%is_trip_crew%';
  IF n_routed <> 5 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: expected 5 crew policies routed through authz.is_trip_crew, found %', n_routed;
  END IF;

  -- And none of them may still carry the hand-rolled trip_members join that
  -- omitted the status gate.
  SELECT count(*) INTO n_legacy
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename IN ('route_plans', 'route_stops', 'route_legs', 'route_plan_members')
    AND coalesce(qual, '') || coalesce(with_check, '') LIKE '%trip_members%';
  IF n_legacy <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: % route-plan policies still reference trip_members directly', n_legacy;
  END IF;

  -- The owner policies are untouched by this migration and must survive it.
  IF (SELECT count(*) FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename IN ('route_plans', 'route_stops', 'route_legs', 'route_plan_members')) <> 13 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: expected 13 policies across the four route-plan tables, found %',
      (SELECT count(*) FROM pg_policies
       WHERE schemaname = 'public'
         AND tablename IN ('route_plans', 'route_stops', 'route_legs', 'route_plan_members'));
  END IF;
END $$;

COMMIT;
