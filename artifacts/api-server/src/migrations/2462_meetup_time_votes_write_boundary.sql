-- 2462_meetup_time_votes_write_boundary.sql
-- Meetups: the vote-stuffing write that 2461 makes reachable.
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Meetup lane 2460-2469.
--
-- NOT APPLIED. The owner runs all SQL. Rehearsed on portava-ci inside a
-- ROLLED-BACK transaction on 2026-09-07 (matrix in the accompanying report);
-- nothing was committed to any database by the author.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT WAS MEASURED
-- ══════════════════════════════════════════════════════════════════════════════
-- public.meetup_time_votes.mtv_own, identical on CI and production:
--
--   FOR ALL  USING (auth.uid() = user_id)  WITH CHECK (auth.uid() = user_id)
--
-- 2460 left it alone on purpose ("NOT TOUCHED, AND WHY"): under the 42P17 cycle
-- it is unreachable, and reading votes is gated by mtv_invitee_select /
-- mtv_creator_select, so it is not a disclosure. But it IS the INSERT policy
-- for a voter, and its WITH CHECK binds only user_id. Once 2461 removes the
-- error, an authenticated caller with the anon key can
--
--     INSERT INTO meetup_time_votes (option_id, user_id, vote) VALUES (<any option>, auth.uid(), 'yes')
--
-- on a meetup they were never admitted to — measured in the CI rehearsal:
-- after 2460 + 2461 and before this file, an outsider's vote on a stranger's
-- option was ACCEPTED. routes/meetups.ts takes the confirm-time tally through
-- the service role, so a stuffed vote counts. Vote INTEGRITY, not disclosure;
-- same lane, same shape of fix.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE FIX — a subquery, deliberately not a second helper
-- ══════════════════════════════════════════════════════════════════════════════
--   mtv_own  FOR ALL
--     USING      (auth.uid() = user_id)
--     WITH CHECK (auth.uid() = user_id
--                 AND EXISTS (SELECT 1 FROM public.meetup_time_options mto
--                              WHERE mto.id = meetup_time_votes.option_id))
--
-- The subquery evaluates under meetup_time_options' OWN policies, which are
-- already the one statement of "who is admitted to this meetup": the creator
-- (mto_creator), an invitee (mto_invitee_select → authz.is_meetup_invitee,
-- 2460), accepted trip crew and circle members (mto_trip_select /
-- mto_circle_select). Exactly the set routes/meetups.ts canAccessMeetup lets
-- vote. A second SECURITY DEFINER helper would have to re-encode all four
-- branches, and the trip branch is DIFFERENT on CI (authz.is_trip_crew, 2337)
-- and production (inline trip_members): the helper would either depend on
-- 2337 or copy the divergence. One source of truth instead.
--
-- No cycle: the new edge is meetup_time_votes → meetup_time_options, downward
-- in the layering 2461's postcondition certifies (meetups < meetup_invites <
-- meetup_time_options < meetup_time_votes), and mtv_invitee_select already
-- reads the same table. The certificate is re-asserted below.
--
-- What the caller can still do: read, change and delete their OWN vote
-- (USING is unchanged); change it only to an option they are admitted to
-- (re-pointing option_id at a stranger's meetup is refused by the same WITH
-- CHECK). The API's vote path (service role) is untouched.
--
-- ROLLBACK: db/rollback/2026-09-07-2462-meetup-time-votes-write-boundary-rollback.sql

BEGIN;

-- ── Preconditions ─────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_qual  text;
  v_cmd   text;
  v_state text;
BEGIN
  -- 2461 must be in effect. Without it every write here still raises 42P17 and
  -- the effect of this file could not be measured — and a file whose effect
  -- cannot be measured is a file that cannot be trusted (2401 → 2402 order).
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'authz' AND p.proname = 'is_meetup_invitee' AND p.prosecdef
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: authz.is_meetup_invitee is absent — apply 2460 and 2461 first.';
  END IF;
  SELECT qual INTO v_qual FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'meetups' AND policyname = 'meetups_invitee_select';
  IF v_qual IS NULL OR v_qual NOT LIKE '%authz.is_meetup_invitee(id)%' THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: meetups_invitee_select does not route through authz.is_meetup_invitee — apply 2461 first (the cycle is still in place and this file''s effect cannot be measured). Current: %', coalesce(v_qual, '<absent>');
  END IF;
  SELECT qual INTO v_qual FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'meetup_time_options' AND policyname = 'mto_invitee_select';
  IF v_qual IS NULL OR v_qual NOT LIKE '%authz.is_meetup_invitee(meetup_id)%' THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: mto_invitee_select does not route through authz.is_meetup_invitee — apply 2461 first.';
  END IF;

  IF to_regclass('public.meetup_time_votes') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.meetup_time_votes must exist.';
  END IF;
  SELECT cmd INTO v_cmd FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'meetup_time_votes' AND policyname = 'mtv_own';
  IF v_cmd IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: meetup_time_votes.mtv_own is absent; this file hardens it, it does not invent it.';
  END IF;
  IF v_cmd <> 'ALL' THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: meetup_time_votes.mtv_own is FOR %, not FOR ALL; re-measure before applying.', v_cmd;
  END IF;

  -- The error path must already be gone, measured: a non-service read of the
  -- votes table must not raise.
  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000000', true);
    PERFORM count(*) FROM public.meetup_time_votes;
    EXECUTE 'RESET ROLE';
  EXCEPTION WHEN OTHERS THEN
    v_state := SQLSTATE;
    EXECUTE 'RESET ROLE';
    RAISE EXCEPTION 'PRECONDITION FAILED: a non-service read of meetup_time_votes still fails (%) — apply 2461 first.', v_state;
  END;
END $$;

-- ── mtv_own: a voter may cast, change and withdraw their own vote — on a
--    meetup they are admitted to ─────────────────────────────────────────────
DROP POLICY IF EXISTS mtv_own ON public.meetup_time_votes;
CREATE POLICY mtv_own ON public.meetup_time_votes
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1
        FROM public.meetup_time_options mto
       WHERE mto.id = meetup_time_votes.option_id
    )
  );

-- ── Postconditions ────────────────────────────────────────────────────────────
DO $$
DECLARE
  r       record;
  v_cmd   text;
  v_using text;
  v_check text;
  v_state text;
BEGIN
  SELECT cmd, qual, with_check INTO v_cmd, v_using, v_check FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'meetup_time_votes' AND policyname = 'mtv_own';
  IF v_cmd IS DISTINCT FROM 'ALL' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: mtv_own must remain FOR ALL, is %', v_cmd;
  END IF;
  IF v_using NOT LIKE '%auth.uid() = user_id%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: mtv_own USING must bind user_id to the caller: %', v_using;
  END IF;
  IF v_check NOT LIKE '%auth.uid() = user_id%'
     OR v_check !~ 'FROM meetup_time_options mto' OR v_check NOT LIKE '%mto.id = meetup_time_votes.option_id%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: mtv_own WITH CHECK must bind user_id AND require an admitted option: %', v_check;
  END IF;

  -- Policy count unchanged (scripts/rlsDispositions.ts: meetup_time_votes 3),
  -- and the other three tables untouched (4 / 5 / 4).
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'meetup_time_votes') <> 3 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: public.meetup_time_votes must carry exactly 3 policies (rlsDispositions), has %',
      (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'meetup_time_votes');
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'meetups') <> 4
     OR (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'meetup_invites') <> 5
     OR (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'meetup_time_options') <> 4 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: policy counts on meetups / meetup_invites / meetup_time_options moved (expected 4 / 5 / 4).';
  END IF;

  -- The 2461 layering certificate, re-asserted: each table's policies may name
  -- only tables BELOW it in meetups < meetup_invites < meetup_time_options <
  -- meetup_time_votes. The new edge (votes → options) points down.
  FOR r IN
    SELECT tablename, policyname, coalesce(qual, '') || ' ' || coalesce(with_check, '') AS expr
      FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename IN ('meetups', 'meetup_invites', 'meetup_time_options', 'meetup_time_votes')
  LOOP
    IF r.tablename = 'meetups' AND r.expr ~ '\m(meetup_invites|meetup_time_options|meetup_time_votes)\M' THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED: meetups.% looks back at a dependent meetup table (cycle): %', r.policyname, r.expr;
    END IF;
    IF r.tablename = 'meetup_invites' AND r.expr ~ '\m(meetup_time_options|meetup_time_votes)\M' THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED: meetup_invites.% references a table above it (cycle): %', r.policyname, r.expr;
    END IF;
    IF r.tablename = 'meetup_time_options' AND r.expr ~ '\mmeetup_time_votes\M' THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED: meetup_time_options.% references meetup_time_votes (cycle): %', r.policyname, r.expr;
    END IF;
    IF r.expr ~ ('(FROM|JOIN)\s+(public\.)?' || r.tablename || '\M') THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED: %.% selects from its own table: %', r.tablename, r.policyname, r.expr;
    END IF;
    IF r.expr ~ '\(([a-z_]+)\.([a-z_]+) = \1\.\2\)' THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED: %.% compares a column to itself: %', r.tablename, r.policyname, r.expr;
    END IF;
  END LOOP;

  -- Measured, not inferred: as a non-service role, reading still works and an
  -- INSERT on an option the caller is not admitted to is refused by RLS
  -- (42501) — not by a constraint, which RLS is checked BEFORE. A random uuid
  -- is an option nobody is admitted to.
  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000000', true);
    PERFORM count(*) FROM public.meetup_time_votes;
    BEGIN
      INSERT INTO public.meetup_time_votes (option_id, user_id, vote)
      VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'yes');
      EXECUTE 'RESET ROLE';
      RAISE EXCEPTION 'POSTCONDITION FAILED: an unadmitted vote INSERT was ACCEPTED.';
    EXCEPTION
      WHEN insufficient_privilege THEN NULL;   -- 42501: the boundary
    END;
    EXECUTE 'RESET ROLE';
  EXCEPTION WHEN OTHERS THEN
    v_state := SQLSTATE;
    EXECUTE 'RESET ROLE';
    RAISE EXCEPTION 'POSTCONDITION FAILED: non-service probe of meetup_time_votes failed with % (expected 42501 on the insert, no error on the read): %', v_state, SQLERRM;
  END;
END $$;

COMMIT;
