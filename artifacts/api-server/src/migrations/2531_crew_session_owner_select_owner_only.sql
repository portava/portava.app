-- 2531_crew_session_owner_select_owner_only.sql
--
-- crew_session_owner_select on trip_crew_location_sessions becomes what its
-- name says: the session's OWNER. Its second branch -- `auth.uid() = ANY
-- (allowed_member_ids)` with no membership, status or expiry test -- is
-- removed. Nothing else on the table changes.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2531 (B5).
-- Takes the second of the two policies 2337 deferred. Read 2337 first.
--
-- Policy-only: it replaces one policy. It creates no function, touches no
-- table, column, grant or row. Idempotent (DROP IF EXISTS then CREATE).
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE DEFECT, MEASURED
-- ══════════════════════════════════════════════════════════════════════════════
-- trip_crew_location_sessions carries three PERMISSIVE SELECT policies, which
-- OR together:
--
--   crew_session_owner_select          auth.uid() = user_id
--                                      OR auth.uid() = ANY (allowed_member_ids)
--   crew_loc_sessions_trip_member_read authz.is_trip_crew(trip_id)            (2337)
--   crew_sessions_recipients_read      status = 'active' AND expires_at > now()
--                                      AND auth.uid() = ANY (allowed_member_ids)
--                                      AND authz.is_trip_crew(trip_id)        (2337)
--
-- The first one's array branch is a superset of the third policy entirely, so
-- crew_sessions_recipients_read -- the policy that spells out "an ACTIVE,
-- UNEXPIRED share, to a RECIPIENT who is CREW" -- has never once decided
-- anything. 2337 repaired it and said so.
--
-- Measured on portava-ci 2026-09-07 (fixture trip, rolled back, viewer =
-- authenticated with a real request.jwt.claims sub), one active, one stopped
-- and one expired session owned by the trip owner, each listing the viewers
-- below in allowed_member_ids, BEFORE this migration, "reads (active, stopped,
-- expired)":
--
--   viewer                                 before      after
--   session owner                          1,1,1       1,1,1
--   accepted member (listed)               1,1,1       1,1,1
--   accepted co_host / viewer (not listed) 1,1,1       1,1,1
--   pending member, status=invited (listed) 1,1,1      0,0,0
--   legacy invited/accepted (listed)       1,1,1       0,0,0
--   REMOVED member (listed)                1,1,1       0,0,0
--   STRANGER, no trip_members row (listed) 1,1,1       0,0,0
--   owner of an unrelated trip (listed)    1,1,1       0,0,0
--
-- "after" is the OR of the two surviving policies plus the new owner-only one,
-- evaluated as each viewer against the fixture rows. anon and authenticated
-- hold SELECT on the table on both databases; RLS is the only control on the
-- direct-PostgREST path. The API reads this table through the service client.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY THIS DOES NOT PRE-EMPT reconciliation-staging/2118
-- ══════════════════════════════════════════════════════════════════════════════
-- 2337 deferred this policy because 2118 "is the open, blocked lane holding
-- exactly that question for exactly this table" -- the question being whether
-- ANY crew member may read a live-share session, or only the recipients in
-- allowed_member_ids. That was checked before writing this file:
--
--   * 2118 is STAGED, NOT APPLIED, blocked on Q3, in reconciliation-staging/,
--     committed once (a745ba11) and never updated since. It predates 2334 and
--     2337: its DROP list names crew_loc_sessions_trip_member_read and
--     crew_sessions_recipients_read in their pre-2337 forms, and its
--     postcondition expects exactly four policies on the table.
--   * 2118's converged SELECT predicate is `auth.uid() = user_id OR auth.uid()
--     = ANY(allowed_member_ids)` -- BYTE-IDENTICAL to the defective predicate
--     this migration removes. 2118 does not repair the stranger case; it
--     re-emits it. So 2118 does not "hold" this defect at all. It holds the
--     any-crew-vs-recipients question and answers it "recipients only", with
--     no membership gate on the recipient.
--
-- This migration leaves 2118's question exactly where 2337 left it:
-- crew_loc_sessions_trip_member_read still admits any accepted crew member,
-- and crew_sessions_recipients_read still admits crew recipients of an active
-- share. The admitted set after this migration is {owner} ∪ {accepted crew},
-- and the ONLY people who lose access are people who are NOT crew of the
-- session's trip: strangers, pending invitees, removed members. Whether 2118
-- later narrows "any crew" to "recipients only" is unaffected; if it does, it
-- must be rebased so that it does not re-emit the array branch without a crew
-- gate, and its four-policy postcondition must be rewritten against the
-- post-2337 table.
--
-- Why owner-only rather than "owner OR (listed AND crew AND active AND
-- unexpired)": that second form is crew_sessions_recipients_read verbatim, and
-- it already exists. Restating it under a second name would leave two
-- policies to keep in step and a name that lies about its contents.
--
-- DEPENDS ON: 2337 (crew_sessions_recipients_read routed through
-- authz.is_trip_crew, so recipients keep a correct read path of their own).
-- Refuses to run without it.

BEGIN;

DO $$
DECLARE
  n int;
BEGIN
  -- ── Preconditions ──────────────────────────────────────────────────────────
  IF to_regclass('public.trip_crew_location_sessions') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.trip_crew_location_sessions missing.';
  END IF;
  IF to_regprocedure('authz.is_trip_crew(uuid)') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: authz.is_trip_crew(uuid) missing -- apply 2334 and 2337 first.';
  END IF;
  -- The recipient path must already be the 2337 one. Without it the only
  -- recipient-shaped read left after this migration would be the pre-2337
  -- hand-rolled policy, and this file was not measured against that state.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'trip_crew_location_sessions'
       AND policyname = 'crew_sessions_recipients_read'
       AND qual LIKE '%authz.is_trip_crew%'
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: crew_sessions_recipients_read is not the 2337 form -- apply 2337 first.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'trip_crew_location_sessions'
       AND policyname = 'crew_loc_sessions_trip_member_read'
       AND qual LIKE '%authz.is_trip_crew%'
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: crew_loc_sessions_trip_member_read is not the 2337 form -- apply 2337 first.';
  END IF;
END $$;

-- Was: (auth.uid() = user_id) OR (auth.uid() = ANY (allowed_member_ids)).
-- Unchanged from 0041 on both databases (md5 f1295621…, verified 2026-09-07).
DROP POLICY IF EXISTS "crew_session_owner_select" ON public.trip_crew_location_sessions;
CREATE POLICY "crew_session_owner_select" ON public.trip_crew_location_sessions
  FOR SELECT USING ( auth.uid() = user_id );

DO $$
DECLARE
  n int;
  offenders text;
BEGIN
  -- ── Postconditions ─────────────────────────────────────────────────────────
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'trip_crew_location_sessions'
       AND policyname = 'crew_session_owner_select'
       AND cmd = 'SELECT'
       AND regexp_replace(qual, '\s', '', 'g') = '(auth.uid()=user_id)'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: crew_session_owner_select is not owner-only.';
  END IF;

  -- No SELECT policy on this table may admit on allowed_member_ids without
  -- ALSO requiring crew membership. This is the domination fact from 2337,
  -- made an invariant.
  SELECT count(*), string_agg(policyname, ', ')
    INTO n, offenders
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'trip_crew_location_sessions'
     AND cmd IN ('SELECT', 'ALL')
     AND 'service_role' <> ALL (roles)
     AND coalesce(qual, '') LIKE '%allowed_member_ids%'
     AND coalesce(qual, '') NOT LIKE '%authz.is_trip_crew%';
  IF n <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: % policy(ies) admit on allowed_member_ids without a crew gate: %', n, offenders;
  END IF;

  -- The two 2337 read paths must have survived untouched.
  IF (SELECT count(*) FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'trip_crew_location_sessions'
         AND policyname IN ('crew_loc_sessions_trip_member_read', 'crew_sessions_recipients_read')
         AND qual LIKE '%authz.is_trip_crew%') <> 2 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: the 2337 read paths on trip_crew_location_sessions are not intact.';
  END IF;
END $$;

COMMIT;
