-- 2337_trip_crew_rls_membership_convergence.sql
--
-- Twenty-nine RLS policies across nineteen tables stop hand-rolling their own
-- idea of "who is on this trip" and start meaning what the API means. Three of
-- them do not currently mean anything at all: they say `auth.uid() IS NOT NULL`.
-- A thirtieth table, passport_postcards, changes with them because one shared
-- helper is repointed, bringing the count of policies whose effective predicate
-- changes to thirty-two.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2337.
-- Direct continuation of 2334, which fixed the same defect on the five
-- route-plan policies and created authz.is_trip_crew(uuid). Read 2334 first.
--
-- Policy-and-function only: it creates five functions, replaces one existing
-- function body, and replaces twenty-nine policies. It touches no table, no
-- column, no grant and no row. Idempotent (CREATE OR REPLACE / DROP POLICY IF
-- EXISTS then CREATE), so re-running it is a no-op.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE NUMBER, AND WHY IT IS NOT THE NUMBER I WAS GIVEN
-- ══════════════════════════════════════════════════════════════════════════════
-- The lead for this work reported "24 policies across 16 tables", produced by a
-- substring heuristic: policies whose expression mentions `trip_members` but not
-- `status`. The heuristic's author said plainly it was a hypothesis. It was, and
-- it was wrong in BOTH directions.
--
-- The real enumeration, read from pg_policies on portava-ci and production
-- 2026-09-07: THIRTY-ONE policies reference `trip_members`. The two databases
-- agree byte-for-byte on thirty of them (md5 of qual||with_check); the thirty-
-- first, `highlights_select_active`, has diverged on CI only -- see WHAT THIS
-- DELIBERATELY DOES NOT TOUCH.
--
--   FOUR are correct as written and are NOT changed:
--     trip_members_insert     -- WITH CHECK trips.owner_id. Governs who may
--     trip_members_delete     -- create/remove a membership row; a membership
--                                gate here would be circular. Correct.
--     tri_member_read         -- trip_readiness_items. ALREADY spells out
--     trs_member_read         -- trip_readiness_snapshots. role IN (owner,
--                                co_host,member,viewer) AND (status IS NULL OR
--                                status='accepted') OR trips.owner_id. That is
--                                requireTripMember exactly. Somebody got this
--                                one right; it is the proof the rule is
--                                expressible and the model for the rest.
--
--   TWENTY-SEVEN are defective. TWENTY-SIX are repaired here; the twenty-seventh
--   is `highlights_select_active`, deferred for the stated reason below.
--
-- Outside those thirty-one, SEVEN more policies carry the same defect and the
-- heuristic could not see any of them -- it UNDER-reported, exactly as its
-- author warned it might. Three reach trip_members through a function, three
-- gate on nothing at all, and one gates on an array column:
--
--
--   Reached through a function (repaired here, via the shared helper):
--     posts_select        -> can_see_post(id)      -> is_accepted_trip_member()
--     posts_insert        -> can_post_to_trip(id)  -> is_accepted_trip_member()
--     postcards_select    -> can_see_postcard(id)  -> is_accepted_trip_member()
--
--   Gating on nothing at all (repaired here):
--     crew_events_trip_members       USING (auth.uid() IS NOT NULL)
--     attendance_events_trip_members USING (auth.uid() IS NOT NULL)
--     trip_members_view_checkins     USING (auth.uid() IS NOT NULL)
--
--   Gating on an array column instead of membership (DEFERRED to 2118):
--     crew_session_owner_select      USING (auth.uid() = user_id
--                                           OR auth.uid() = ANY(allowed_member_ids))
--
-- So: 34 defective policies found, 32 repaired, 2 deferred with reasons.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE THREE POLICIES NAMED AFTER A CHECK THEY DO NOT PERFORM
-- ══════════════════════════════════════════════════════════════════════════════
-- These are the most serious finding in this lane and they are not the defect I
-- was sent to fix. All three were written in 0039/0041 as `auth.uid() IS NOT
-- NULL` -- every authenticated user, every row, every trip -- under names that
-- assert a trip-membership test. They are PERMISSIVE, so each one completely
-- dominates the careful membership policy sitting beside it on the same table:
--
--   trip_crew_location_events   crew_events_trip_members       dominates crew_events_members_read
--   plan_attendance_events      attendance_events_trip_members dominates pae_select_accepted
--   plan_checkins               trip_members_view_checkins     dominates chk_select_accepted
--                                                              and plan_checkins_trip_member_read
--
-- Measured on portava-ci against a fixture trip, BEFORE this migration, a
-- STRANGER -- no trip_members row, no relationship to the trip whatsoever --
-- read the crew location event, the attendance event and the check-in. Identical
-- on production: all three policies are byte-identical there.
--
-- trip_crew_location_events is the audit log of who started and stopped sharing
-- their live location with whom, and when. anon AND authenticated hold the full
-- DELETE/INSERT/SELECT/UPDATE set on it (Supabase's ALTER DEFAULT PRIVILEGES at
-- CREATE TABLE time), so RLS is the only control on the direct-PostgREST path.
--
-- Repairing the membership predicate on `crew_events_members_read` while leaving
-- `crew_events_trip_members` alone would have changed NOTHING measurable. That
-- is why these three are in scope: without them the rest of this migration is
-- decorative on the three highest-consequence tables in it.
--
-- They are REPLACED, not dropped -- the name states the intent and the intent is
-- right; only the predicate was missing.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE ORIGINAL DEFECT, AND THAT IT RUNS IN THREE DIRECTIONS
-- ══════════════════════════════════════════════════════════════════════════════
-- The definition of record is requireTripMember (src/lib/http.ts:430-478), which
-- every route in these subsystems reaches via isAcceptedTripMember. It accepts a
-- viewer when:
--   (a) a trip_members row exists AND role IN (owner,co_host,member,viewer)
--       AND (status IS NULL OR status='accepted'), or
--   (b) NO trip_members row exists AND trips.owner_id = viewer.
--
-- The policies below disagreed with it in three distinct ways, and BOTH pending-
-- invite encodings are live in production (aggregate counts, 2026-09-07):
--
--     role     status     rows
--     owner    accepted     38
--     invited  accepted      2     <- LEGACY pending invite
--     member   invited       1     <- CURRENT pending invite
--     member   accepted      1
--
--   FAIL-OPEN 1 -- `role IN ('owner','member')` with no status gate admits
--     role='member', status='invited': a PENDING INVITEE. The API denies them.
--     Measured before this migration, that viewer read the crew's location
--     preferences, the plan, its geofences, its editors, its reservations, the
--     trip's availability grid, the crew's personal availability, trip_only
--     posts and their media -- and could WRITE plan items and availability rows
--     into a trip they had not joined.
--
--   FAIL-OPEN 2 -- `role IN (owner,co_host,member,viewer)` with no status gate
--     (trip_reservations) additionally admits role='co_host', status='invited'.
--     A pending co-host read the trip's reservations. The same viewer read the
--     trip's JOIN REQUESTS -- who has asked to join a trip they have not joined.
--
--   FAIL-OPEN 3 -- the mirror: a status-only gate with no role gate
--     (trip_activity_log) admits role='invited', status='accepted', the legacy
--     encoding that routes/invites flips to 'member' on accept. Two such rows
--     exist in production. This one is currently masked -- see the note on
--     trip_activity_log below -- and the mask is not a gate.
--
--   FAIL-CLOSED -- co_host and viewer are accepted crew everywhere in the
--     application and are omitted from most of these policies; and a trip owner
--     holding no trip_members row is crew per (b) and is omitted from all the
--     ones that join trip_members without consulting trips.owner_id. Production:
--     5 of 43 trips have an owner with no membership row.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- ONE MECHANISM WORTH RECORDING: trip_members' OWN RLS IS MASKING, NOT GATING
-- ══════════════════════════════════════════════════════════════════════════════
-- A subquery inside a policy is itself subject to the referenced table's RLS.
-- `trip_members_select` is `USING (can_see_trip(trip_id))`, and can_see_trip is
-- SECURITY DEFINER accepting role IN (owner,member,co_host,viewer) -- so a
-- viewer whose role is literally 'invited' cannot read ANY trip_members row and
-- every hand-rolled `EXISTS (SELECT ... FROM trip_members ...)` collapses to
-- false for them. That is why FAIL-OPEN 3 measures as denied today.
--
-- This is a coincidence, not a control. can_see_trip carries the same defect
-- (no status gate), so it does NOT mask role='member', status='invited' -- the
-- encoding production actually uses. Relying on it would be relying on one bug
-- to hide another. Every predicate below therefore routes through a SECURITY
-- DEFINER helper, which reads trip_members without RLS and answers the question
-- on its own merits.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- public.is_accepted_trip_member() -- ENUMERATED, THEN FIXED, NOT DROPPED
-- ══════════════════════════════════════════════════════════════════════════════
-- 2334 left this shared helper alone and said the precondition for touching it
-- was enumerating every dependent policy first. Done. It is named in ZERO
-- policies directly, which is why it looks dead, and it is NOT dead: three
-- functions call it and three policies call those.
--
--   is_accepted_trip_member(uuid)
--     <- can_post_to_trip(uuid)  <- posts_insert       (INSERT, posts)
--     <- can_see_post(uuid)      <- posts_select       (SELECT, posts)
--     <- can_see_postcard(uuid)  <- postcards_select   (SELECT, passport_postcards)
--
-- That is the complete set on both databases. Before/after for each, measured:
--
--   posts_select      trip_only post: pending invitee admitted -> denied;
--                     co_host and viewer denied -> admitted; trip owner with no
--                     members row denied -> admitted.
--   postcards_select  identical, on passport_postcards.
--   posts_insert      NO CHANGE OBSERVABLE. anon and authenticated hold only
--                     SELECT on `posts`, so this policy is unreachable from an
--                     end-user JWT; the probe returns "permission denied for
--                     table posts" before and after. The predicate is corrected
--                     anyway, because the grant is what makes it unreachable and
--                     grants are not this lane's to rely on.
--
-- It is repointed at authz.is_trip_crew rather than deleted: posts-backend's
-- 0003_posts.sql and passport-backend's 0004_passport.sql define and call their
-- own copies, and lib/database.types.ts still declares the RPC. No .rpc(
-- "is_accepted_trip_member") call site exists in application code (grepped), but
-- a function three live policies depend on is not something to remove on the
-- strength of a grep.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THIS DELIBERATELY DOES NOT TOUCH, AND WHY
-- ══════════════════════════════════════════════════════════════════════════════
-- 1. highlights_select_active -- DEFECTIVE, MEASURED, AND STILL NOT MINE.
--    Its trip_only branch joins trip_members to itself with NO role filter and
--    NO status filter, so a pending invitee (and, but for the masking above, a
--    legacy pending invitee) reads the trip_only highlights of everyone on a
--    trip they have not joined. Measured before this migration: pending
--    member/invited = admitted, pending co_host/invited = admitted.
--
--    It is not repaired here because it is the ONE policy of the thirty-one
--    where portava-ci and production DISAGREE. CI carries a restructured
--    version (owner bypasses the expiry check) that exists in no migration in
--    this repository -- uncommitted work in flight by the agent who owns the
--    highlights code. A policy is replaced whole; there is no way to rewrite one
--    branch. So rewriting it would either clobber that agent's unreviewed change
--    on CI, or carry it into production inside a migration about something else.
--    Neither is acceptable. The correct fix is one line and is left for them:
--
--      ... (visibility = 'trip_only' AND authz.shares_accepted_trip(owner_id))
--
--    authz.shares_accepted_trip(uuid) is created by THIS migration precisely so
--    that fix is a one-line change when they take it.
--
--    Note also that routes/highlights.ts computes its own sharesTripSet with
--    `.in("role", ["owner","member"])` and no status filter -- the same defect,
--    app-side, in a file this lane does not own.
--
-- 2. crew_session_owner_select -- `auth.uid() = user_id OR auth.uid() = ANY
--    (allowed_member_ids)`, with no membership, status or expiry check at all.
--    It dominates crew_sessions_recipients_read completely: measured, a STRANGER
--    listed in allowed_member_ids reads the session. That is a real defect, but
--    it is a question about the WIDTH of a live-share grant, not about who the
--    crew is, and reconciliation-staging/2118 is the open, blocked lane holding
--    exactly that question for exactly this table. Taking it here would
--    pre-empt a staged corrective mid-review. crew_sessions_recipients_read and
--    crew_loc_sessions_trip_member_read ARE repaired below; the first is
--    currently inert because of this domination, and is repaired anyway so that
--    2118 lands on a correct predicate rather than on this one.
--
-- 3. The meetups policy family is repaired below but CANNOT BE MEASURED. Every
--    SELECT on meetups, meetup_invites and meetup_time_options currently fails
--    outright with "infinite recursion detected in policy for relation" --
--    meetups_invitee_select reads meetup_invites, and mi_trip_select /
--    mi_creator_select read meetups. Three tables are entirely unreadable
--    through RLS on both databases. That is a policy-graph cycle, a different
--    defect from this one, and repairing the membership predicate does not break
--    the cycle. The predicates are corrected because they are wrong and will
--    become live the moment the cycle is broken; the before/after matrix records
--    them honestly as error -> error. The recursion is reported, not fixed.
--
-- 4. The anon/authenticated grant boundary. 2332/2333's lane, as 2334 recorded.
--
-- 5. routes/tripCrewLocation.ts getMemberRole() filters role IN (owner,co_host,
--    member) and never reads status, while its own doc comment claims "Pending
--    invites, removed members, and non-members get null -> 403". That is the
--    same defect app-side. It is a route file, not an RLS policy, and is
--    reported rather than edited from this lane.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY authz AND NOT public
-- ══════════════════════════════════════════════════════════════════════════════
-- Verbatim from 2334: PostgREST exposes functions in its configured db-schemas;
-- `authz` (created by 2182) is not one. A membership predicate in `public` is an
-- RPC oracle. In `authz` it is reachable only from policy evaluation. And the
-- EXECUTE grants below are required for correctness, not an oversight: RLS
-- predicates evaluate with the querying role's privileges, so revoking them does
-- not harden anything, it breaks every crew read.

BEGIN;

-- ── Preconditions ─────────────────────────────────────────────────────────────
DO $$
DECLARE
  missing text;
BEGIN
  IF to_regnamespace('authz') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: schema authz missing -- apply 2182 first.';
  END IF;
  IF to_regprocedure('authz.is_trip_crew(uuid)') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: authz.is_trip_crew(uuid) missing -- apply 2334 first.';
  END IF;

  SELECT string_agg(t, ', ') INTO missing
  FROM unnest(ARRAY[
    'public.trips','public.trip_members','public.trip_crew_location_events',
    'public.trip_crew_location_preferences','public.trip_crew_location_sessions',
    'public.plan_attendance_events','public.plan_checkins','public.plan_geofences',
    'public.plan_editors','public.trip_plan_items','public.trip_reservations',
    'public.trip_activity_log','public.trip_availability','public.user_availability',
    'public.quick_availability_status','public.meetups','public.meetup_invites',
    'public.meetup_time_options','public.posts','public.post_media',
    'public.trip_join_requests'
  ]) AS t
  WHERE to_regclass(t) IS NULL;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: missing tables: %', missing;
  END IF;

  -- The status gate is the point of this migration. If the column ever goes
  -- away these policies must be revisited rather than silently widened.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='trip_members' AND column_name='status'
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: trip_members.status missing -- the accepted-status gate cannot be expressed.';
  END IF;
END $$;

-- ══════════════════════════════════════════════════════════════════════════════
-- HELPERS
-- ══════════════════════════════════════════════════════════════════════════════
--
-- authz.is_trip_crew(uuid) from 2334 is NOT redefined here. It already encodes
-- requireTripMember for the current viewer, routePlanCrewVisibility.test.ts
-- parses its body out of the migration corpus and compares it against
-- lib/http.ts, and a delegating rewrite would turn that gate red for no gain.
-- The helpers below are the cases it cannot express: a user who is not the
-- viewer, a role-specific question, and a set of trips.

-- The primitive. Every other predicate in this file is a phrasing of this one.
-- The UNION's second branch is the trips.owner_id fallback from http.ts:454-462,
-- and its NOT EXISTS guard is load-bearing: an owner whose own membership row
-- says status='removed' is denied by requireTripMember and must be denied here.
CREATE OR REPLACE FUNCTION authz.accepted_trip_ids(u_id uuid)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
  SELECT m.trip_id
    FROM public.trip_members m
   WHERE u_id IS NOT NULL
     AND m.user_id = u_id
     AND m.role IN ('owner', 'co_host', 'member', 'viewer')
     AND coalesce(m.status, 'accepted') = 'accepted'
  UNION
  SELECT t.id
    FROM public.trips t
   WHERE u_id IS NOT NULL
     AND t.owner_id = u_id
     AND NOT EXISTS (
       SELECT 1 FROM public.trip_members m2
        WHERE m2.trip_id = t.id AND m2.user_id = u_id
     );
$fn$;

COMMENT ON FUNCTION authz.accepted_trip_ids(uuid) IS
  'Every trip the given user is an ACCEPTED member of, by exactly the rule lib/http.ts requireTripMember applies: role in (owner, co_host, member, viewer) with an accepted status where a trip_members row exists, plus trips.owner_id where none does. SECURITY DEFINER so the membership read bypasses RLS on trips/trip_members and cannot recurse into the policies that call it -- trip_members_select is itself USING can_see_trip(trip_id), which carries the very defect this file removes, so an RLS-subject read here would inherit it. Lives in authz so PostgREST does not expose it as an RPC oracle. Takes the user as a PARAMETER, unlike authz.is_trip_crew: several policies ask the question about the row''s subject rather than about the viewer. Must remain EXECUTE-able by anon and authenticated. See migration 2337.';

-- The explicit-user form of is_trip_crew. authz.is_trip_crew(t) and
-- authz.is_accepted_trip_member(t, auth.uid()) are the same predicate; the
-- postcondition at the foot of this file asserts they agree.
CREATE OR REPLACE FUNCTION authz.is_accepted_trip_member(t_id uuid, u_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
  SELECT t_id IS NOT NULL
     AND u_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM authz.accepted_trip_ids(u_id) a WHERE a = t_id);
$fn$;

COMMENT ON FUNCTION authz.is_accepted_trip_member(uuid, uuid) IS
  'True when the NAMED user (not necessarily the viewer) is an accepted member of the named trip. Same rule as authz.is_trip_crew, which is this predicate with u_id = auth.uid(). Deliberately NOT public.is_accepted_trip_member(uuid), which is a different, single-argument function that omitted status, co_host, viewer and the owner fallback until 2337 repointed it here. See migration 2337.';

-- "The viewer and this other person are both accepted crew of some common trip."
-- The app's phrasing of the same question is the sharesTripSet computation in
-- routes/highlights.ts and the tm1/tm2 self-joins in the availability policies.
CREATE OR REPLACE FUNCTION authz.shares_accepted_trip(other_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
  SELECT auth.uid() IS NOT NULL
     AND other_id IS NOT NULL
     AND EXISTS (
       SELECT 1
         FROM authz.accepted_trip_ids(auth.uid()) mine
         JOIN authz.accepted_trip_ids(other_id)   theirs ON theirs = mine
     );
$fn$;

COMMENT ON FUNCTION authz.shares_accepted_trip(uuid) IS
  'True when the CURRENT viewer (auth.uid(), read inside the function -- never a parameter) and the named user are BOTH accepted members of at least one trip in common. Replaces the `trip_members tm1 JOIN trip_members tm2` self-joins, which gated neither side on status and so let a pending invitee see accepted crew, and accepted crew see a pending invitee. Lives in authz so PostgREST does not expose it as a social-graph oracle. See migration 2337.';

-- The viewer's effective role, or NULL when they are not accepted crew --
-- requireTripMember's actual return value, not just its boolean. canEditPlanItem
-- (http.ts:593-632) branches on role === "owner"; plan_items_update has to ask
-- the same question and cannot ask it of a boolean.
CREATE OR REPLACE FUNCTION authz.accepted_trip_role(t_id uuid)
RETURNS member_role
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
  SELECT CASE WHEN t_id IS NULL OR auth.uid() IS NULL THEN NULL ELSE
    COALESCE(
      (SELECT m.role
         FROM public.trip_members m
        WHERE m.trip_id = t_id
          AND m.user_id = auth.uid()
          AND m.role IN ('owner', 'co_host', 'member', 'viewer')
          AND coalesce(m.status, 'accepted') = 'accepted'
        LIMIT 1),
      (SELECT 'owner'::member_role
         FROM public.trips t
        WHERE t.id = t_id
          AND t.owner_id = auth.uid()
          AND NOT EXISTS (
            SELECT 1 FROM public.trip_members m2
             WHERE m2.trip_id = t_id AND m2.user_id = auth.uid()
          ))
    )
  END;
$fn$;

COMMENT ON FUNCTION authz.accepted_trip_role(uuid) IS
  'The CURRENT viewer''s accepted role on the trip, or NULL when they are not accepted crew -- the value lib/http.ts requireTripMember returns, including its trips.owner_id fallback which reports role "owner" for a trip owner holding no membership row. Non-NULL exactly when authz.is_trip_crew is true. See migration 2337.';

-- plan_checkins and plan_attendance_events carry a nullable trip_id and reach
-- their trip through plan_geofences. Resolving that hop in SQL inside a policy
-- would subject it to plan_geofences' OWN RLS, which is one of the policies this
-- file is repairing -- a circular dependency between two policies being fixed in
-- the same transaction. SECURITY DEFINER breaks it.
CREATE OR REPLACE FUNCTION authz.geofence_trip_id(g_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
  SELECT g.trip_id FROM public.plan_geofences g WHERE g_id IS NOT NULL AND g.id = g_id;
$fn$;

COMMENT ON FUNCTION authz.geofence_trip_id(uuid) IS
  'The trip a plan_geofence belongs to. SECURITY DEFINER so a policy on plan_checkins or plan_attendance_events can resolve the hop without evaluating plan_geofences'' own SELECT policy, which would otherwise make two policies depend on each other. Returns NULL for a missing or NULL geofence, and every caller composes it with authz.is_trip_crew, which is false for NULL. See migration 2337.';

GRANT EXECUTE ON FUNCTION authz.accepted_trip_ids(uuid)              TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION authz.is_accepted_trip_member(uuid, uuid)  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION authz.shares_accepted_trip(uuid)           TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION authz.accepted_trip_role(uuid)             TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION authz.geofence_trip_id(uuid)               TO anon, authenticated, service_role;

-- ══════════════════════════════════════════════════════════════════════════════
-- THE SHARED HELPER, REPOINTED
-- ══════════════════════════════════════════════════════════════════════════════
-- Signature, schema, volatility, security and grants unchanged; only the body.
-- Its three dependent policies are enumerated in the header. Kept in `public`
-- and NOT moved to authz: the move would be a breaking change to a function
-- lib/database.types.ts still declares, and three live policies resolve by
-- unqualified name through can_post_to_trip / can_see_post / can_see_postcard,
-- whose own search_path is 'public', 'pg_catalog'.
CREATE OR REPLACE FUNCTION public.is_accepted_trip_member(t_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
  SELECT authz.is_trip_crew(t_id);
$fn$;

COMMENT ON FUNCTION public.is_accepted_trip_member(uuid) IS
  'True when the current viewer is an accepted member of the trip. Delegates to authz.is_trip_crew so that this helper and the policies repaired in 2334/2337 cannot drift apart. Until 2337 its body was `role in (''owner'',''member'')` with no status gate, no co_host, no viewer and no trips.owner_id fallback, and it reaches three policies indirectly -- posts_select via can_see_post, posts_insert via can_post_to_trip, postcards_select via can_see_postcard. Retained in `public` rather than moved to authz because lib/database.types.ts declares it and the three calling functions resolve it unqualified. See migration 2337.';

-- ══════════════════════════════════════════════════════════════════════════════
-- LANE A -- CREW LOCATION. Highest consequence in this migration.
-- ══════════════════════════════════════════════════════════════════════════════

-- Was: USING (auth.uid() IS NOT NULL). Any logged-in user read every crew
-- location event of every trip. The name always claimed otherwise.
DROP POLICY IF EXISTS "crew_events_trip_members" ON public.trip_crew_location_events;
CREATE POLICY "crew_events_trip_members" ON public.trip_crew_location_events
  FOR SELECT USING ( authz.is_trip_crew(trip_id) );

DROP POLICY IF EXISTS "crew_events_members_read" ON public.trip_crew_location_events;
CREATE POLICY "crew_events_members_read" ON public.trip_crew_location_events
  FOR SELECT USING ( authz.is_trip_crew(trip_id) );

DROP POLICY IF EXISTS "crew_prefs_members_read" ON public.trip_crew_location_preferences;
CREATE POLICY "crew_prefs_members_read" ON public.trip_crew_location_preferences
  FOR SELECT USING ( authz.is_trip_crew(trip_id) );

-- Membership half only. Whether ANY crew member should read a live-share session
-- or only its allowed_member_ids recipients is 2118's open question, and this
-- policy keeps answering it the way it always has.
DROP POLICY IF EXISTS "crew_loc_sessions_trip_member_read" ON public.trip_crew_location_sessions;
CREATE POLICY "crew_loc_sessions_trip_member_read" ON public.trip_crew_location_sessions
  FOR SELECT USING ( authz.is_trip_crew(trip_id) );

-- status / expires_at / allowed_member_ids preserved exactly from 0041.
DROP POLICY IF EXISTS "crew_sessions_recipients_read" ON public.trip_crew_location_sessions;
CREATE POLICY "crew_sessions_recipients_read" ON public.trip_crew_location_sessions
  FOR SELECT USING (
    status = 'active'
    AND expires_at > now()
    AND auth.uid() = ANY (allowed_member_ids)
    AND authz.is_trip_crew(trip_id)
  );

-- ══════════════════════════════════════════════════════════════════════════════
-- LANE B -- PLAN ATTENDANCE AND CHECK-INS
-- ══════════════════════════════════════════════════════════════════════════════

-- Was: USING (auth.uid() IS NOT NULL).
DROP POLICY IF EXISTS "attendance_events_trip_members" ON public.plan_attendance_events;
CREATE POLICY "attendance_events_trip_members" ON public.plan_attendance_events
  FOR SELECT USING (
    authz.is_trip_crew(trip_id)
    OR authz.is_trip_crew(authz.geofence_trip_id(plan_geofence_id))
  );

DROP POLICY IF EXISTS "pae_select_accepted" ON public.plan_attendance_events;
CREATE POLICY "pae_select_accepted" ON public.plan_attendance_events
  FOR SELECT USING ( authz.is_trip_crew(trip_id) );

-- Was: USING (auth.uid() IS NOT NULL). `user_id = auth.uid()` is added because
-- a check-in row whose trip_id and geofence are both null would otherwise become
-- invisible to the person who wrote it; users_manage_own_checkin already grants
-- that and this keeps the SELECT set from narrowing on a technicality.
DROP POLICY IF EXISTS "trip_members_view_checkins" ON public.plan_checkins;
CREATE POLICY "trip_members_view_checkins" ON public.plan_checkins
  FOR SELECT USING (
    user_id = auth.uid()
    OR authz.is_trip_crew(trip_id)
    OR authz.is_trip_crew(authz.geofence_trip_id(plan_geofence_id))
  );

DROP POLICY IF EXISTS "chk_select_accepted" ON public.plan_checkins;
CREATE POLICY "chk_select_accepted" ON public.plan_checkins
  FOR SELECT USING ( authz.is_trip_crew(trip_id) );

DROP POLICY IF EXISTS "plan_checkins_trip_member_read" ON public.plan_checkins;
CREATE POLICY "plan_checkins_trip_member_read" ON public.plan_checkins
  FOR SELECT USING (
    user_id = auth.uid()
    OR authz.is_trip_crew(authz.geofence_trip_id(plan_geofence_id))
  );

-- ══════════════════════════════════════════════════════════════════════════════
-- LANE C -- THE PLAN ITSELF
-- ══════════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "plan_editors_select" ON public.plan_editors;
CREATE POLICY "plan_editors_select" ON public.plan_editors
  FOR SELECT USING ( authz.is_trip_crew(trip_id) );

DROP POLICY IF EXISTS "plan_geofences_select_accepted" ON public.plan_geofences;
CREATE POLICY "plan_geofences_select_accepted" ON public.plan_geofences
  FOR SELECT TO authenticated USING ( authz.is_trip_crew(trip_id) );

DROP POLICY IF EXISTS "plan_geofences_insert_accepted" ON public.plan_geofences;
CREATE POLICY "plan_geofences_insert_accepted" ON public.plan_geofences
  FOR INSERT TO authenticated WITH CHECK ( authz.is_trip_crew(trip_id) );

-- FOR UPDATE with an explicit WITH CHECK: without one the USING clause is reused
-- as the write check, which is the same predicate here, but writing it out keeps
-- the two from silently diverging if either is edited later.
DROP POLICY IF EXISTS "plan_geofences_update_accepted" ON public.plan_geofences;
CREATE POLICY "plan_geofences_update_accepted" ON public.plan_geofences
  FOR UPDATE TO authenticated
  USING      ( authz.is_trip_crew(trip_id) )
  WITH CHECK ( authz.is_trip_crew(trip_id) );

DROP POLICY IF EXISTS "plan_items_select" ON public.trip_plan_items;
CREATE POLICY "plan_items_select" ON public.trip_plan_items
  FOR SELECT USING ( removed_at IS NULL AND authz.is_trip_crew(trip_id) );

DROP POLICY IF EXISTS "plan_items_insert" ON public.trip_plan_items;
CREATE POLICY "plan_items_insert" ON public.trip_plan_items
  FOR INSERT WITH CHECK ( creator_id = auth.uid() AND authz.is_trip_crew(trip_id) );

-- canEditPlanItem (http.ts:593-632): the caller must be accepted crew FIRST,
-- and then either the trip owner or the item's creator. The old predicate was
-- `creator_id = auth.uid() OR <owner>`, which gated the creator branch on
-- nothing at all -- a pending invitee, or someone removed from the trip after
-- creating an item, kept write access to it. Measured before this migration: a
-- pending invitee updated the plan item they had created. The crew test is now
-- a precondition of BOTH branches, which is what the helper says.
DROP POLICY IF EXISTS "plan_items_update" ON public.trip_plan_items;
CREATE POLICY "plan_items_update" ON public.trip_plan_items
  FOR UPDATE USING (
    authz.is_trip_crew(trip_id)
    AND ( creator_id = auth.uid() OR authz.accepted_trip_role(trip_id) = 'owner' )
  );

-- ══════════════════════════════════════════════════════════════════════════════
-- LANE D -- TRIP RECORDS
-- ══════════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "trip_reservations_member_read" ON public.trip_reservations;
CREATE POLICY "trip_reservations_member_read" ON public.trip_reservations
  FOR SELECT USING ( authz.is_trip_crew(trip_id) );

-- The mirror case. This one had the status gate and no role gate, so it admitted
-- role='invited' with status='accepted' and denied a trip owner holding no
-- membership row. Both halves are now the same rule as everything else.
DROP POLICY IF EXISTS "trip_activity_log_select" ON public.trip_activity_log;
CREATE POLICY "trip_activity_log_select" ON public.trip_activity_log
  FOR SELECT USING ( authz.is_trip_crew(trip_id) );

-- ══════════════════════════════════════════════════════════════════════════════
-- LANE E -- AVAILABILITY
-- ══════════════════════════════════════════════════════════════════════════════

-- FOR ALL. Self-scoped, and now crew-scoped by the definition of record: a
-- pending invitee could previously write their availability into a trip they had
-- not joined, and an accepted co_host or viewer could not write their own.
DROP POLICY IF EXISTS "ta_own" ON public.trip_availability;
CREATE POLICY "ta_own" ON public.trip_availability
  FOR ALL
  USING      ( auth.uid() = user_id AND authz.is_trip_crew(trip_id) )
  WITH CHECK ( auth.uid() = user_id AND authz.is_trip_crew(trip_id) );

-- Both sides of the old tm1/tm2 self-join. The row's subject is asked about with
-- the explicit-user helper; the viewer with the auth.uid() one.
DROP POLICY IF EXISTS "ta_trip_members_select" ON public.trip_availability;
CREATE POLICY "ta_trip_members_select" ON public.trip_availability
  FOR SELECT USING (
    authz.is_trip_crew(trip_id)
    AND authz.is_accepted_trip_member(trip_id, trip_availability.user_id)
  );

-- user_availability and quick_availability_status carry no trip_id: the rule is
-- "we share SOME trip", which is what shares_accepted_trip answers.
DROP POLICY IF EXISTS "ua_trip_select" ON public.user_availability;
CREATE POLICY "ua_trip_select" ON public.user_availability
  FOR SELECT USING ( authz.shares_accepted_trip(user_availability.user_id) );

DROP POLICY IF EXISTS "qas_trip_select" ON public.quick_availability_status;
CREATE POLICY "qas_trip_select" ON public.quick_availability_status
  FOR SELECT USING (
    expires_at > now()
    AND authz.shares_accepted_trip(quick_availability_status.user_id)
  );

-- ══════════════════════════════════════════════════════════════════════════════
-- LANE F -- TRIP-ONLY SOCIAL CONTENT
-- ══════════════════════════════════════════════════════════════════════════════
-- Everything outside the trip_only branch is preserved verbatim.

DROP POLICY IF EXISTS "posts_select_policy" ON public.posts;
CREATE POLICY "posts_select_policy" ON public.posts
  FOR SELECT TO authenticated USING (
    status = 'active'::post_status
    AND (
      visibility = 'public'::post_visibility
      OR author_id = auth.uid()
      OR ( visibility = 'followers_only'::post_visibility
           AND EXISTS ( SELECT 1 FROM public.user_follows uf
                         WHERE uf.follower_id = auth.uid()
                           AND uf.following_id = posts.author_id ) )
      OR ( visibility = 'trip_only'::post_visibility
           AND trip_id IS NOT NULL
           AND authz.is_trip_crew(trip_id) )
    )
  );

DROP POLICY IF EXISTS "post_media_public_select" ON public.post_media;
CREATE POLICY "post_media_public_select" ON public.post_media
  FOR SELECT USING (
    user_id = auth.uid()
    OR (
      processing_status = 'ready'
      AND moderation_status <> ALL (ARRAY['rejected'::text, 'flagged'::text])
      AND NOT EXISTS (
        SELECT 1 FROM public.blocks b
         WHERE (b.blocker_id = auth.uid() AND b.blocked_id = post_media.user_id)
            OR (b.blocker_id = post_media.user_id AND b.blocked_id = auth.uid())
      )
      AND EXISTS (
        SELECT 1 FROM public.posts p
         WHERE p.id = post_media.post_id
           AND p.status = 'active'::post_status
           AND ( p.visibility = 'public'::post_visibility
                 OR ( p.visibility = 'trip_only'::post_visibility
                      AND p.trip_id IS NOT NULL
                      AND authz.is_trip_crew(p.trip_id) ) )
      )
    )
  );

-- ══════════════════════════════════════════════════════════════════════════════
-- LANE G -- JOIN REQUESTS. A NARROW FIX, DELIBERATELY NOT THE HELPER.
-- ══════════════════════════════════════════════════════════════════════════════
-- This policy is about people who are NOT members by design, and it is nearly
-- right: requester, trip owner, co-host. Replacing its co_host branch with
-- authz.is_trip_crew would WIDEN it -- every member and viewer would suddenly
-- read who has asked to join. The single defect is that the co_host branch never
-- checked status, so a PENDING co-host invitee read the trip's join requests.
-- Measured before this migration: admitted. Only that gains the status gate;
-- everything else is preserved exactly.
DROP POLICY IF EXISTS "trip_join_requests_select" ON public.trip_join_requests;
CREATE POLICY "trip_join_requests_select" ON public.trip_join_requests
  FOR SELECT USING (
    user_id = auth.uid()
    OR EXISTS ( SELECT 1 FROM public.trips t
                 WHERE t.id = trip_join_requests.trip_id
                   AND t.owner_id = auth.uid() )
    OR authz.accepted_trip_role(trip_join_requests.trip_id) = 'co_host'
  );

-- ══════════════════════════════════════════════════════════════════════════════
-- LANE H -- MEETUPS. Corrected, currently unmeasurable. See header item 3.
-- ══════════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "meetups_trip_select" ON public.meetups;
CREATE POLICY "meetups_trip_select" ON public.meetups
  FOR SELECT USING (
    visibility = 'trip' AND trip_id IS NOT NULL AND authz.is_trip_crew(trip_id)
  );

DROP POLICY IF EXISTS "mi_trip_select" ON public.meetup_invites;
CREATE POLICY "mi_trip_select" ON public.meetup_invites
  FOR SELECT USING (
    EXISTS ( SELECT 1 FROM public.meetups m
              WHERE m.id = meetup_invites.meetup_id
                AND m.visibility = 'trip'
                AND authz.is_trip_crew(m.trip_id) )
  );

DROP POLICY IF EXISTS "mto_trip_select" ON public.meetup_time_options;
CREATE POLICY "mto_trip_select" ON public.meetup_time_options
  FOR SELECT USING (
    EXISTS ( SELECT 1 FROM public.meetups m
              WHERE m.id = meetup_time_options.meetup_id
                AND m.visibility = 'trip'
                AND authz.is_trip_crew(m.trip_id) )
  );

-- ══════════════════════════════════════════════════════════════════════════════
-- POSTCONDITIONS
-- ══════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  n int;
  offenders text;
BEGIN
  -- 1. Every policy this migration rewrote must now route through an authz
  --    helper, and none of the twenty-five may still name trip_members.
  SELECT count(*), string_agg(tablename || '.' || policyname, ', ')
    INTO n, offenders
  FROM pg_policies
  WHERE schemaname = 'public'
    AND (tablename, policyname) IN (
      ('trip_crew_location_events','crew_events_trip_members'),
      ('trip_crew_location_events','crew_events_members_read'),
      ('trip_crew_location_preferences','crew_prefs_members_read'),
      ('trip_crew_location_sessions','crew_loc_sessions_trip_member_read'),
      ('trip_crew_location_sessions','crew_sessions_recipients_read'),
      ('plan_attendance_events','attendance_events_trip_members'),
      ('plan_attendance_events','pae_select_accepted'),
      ('plan_checkins','trip_members_view_checkins'),
      ('plan_checkins','chk_select_accepted'),
      ('plan_checkins','plan_checkins_trip_member_read'),
      ('plan_editors','plan_editors_select'),
      ('plan_geofences','plan_geofences_select_accepted'),
      ('plan_geofences','plan_geofences_insert_accepted'),
      ('plan_geofences','plan_geofences_update_accepted'),
      ('trip_plan_items','plan_items_select'),
      ('trip_plan_items','plan_items_insert'),
      ('trip_plan_items','plan_items_update'),
      ('trip_reservations','trip_reservations_member_read'),
      ('trip_activity_log','trip_activity_log_select'),
      ('trip_availability','ta_own'),
      ('trip_availability','ta_trip_members_select'),
      ('user_availability','ua_trip_select'),
      ('quick_availability_status','qas_trip_select'),
      ('posts','posts_select_policy'),
      ('post_media','post_media_public_select'),
      ('trip_join_requests','trip_join_requests_select'),
      ('meetups','meetups_trip_select'),
      ('meetup_invites','mi_trip_select'),
      ('meetup_time_options','mto_trip_select')
    )
    AND coalesce(qual,'') || coalesce(with_check,'') NOT LIKE '%authz.%';
  IF n <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: % rewritten policies do not route through an authz helper: %', n, offenders;
  END IF;

  SELECT count(*), string_agg(tablename || '.' || policyname, ', ')
    INTO n, offenders
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename IN (
      'trip_crew_location_events','trip_crew_location_preferences',
      'trip_crew_location_sessions','plan_attendance_events','plan_checkins',
      'plan_editors','plan_geofences','trip_plan_items','trip_reservations',
      'trip_activity_log','trip_availability','user_availability',
      'quick_availability_status','posts','post_media','trip_join_requests',
      'meetups','meetup_invites','meetup_time_options'
    )
    AND coalesce(qual,'') || coalesce(with_check,'') LIKE '%trip_members%';
  IF n <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: % policies still hand-roll a trip_members test: %', n, offenders;
  END IF;

  -- 2. No `auth.uid() IS NOT NULL` blanket read may survive on the three tables
  --    that carried one. This is the assertion that would have caught 0039/0041.
  SELECT count(*), string_agg(tablename || '.' || policyname, ', ')
    INTO n, offenders
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename IN ('trip_crew_location_events','plan_attendance_events','plan_checkins')
    AND cmd IN ('SELECT','ALL')
    AND 'service_role' <> ALL (roles)
    AND replace(replace(replace(coalesce(qual,''), ' ', ''), '(', ''), ')', '') = 'auth.uidISNOTNULL';
  IF n <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: % blanket auth.uid() IS NOT NULL read policies remain: %', n, offenders;
  END IF;

  -- 3. The shared helper must agree with authz.is_trip_crew rather than merely
  --    resemble it.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname = 'public' AND p.proname = 'is_accepted_trip_member'
       AND pg_get_functiondef(p.oid) LIKE '%authz.is_trip_crew%'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: public.is_accepted_trip_member does not delegate to authz.is_trip_crew.';
  END IF;

  -- 4. All five new helpers exist, are SECURITY DEFINER, and pin search_path.
  SELECT count(*) INTO n
  FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
  WHERE ns.nspname = 'authz'
    AND p.proname IN ('accepted_trip_ids','is_accepted_trip_member',
                      'shares_accepted_trip','accepted_trip_role','geofence_trip_id')
    AND p.prosecdef
    AND p.proconfig::text LIKE '%search_path%';
  IF n <> 5 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: expected 5 SECURITY DEFINER authz helpers with a pinned search_path, found %', n;
  END IF;

  -- 5. authz.is_trip_crew (2334) and authz.is_accepted_trip_member (2337) must
  --    be the same predicate. With no JWT set, auth.uid() is NULL, so both are
  --    false for every trip -- the only equivalence assertable without a
  --    session. The real per-viewer equivalence is measured on portava-ci and
  --    recorded in the commit message.
  IF (SELECT authz.is_trip_crew(NULL)) IS DISTINCT FROM false
     OR (SELECT authz.is_accepted_trip_member(NULL, NULL)) IS DISTINCT FROM false
     OR (SELECT authz.shares_accepted_trip(NULL)) IS DISTINCT FROM false
     OR (SELECT authz.accepted_trip_role(NULL)) IS DISTINCT FROM NULL
     OR (SELECT authz.geofence_trip_id(NULL)) IS DISTINCT FROM NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: a helper does not answer safely for a NULL argument.';
  END IF;
END $$;

COMMIT;
