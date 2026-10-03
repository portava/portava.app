-- 3513_layover_crew_itinerary.sql
--
-- THE CREW ITINERARY: `layover_crew_stops`, `layover_crew_branch_assignments`.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band). Lane 3513 (layover).
-- Creates TWO new tables. Alters nothing that exists. Moves no row. Seeds no
-- feature flag. Adds no column to 2984's tables.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY
-- ══════════════════════════════════════════════════════════════════════════════
-- §14.1 says "Crew plan must be certified against every member branch", and
-- `certifyCrewPlan` (services/airport/LayoverCrewService.ts) has implemented
-- exactly that — per-branch feasibility, per-member slack, the explicit split
-- plan — purely, for a year of census passes. It has never been given a plan.
--
-- `routes/airport.ts` calls it with `unsplitPlan(members, [])`: one branch,
-- everybody, NO STOPS. With no stops `branchNeededMinutes` is 0, so
-- `plan_exceeds_usable_minutes` and `plan_ends_after_shared_return` cannot
-- fire and `split` is always false. The two verdicts the spec asks for are
-- reachable and unexercised. docs/BUILD-BACKLOG.md records this and names the
-- remedy: "A crew itinerary (propose stops, assign branches) is the next build
-- on this row."
--
-- These are the tables a crew needs to HAVE a plan. The arithmetic is not
-- touched; nothing here decides whether a plan works.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY NOT `layover_plan_stops`, WHICH ALREADY EXISTS
-- ══════════════════════════════════════════════════════════════════════════════
-- Because its RLS policy is the wrong shape for a shared object, and reusing it
-- would have been the silent way to ship a crew itinerary only its author can
-- read. `layover_plan_stops_owner` (0127_layover_system.sql) is
-- `FOR ALL TO authenticated USING (session_id IN (SELECT id FROM
-- layover_sessions WHERE user_id = auth.uid()))` — a traveller reaches the stops
-- of their OWN session and no others. A crew stop proposed by member A and
-- stored against A's session is invisible to B under that policy and writable by
-- A alone, which is the opposite of "propose".
--
-- Widening that policy was the alternative and is worse: it is a live,
-- client-reachable table on the solo planning surface, and loosening its owner
-- scope to admit crewmates would change who can read every solo plan in the
-- product in order to add a feature to one.
--
-- So: separate tables, keyed on the CREW, taking 2984's stance rather than
-- 0127's — see below.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WRITE BOUNDARY — NEITHER TABLE IS CLIENT-READABLE OR CLIENT-WRITABLE
-- ══════════════════════════════════════════════════════════════════════════════
-- This is 2984's decision for the crew tables, taken again for the same reason
-- and stated rather than inherited — BUT EXPRESSED IN 3390's SHAPE RATHER THAN
-- 2984's, and the difference is worth the paragraph.
--
-- 2984 wrote: RLS on, NO POLICY OF ANY KIND, grants revoked from `anon` and
-- `authenticated`. That denies a client everything today, and it denies it by
-- ABSENCE: the day somebody adds one permissive policy for an unrelated reason,
-- the absence stops denying anything.
--
-- 3466 (the current convention in this lane) writes the denial down instead:
-- RLS on, grants revoked from `PUBLIC`/`anon`/`authenticated`, the four
-- operations GRANTed to `service_role` explicitly, and FOUR RESTRICTIVE
-- client-deny policies. A RESTRICTIVE policy ANDs with every permissive one, so
-- a later permissive policy cannot widen past it. This file takes that shape.
--
-- THAT IS NOT A DEPARTURE FROM 2984's ARGUMENT, and the postcondition keeps
-- them apart so it cannot quietly become one: what 2984 refuses is a PERMISSIVE
-- membership-scoped policy, a weaker second answer to "who may see a crewmate"
-- sitting underneath the route layer's composition. The assertion below is
-- therefore `0 permissive AND exactly 4 restrictive`, not `0 policies` — the
-- restrictive four cannot admit anybody, so 2984's rule is intact and is now
-- also enforced against a future permissive one.
--
-- WHY NOT A MEMBERSHIP-SCOPED SELECT POLICY, which is again the obvious
-- alternative: a crew stop is a thing a crewmate proposed, and who may see a
-- crewmate is not "anyone in the crew" — it is anyone in the crew MINUS blocks
-- in both directions, MINUS whoever has since paused sharing or gone into ghost
-- mode. `crewMemberCards` in routes/airport.ts already composes exactly that.
-- A policy expressing only the membership half would be a SECOND, WEAKER answer
-- to the same question sitting underneath the right one, and 2984's own header
-- says so at length. The same argument, unchanged, is why these tables carry no
-- policy either.
--
-- That costs this tree nothing, re-checked rather than inherited:
-- `travel-buddy-standalone/src/services/layover.ts` opens with "All calls go
-- through the API server (no direct Supabase from client for layover data)",
-- and neither new table name appears anywhere under `travel-buddy-standalone/`.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT IS DELIBERATELY NOT IN THESE TABLES
-- ══════════════════════════════════════════════════════════════════════════════
-- NO COORDINATES, AND THIS IS NOT 2984'S REASON. 2984 withholds a coordinate
-- because a CREW MEMBER's position is gated on a temporary permission (§14 L124).
-- A stop is a PLACE, not a person, and `layover_plan_stops` does carry `lat`/
-- `lng` for exactly that reason, so that argument does not reach here.
--
-- The reason these tables carry none is narrower and is about what the feature
-- needs: `CrewPlanStop` is `{ title, durationMin, travelMin, insideAirport }`
-- and `branchNeededMinutes` reads nothing else, so a coordinate would be a
-- column no consumer reads, on a shared object, published to everyone in a crew.
-- `location_label` is free TEXT ("Terminal 2 food court") and is what the solo
-- stop surface actually displays. If a crew map pin is ever built it should
-- argue with this paragraph rather than find a column waiting for it, which is
-- why the postcondition asserts the absence.
--
-- NO `recommendation_id`, NO `source`, NO `description`. Each is a column
-- `layover_plan_stops` has and the crew solver does not read. A crew stop
-- sourced from a recommendation is a further build with its own moderation
-- boundary (the solo route re-checks `status <> 'user_hidden'` before adopting
-- one); minting the column now would invite a write that skips that check.
--
-- NO PER-STOP VOTING OR APPROVAL STATE. "Propose" here means "add to the
-- crew's plan, attributed". Whether a stop needs assent, and from whom, is a
-- product decision nobody has taken, and a `status` column seeded 'accepted'
-- would answer it silently.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- BRANCHES ARE AN ASSIGNMENT TABLE, NOT A BRANCH TABLE
-- ══════════════════════════════════════════════════════════════════════════════
-- `CrewBranch` is `{ branchId, memberIds, stops }`. A branch has no identity
-- beyond its id, its people and its stops, so there is nothing for a
-- `layover_crew_branches` row to hold that these two tables do not already
-- carry — and an empty branch row would be a branch `certifyCrewPlan` reports as
-- `empty_branch` for a reason no traveller caused.
--
-- `branch_id` is therefore plain TEXT on both tables, and `'all'` is the
-- default on both, which is what makes the UNSPLIT case the one that needs no
-- rows at all: a crew with stops and no assignments is one branch called `'all'`
-- containing everybody — identical to `unsplitPlan`, which names its branch
-- `'all'` too. A split is created by writing assignments, and ONE assignment is
-- enough to split a crew, which is why the reader must treat an unassigned
-- member as `member_unassigned` rather than quietly folding them into `'all'`.
-- That rule lives in the store, not here; the schema's job is only to make the
-- unsplit case cost nothing.
--
-- PRIMARY KEY (crew_id, user_id) on the assignment table. ONE BRANCH PER PERSON
-- PER CREW, enforced by the database rather than by the reader, because
-- `certifyCrewPlan` raises `member_assigned_twice` on a double assignment and a
-- traveller who tapped twice has not split themselves in half. 2984 took the
-- same key on `layover_crew_members` for the same reason.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- STOP ORDER, AND WHY IT IS NOT UNIQUE
-- ══════════════════════════════════════════════════════════════════════════════
-- `stop_order` is per (crew_id, branch_id) and is NOT unique. The solo surface
-- derives a new row's order from `existing.length` and compacts on delete, in
-- the route, under one owner. A crew has several writers, so a unique index
-- would turn two members proposing a stop at the same moment into a 23505 for
-- whichever lost — a constraint violation reported to a traveller who did
-- nothing wrong. `branchNeededMinutes` folds over the stops and is
-- order-independent, and the display order is a tie-break on `created_at`, so a
-- duplicated order costs nothing a traveller can see. The honest shape for
-- "these two were proposed at once" is two rows, not an error.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- TRAVEL TIME: THE CHECK THAT CANNOT BE EXPRESSED HERE
-- ══════════════════════════════════════════════════════════════════════════════
-- census L47 is what a fabricated zero leg cost: a landside stop whose journey
-- nobody stated contributed its dwell and nothing else, and `computePlanFit`
-- certified a plan whose journeys were never measured. `landsideTravelRefusal`
-- in routes/airport.ts is the fix on the solo surface and the crew routes use
-- the same function.
--
-- `travel_min` is NOT NULL with NO DEFAULT here, deliberately, which is as far
-- as a CHECK can go: a CHECK cannot say "positive when `inside_airport` is
-- false" without also forbidding the airside zero, which is a fact. Dropping
-- the DEFAULT 0 that `layover_plan_stops` carries at least means an INSERT that
-- omits the column fails loudly instead of storing a zero that later reads as a
-- measurement. The rest is the route's.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- APPLY ORDER
-- ══════════════════════════════════════════════════════════════════════════════
-- Depends on 2984 (`layover_crews`) and on `profiles`. INDEPENDENT of 3514
-- (the crew location-grant store), of 2985, and of everything in the 35xx band.
-- Safe to apply at any time. Applying it alone changes nothing a traveller sees:
-- the crew payload publishes an itinerary only once the routes ship, and they
-- ship in the same commit as this file.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- REVERSIBLE BY
-- ══════════════════════════════════════════════════════════════════════════════
-- Rollback: db/rollback/2026-10-03-3513-layover-crew-itinerary-rollback.sql
--   DROP TABLE IF EXISTS public.layover_crew_branch_assignments;
--   DROP TABLE IF EXISTS public.layover_crew_stops;
-- In either order (no FK between them). Nothing else is touched. Both tables
-- are new in this file, so a drop loses only what this file's own routes wrote.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHERE THE REAL-RLS EVIDENCE LIVES
-- ══════════════════════════════════════════════════════════════════════════════
-- Not in this file. A probe with real rows and real roles is the strongest
-- evidence there is, and inside the migration's own transaction it can only
-- undo itself by aborting — which rolls back the DDL batched with it while the
-- migration still reports success. That is how 2195 silently failed, and
-- `src/test/migrationDeployability.test.ts` forbids the shape. So this file
-- INSERTS NOTHING and assumes no role, its postcondition block runs AFTER
-- `COMMIT` as catalog assertions only, and the probe lives in
-- `src/test/db/layoverCrewItineraryBoundary.db.test.ts`, which observes from a
-- separate connection against a database carrying these policies.

BEGIN;

-- ── Preconditions ────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.layover_crews') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3513): public.layover_crews does not exist. Apply 2984_layover_crews.sql first.';
  END IF;
  IF to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3513): public.profiles does not exist.';
  END IF;
END $$;

-- ── §14.1 the crew's stops ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS layover_crew_stops (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  crew_id         UUID        NOT NULL REFERENCES layover_crews(id) ON DELETE CASCADE,

  -- The branch this stop belongs to. `'all'` is the unsplit case and matches
  -- `unsplitPlan`'s own branch id, so a crew with no assignments reads as one
  -- branch containing everybody with no rows written anywhere else.
  branch_id       TEXT        NOT NULL DEFAULT 'all'
                    CHECK (length(branch_id) BETWEEN 1 AND 64),

  -- Per (crew_id, branch_id), NOT unique. See STOP ORDER, AND WHY IT IS NOT
  -- UNIQUE: several members write here, and a uniqueness race would report a
  -- constraint violation to a traveller who did nothing wrong.
  stop_order      INTEGER     NOT NULL DEFAULT 0 CHECK (stop_order BETWEEN 0 AND 999),

  title           TEXT        NOT NULL CHECK (length(title) BETWEEN 1 AND 120),

  -- The same bounds `layover_plan_stops` carries, so a stop cannot be moved
  -- between the two surfaces and become valid or invalid on arrival.
  duration_min    INTEGER     NOT NULL CHECK (duration_min BETWEEN 5 AND 720),

  -- NO DEFAULT. See TRAVEL TIME: THE CHECK THAT CANNOT BE EXPRESSED HERE. An
  -- INSERT that omits this fails rather than storing a zero that later reads as
  -- a measured journey.
  travel_min      INTEGER     NOT NULL CHECK (travel_min BETWEEN 0 AND 240),

  inside_airport  BOOLEAN     NOT NULL,

  -- A LABEL, never a position. See WHAT IS DELIBERATELY NOT IN THESE TABLES.
  location_label  TEXT        CHECK (location_label IS NULL OR length(location_label) BETWEEN 1 AND 200),

  -- Who proposed it. CASCADE: a stop attributed to a deleted profile would be
  -- an unattributable proposal on a shared plan, and the crew it belongs to is
  -- already cascaded away by 2984 when its founder goes.
  proposed_by     UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The itinerary read: every stop of one crew, in branch and display order.
CREATE INDEX IF NOT EXISTS layover_crew_stops_crew_idx
  ON layover_crew_stops(crew_id, branch_id, stop_order, created_at);

COMMENT ON TABLE public.layover_crew_stops IS
  'census-layover L135 / spec §14.1 (3513): the stops of one crew''s itinerary, per branch. Written and read only by the crew routes on the service role; RLS on with four restrictive client-deny policies and no permissive policy. Holds no coordinate: branchNeededMinutes reads only title/duration/travel/inside_airport.';

ALTER TABLE public.layover_crew_stops ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.layover_crew_stops FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.layover_crew_stops TO service_role;

-- ── §14.1 the explicit split ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS layover_crew_branch_assignments (
  crew_id      UUID        NOT NULL REFERENCES layover_crews(id) ON DELETE CASCADE,
  user_id      UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,

  branch_id    TEXT        NOT NULL DEFAULT 'all'
                 CHECK (length(branch_id) BETWEEN 1 AND 64),

  -- Who split the crew. Kept because a split moves someone else's deadline out
  -- of the shared minimum into a branch of their own, which is a thing a
  -- traveller may reasonably ask who did.
  assigned_by  UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  assigned_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- ONE BRANCH PER PERSON PER CREW. See BRANCHES ARE AN ASSIGNMENT TABLE.
  PRIMARY KEY (crew_id, user_id)
);

CREATE INDEX IF NOT EXISTS layover_crew_branch_assignments_crew_idx
  ON layover_crew_branch_assignments(crew_id, branch_id);

COMMENT ON TABLE public.layover_crew_branch_assignments IS
  'spec §14.1 "unless an explicit split plan exists" (3513): which branch each crew member is on. No rows means the unsplit case — one branch ''all'', everybody — matching unsplitPlan. One branch per person per crew (composite PK). Service role only.';

ALTER TABLE public.layover_crew_branch_assignments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.layover_crew_branch_assignments FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.layover_crew_branch_assignments TO service_role;

-- ── The four restrictive client denials, per table ───────────────────────────
-- 3390's pattern, as 3466 writes it. RESTRICTIVE ANDs with every permissive
-- policy, so this denial survives a later permissive one — which is the failure
-- mode a bare "no policy at all" cannot cover. UPDATE needs both USING and
-- WITH CHECK; INSERT takes WITH CHECK only; SELECT and DELETE take USING only.
DO $policies$
DECLARE
  v_table TEXT;
  v_op TEXT;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['layover_crew_stops','layover_crew_branch_assignments'] LOOP
    FOREACH v_op IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE'] LOOP
      EXECUTE format(
        'DROP POLICY IF EXISTS %I ON public.%I',
        format('%s_deny_%s_clients', v_table, lower(v_op)), v_table);
      EXECUTE format(
        'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR %s TO anon, authenticated %s',
        format('%s_deny_%s_clients', v_table, lower(v_op)), v_table, v_op,
        CASE v_op
          WHEN 'INSERT' THEN 'WITH CHECK (false)'
          WHEN 'UPDATE' THEN 'USING (false) WITH CHECK (false)'
          ELSE 'USING (false)'
        END);
    END LOOP;
  END LOOP;
END
$policies$;

COMMIT;

-- ── Postconditions ───────────────────────────────────────────────────────────
-- AFTER `COMMIT`, deliberately. Catalog state only, no temp table, no
-- before/after comparison, no row written and no role assumed — so
-- `certify:migrations` can re-run this block standalone, and so a failing
-- assertion cannot roll back the DDL it is asserting about (2195's defect, which
-- `src/test/migrationDeployability.test.ts` now forbids).
DO $post$
DECLARE
  permissive_count INTEGER;
  restrictive_count INTEGER;
  client_cols INTEGER;
  pk_cols TEXT;
  coord_cols INTEGER;
  travel_default TEXT;
  uniq_order INTEGER;
BEGIN
  IF to_regclass('public.layover_crew_stops') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3513): layover_crew_stops missing';
  END IF;
  IF to_regclass('public.layover_crew_branch_assignments') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3513): layover_crew_branch_assignments missing';
  END IF;

  -- RLS on, or every revoke below is decoration and the service role's bypass
  -- stops being the only way in.
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'layover_crew_stops' AND c.relrowsecurity = TRUE
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3513): RLS not enabled on layover_crew_stops';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'layover_crew_branch_assignments' AND c.relrowsecurity = TRUE
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3513): RLS not enabled on layover_crew_branch_assignments';
  END IF;

  -- NO PERMISSIVE POLICY, the L201 check, for the reason 2984 gives and this
  -- file restates: a membership-only policy is a weaker second answer to "who
  -- may see a crewmate" underneath the route layer's composition. Asserted as
  -- `0 permissive` rather than `0 policies` so the restrictive denials below
  -- are allowed to exist, and so adding a permissive one is still a failure.
  SELECT count(*) INTO permissive_count
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename IN ('layover_crew_stops','layover_crew_branch_assignments')
     AND permissive = 'PERMISSIVE';
  IF permissive_count <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3513): % permissive policy/policies on the crew itinerary tables, expected 0. These tables are server-mediated; a permissive policy here would admit a crewmate the route layer''s blocks and sharing-preference gates would have excluded.', permissive_count;
  END IF;

  -- AND THE DENIALS ARE WRITTEN DOWN. Eight: four operations on each of two
  -- tables. Counted rather than assumed, because RLS-with-no-policy already
  -- denies everything, so a missing restrictive policy is invisible until the
  -- day a permissive one arrives — exactly the day it was supposed to matter.
  SELECT count(*) INTO restrictive_count
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename IN ('layover_crew_stops','layover_crew_branch_assignments')
     AND permissive = 'RESTRICTIVE';
  IF restrictive_count <> 8 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3513): % restrictive client-deny policy/policies on the crew itinerary tables, expected 8 (SELECT/INSERT/UPDATE/DELETE on each of two tables)', restrictive_count;
  END IF;

  -- The service role must actually be able to work, or the routes fail closed
  -- on a boundary that was meant to deny clients only. Asserted because the
  -- REVOKE above names PUBLIC, and a role that inherits nothing else would lose
  -- its access to a GRANT this file forgot.
  IF NOT (
    has_table_privilege('service_role', 'public.layover_crew_stops', 'SELECT')
    AND has_table_privilege('service_role', 'public.layover_crew_stops', 'INSERT')
    AND has_table_privilege('service_role', 'public.layover_crew_stops', 'DELETE')
    AND has_table_privilege('service_role', 'public.layover_crew_branch_assignments', 'SELECT')
    AND has_table_privilege('service_role', 'public.layover_crew_branch_assignments', 'INSERT')
    AND has_table_privilege('service_role', 'public.layover_crew_branch_assignments', 'DELETE')
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3513): service_role lacks SELECT/INSERT/DELETE on one of the crew itinerary tables; the routes would refuse every itinerary read and write.';
  END IF;

  -- No client grant of ANY kind, read included.
  SELECT count(*) INTO client_cols
    FROM information_schema.column_privileges
   WHERE table_schema = 'public'
     AND table_name IN ('layover_crew_stops','layover_crew_branch_assignments')
     AND grantee IN ('anon','authenticated');
  IF client_cols <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3513): % client column grant(s) on the crew itinerary tables, expected 0 (RLS is on and there is no policy, so a grant is inert today and a trap the day someone adds one)', client_cols;
  END IF;

  -- ONE BRANCH PER PERSON PER CREW, asserted as the composite PK it must be. A
  -- unique index on crew_id alone would allow one assignment per crew; on
  -- user_id alone, one branch per person across every crew they ever join.
  SELECT string_agg(a.attname, ',' ORDER BY k.ord) INTO pk_cols
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON TRUE
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
   WHERE n.nspname = 'public' AND t.relname = 'layover_crew_branch_assignments' AND c.contype = 'p'
   GROUP BY c.oid;
  IF pk_cols IS DISTINCT FROM 'crew_id,user_id' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3513): layover_crew_branch_assignments primary key is (%), expected (crew_id,user_id) -- one branch per person per crew, so certifyCrewPlan''s member_assigned_twice cannot be reached by a double tap', coalesce(pk_cols, 'none');
  END IF;

  -- `travel_min` MUST NOT acquire a default. The whole point of dropping
  -- `layover_plan_stops`'s DEFAULT 0 is that an INSERT omitting the column
  -- fails instead of storing a zero that later reads as a measured journey, and
  -- a later ALTER adding the default back would silently restore census L47's
  -- laundering. Asserted so it has to argue with this file.
  SELECT column_default INTO travel_default
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'layover_crew_stops' AND column_name = 'travel_min';
  IF travel_default IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3513): layover_crew_stops.travel_min has default %, expected none. A default here turns an omitted landside journey into a measured zero (census L47).', travel_default;
  END IF;

  -- `stop_order` MUST NOT be unique. A uniqueness race between two members
  -- proposing at once is a 23505 reported to a traveller who did nothing
  -- wrong, and the solver folds over the stops order-independently.
  SELECT count(*) INTO uniq_order
    FROM pg_index i
    JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'public' AND t.relname = 'layover_crew_stops'
     AND i.indisunique
     AND EXISTS (
       SELECT 1 FROM pg_attribute a
        WHERE a.attrelid = t.oid AND a.attnum = ANY (i.indkey::int[]) AND a.attname = 'stop_order'
     );
  IF uniq_order <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3513): % unique index/indexes cover layover_crew_stops.stop_order, expected 0. A crew has several writers; see STOP ORDER, AND WHY IT IS NOT UNIQUE.', uniq_order;
  END IF;

  -- NO COORDINATES, for this file's own narrower reason rather than 2984's:
  -- `CrewPlanStop` is {title,durationMin,travelMin,insideAirport} and
  -- `branchNeededMinutes` reads nothing else, so a coordinate would be a column
  -- no consumer reads, on a shared object, published to a whole crew.
  SELECT count(*) INTO coord_cols
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name IN ('layover_crew_stops','layover_crew_branch_assignments')
     AND column_name IN ('lat','lng','latitude','longitude','location','geog','geom','point','coords');
  IF coord_cols <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3513): % coordinate column(s) on the crew itinerary tables. Nothing in the §14.1 solver reads one; a crew map pin is a further build and should argue with this file rather than find a column waiting for it.', coord_cols;
  END IF;
END
$post$;
