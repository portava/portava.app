-- 2984_layover_crews.sql
--
-- THE TWO §14 TABLES THAT EXIST NOWHERE: `layover_crews`, `layover_crew_members`.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2984 (layover).
-- Creates TWO new tables. Alters nothing that exists. Moves no row. Seeds no
-- feature flag.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY
-- ══════════════════════════════════════════════════════════════════════════════
-- census-layover L28 (`layover_crews`) and L29 (`layover_crew_members`) both
-- read, in full: "Absent." §23.3 of that document files them under "blocked on
-- a migration no database has", and unlike `layover_snapshots` (2700) or
-- `airport_fact_observations` (2860) there is no written-but-unapplied file for
-- these — they are absent from the repository, not merely from the database.
--
-- The CONSTRAINT SOLVER over them is already built and is pure:
-- `services/airport/LayoverCrewService.ts` (515 lines) implements §14.1
-- `shared_return_by = min(member.required_return_by)`, per-branch feasibility,
-- explicit split plans, the location-precision ladder and the meet-action
-- availability rules. It takes its members as an argument and imports no
-- Supabase client. What it has never had is a crew to solve for.
--
-- Rows this unblocks, each of which currently reads N for "no crew": L28, L29,
-- L131 (§14 "L3 crew formed"), L185/L186/L188 (`LayoverCrewService.join` /
-- `.create` / `.leave`), and partially L144 and L203.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WRITE BOUNDARY — NEITHER TABLE IS CLIENT-READABLE OR CLIENT-WRITABLE
-- ══════════════════════════════════════════════════════════════════════════════
-- This is the same decision 2860 took for `layover_external_events`, taken for
-- the same reason and stated again rather than inherited.
--
-- census L201 records what happened the last time a layover table shipped with
-- its write half implicit: `layover_recommendations` carried `FOR ALL … USING`
-- with no `WITH CHECK`, PostgreSQL reused USING as the write check, and a
-- session owner could write their own certified safety fields.
--
-- So: RLS enabled, NO POLICY OF ANY KIND, and every grant revoked from `anon`
-- and `authenticated`. With RLS on and no policy, a client reaches nothing.
-- The service role bypasses RLS, which is how the routes read and write.
--
-- THAT COSTS THIS TREE NOTHING, and it was checked rather than assumed: the
-- client never queries layover tables directly. `travel-buddy-standalone/src/services/layover.ts`
-- opens with "All calls go through the API server (no direct Supabase from
-- client for layover data)", and a grep for either table name across
-- `travel-buddy-standalone/` returns nothing.
--
-- WHY NOT A MEMBERSHIP-SCOPED SELECT POLICY, which is the obvious alternative:
-- a crew is a list of PEOPLE, and who may see a member is not "anyone in the
-- crew" — it is anyone in the crew MINUS blocks in both directions, MINUS
-- whoever has since paused sharing in `location_preferences` or gone into ghost
-- mode. Those are three tables and a preference ladder, and `cityPresence`
-- already implements exactly that composition in the route layer
-- (`publishableUserIds`, the `blocks` read, `nameVisibilitySet`). A SQL policy
-- that expressed only the membership half would be a SECOND, WEAKER answer to
-- the same question sitting underneath the right one — and the weaker one is
-- what a future direct-from-client read would get.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT IS DELIBERATELY NOT IN THESE TABLES
-- ══════════════════════════════════════════════════════════════════════════════
-- NO COORDINATES, ANYWHERE. §14's map element "Crew member" is gated on "only
-- with explicit temporary location permission" (L124), and the precision ladder
-- that would govern it (`LOCATION_PRECISIONS`, `evaluateCrewLocationShare`) is
-- built but has no grant store. Adding a lat/lng column now would create a
-- place to put a coordinate BEFORE the thing that decides whether it may be
-- shown, which is the order that produces a leak. `meeting_point_label` is free
-- TEXT — "Terminal 2 food court" — and a label is not a position.
--
-- NO CHAT. §14's "shared chat" half of L131 belongs to the Telegraph lane's
-- threads, which already exist and already carry E2EE handling; minting a
-- second message store here would be the duplicate this repository has spent
-- several passes removing.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- EXPIRY IS A COLUMN, NOT A JOB
-- ══════════════════════════════════════════════════════════════════════════════
-- L196 asks for "expiration jobs" and this migration does NOT provide one — see
-- `expires_at` below. There is no scheduler in this tree (L196 records that
-- `expireOldSessions` is called inline from two GET handlers rather than
-- scheduled), and shipping a column named `expires_at` that nothing sweeps
-- would be a retention promise nothing keeps.
--
-- So the column is a FILTER, not a promise: every read in
-- `services/layover/LayoverCrewStore.ts` is bounded by `expires_at > now()`, so
-- an unswept crew is invisible rather than stale-but-live. The row survives
-- until something deletes it. That is honest and it is not retention; L196
-- stays N and docs/BUILD-BACKLOG.md says so.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- APPLY ORDER
-- ══════════════════════════════════════════════════════════════════════════════
-- Depends on 0127 (`layover_sessions`) and on `profiles`. INDEPENDENT of 2700 /
-- 2740 / 2741 / 2860 / 2982 / 2983. Safe to apply at any time. Applying it
-- alone changes nothing a traveller sees until the routes ship, and the routes
-- ship in the same commit as this file.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- REVERSIBLE BY
-- ══════════════════════════════════════════════════════════════════════════════
--   DROP TABLE IF EXISTS public.layover_crew_members;
--   DROP TABLE IF EXISTS public.layover_crews;
-- In that order (the FK). Nothing else is touched.

BEGIN;

-- ── Preconditions ────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.layover_sessions') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (2984): public.layover_sessions does not exist. Apply 0127_layover_system.sql first.';
  END IF;
  IF to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (2984): public.profiles does not exist.';
  END IF;
END $$;

-- ── §14 the crew ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS layover_crews (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The city the crew is meeting in, lower-cased by the writer. A crew is a
  -- CITY-level thing because layover presence is city-level (0127:82,
  -- `share_city_status`) and because two travellers at the same airport with
  -- different onward terminals are still in the same city.
  city                 TEXT        NOT NULL CHECK (length(city) BETWEEN 1 AND 120),

  -- Denormalised from the creator's session so a crew list can be filtered
  -- without joining every member's session. NOT an FK: an airport this
  -- deployment has no profile row for still has travellers in it.
  airport_ref          TEXT        CHECK (airport_ref IS NULL OR length(airport_ref) BETWEEN 1 AND 64),

  created_by           UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  -- The creator's layover. CASCADE because a crew whose founding layover is
  -- gone has no return deadline to be certified against.
  created_session_id   UUID        NOT NULL REFERENCES layover_sessions(id) ON DELETE CASCADE,

  title                TEXT        NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  -- A LABEL, never a position. See WHAT IS DELIBERATELY NOT IN THESE TABLES.
  meeting_point_label  TEXT        CHECK (meeting_point_label IS NULL OR length(meeting_point_label) BETWEEN 1 AND 200),

  status               TEXT        NOT NULL DEFAULT 'open'
                         CHECK (status IN ('open','closed','disbanded')),

  -- Small on purpose. §14.1's constraint solving takes a minimum over every
  -- member's certified deadline, so a large crew is a crew whose shared
  -- deadline is set by whoever leaves first and is useless to everyone else.
  max_members          INTEGER     NOT NULL DEFAULT 6
                         CHECK (max_members BETWEEN 2 AND 12),

  -- A FILTER, NOT A RETENTION PROMISE. See EXPIRY IS A COLUMN, NOT A JOB.
  expires_at           TIMESTAMPTZ NOT NULL,

  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The discovery read: open, unexpired crews in one city.
CREATE INDEX IF NOT EXISTS layover_crews_city_open_idx
  ON layover_crews(city, expires_at)
  WHERE status = 'open';

-- The sweep read, for whenever something is built to do the sweeping.
CREATE INDEX IF NOT EXISTS layover_crews_expiry_idx ON layover_crews(expires_at);

ALTER TABLE layover_crews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.layover_crews FROM anon;
REVOKE ALL ON public.layover_crews FROM authenticated;

-- ── §14 the membership ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS layover_crew_members (
  crew_id     UUID        NOT NULL REFERENCES layover_crews(id) ON DELETE CASCADE,
  user_id     UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,

  -- The member's OWN layover. This is the column that makes §14.1 possible:
  -- `certifyCrewPlan` needs each member's certified feasibility record, and
  -- that is derived from their session, not from the crew.
  session_id  UUID        NOT NULL REFERENCES layover_sessions(id) ON DELETE CASCADE,

  role        TEXT        NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member')),

  joined_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Set on leave rather than deleting the row, so "who was in this crew" stays
  -- answerable for the crew's short life. Every read filters on IS NULL.
  left_at     TIMESTAMPTZ,

  -- ONE MEMBERSHIP PER PERSON PER CREW. Without this, a double-tapped join is
  -- a second row, the member is counted twice against `max_members`, and
  -- `certifyCrewPlan` raises `member_assigned_twice` on a crew nobody split.
  PRIMARY KEY (crew_id, user_id)
);

CREATE INDEX IF NOT EXISTS layover_crew_members_user_idx
  ON layover_crew_members(user_id) WHERE left_at IS NULL;
CREATE INDEX IF NOT EXISTS layover_crew_members_crew_idx
  ON layover_crew_members(crew_id) WHERE left_at IS NULL;

ALTER TABLE layover_crew_members ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.layover_crew_members FROM anon;
REVOKE ALL ON public.layover_crew_members FROM authenticated;

-- ── Postconditions ───────────────────────────────────────────────────────────
-- Absolute and re-runnable: catalog state only, no temp table, no before/after
-- comparison, so `certify:migrations` can re-run this block standalone.
DO $$
DECLARE
  writable_cols INTEGER;
  policy_count INTEGER;
  pk_cols TEXT;
  coord_cols INTEGER;
BEGIN
  IF to_regclass('public.layover_crews') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2984): layover_crews missing';
  END IF;
  IF to_regclass('public.layover_crew_members') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2984): layover_crew_members missing';
  END IF;

  -- RLS on, or every revoke below is decoration and the service role's bypass
  -- stops being the only way in.
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'layover_crews' AND c.relrowsecurity = TRUE
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2984): RLS not enabled on layover_crews';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'layover_crew_members' AND c.relrowsecurity = TRUE
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2984): RLS not enabled on layover_crew_members';
  END IF;

  -- NO POLICY AT ALL. Asserted rather than assumed: this is the L201 check.
  SELECT count(*) INTO policy_count
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename IN ('layover_crews','layover_crew_members');
  IF policy_count <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2984): % policy/policies on the crew tables, expected 0. These tables are server-mediated; a policy here is a SECOND, weaker answer to "who may see a crew member" sitting underneath the route layer''s blocks + sharing-preference composition.', policy_count;
  END IF;

  -- No client grant of ANY kind, read included.
  SELECT count(*) INTO writable_cols
    FROM information_schema.column_privileges
   WHERE table_schema = 'public'
     AND table_name IN ('layover_crews','layover_crew_members')
     AND grantee IN ('anon','authenticated');
  IF writable_cols <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2984): % client column grant(s) on the crew tables, expected 0 (RLS is on and there is no policy, so a grant would be inert today and a trap the day someone adds one)', writable_cols;
  END IF;

  -- THE DOUBLE-JOIN GUARANTEE, asserted as the composite PK it must be. A
  -- unique index on crew_id alone would allow one crew; on user_id alone, one
  -- crew per person ever.
  SELECT string_agg(a.attname, ',' ORDER BY k.ord) INTO pk_cols
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON TRUE
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
   WHERE n.nspname = 'public' AND t.relname = 'layover_crew_members' AND c.contype = 'p'
   GROUP BY c.oid;
  IF pk_cols IS DISTINCT FROM 'crew_id,user_id' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2984): layover_crew_members primary key is (%), expected (crew_id,user_id) -- one membership per person per crew', coalesce(pk_cols, 'none');
  END IF;

  -- NO COORDINATES. The precision ladder that would decide whether a crew
  -- member's position may be shown (LOCATION_PRECISIONS,
  -- evaluateCrewLocationShare) has no grant store, so a column to put one in
  -- must not exist yet. Asserted so a later ALTER has to argue with this file.
  SELECT count(*) INTO coord_cols
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name IN ('layover_crews','layover_crew_members')
     AND column_name IN ('lat','lng','latitude','longitude','location','geog','geom','point','coords');
  IF coord_cols <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2984): % coordinate column(s) on the crew tables. §14 gates a crew member''s position on an explicit temporary permission whose grant store does not exist; a column to hold one before the thing that guards it is how a leak gets built.', coord_cols;
  END IF;
END $$;

COMMIT;
