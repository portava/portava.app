-- 2530_highlights_trip_only_accepted_crew.sql
--
-- The trip_only branch of highlights_select_active stops admitting people who
-- are not on the trip. ONE branch of ONE policy changes; every other character
-- of the policy is preserved from whatever is live, and the migration proves
-- that before it writes.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2530 (B5).
-- Takes the first of the two policies 2337 deferred. Read 2334 and 2337 first.
--
-- Policy-only: it rewrites one policy. It creates no function, touches no
-- table, column, grant or row. Idempotent: a second run finds the branch
-- already routed through the helper and does nothing.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE DEFECT
-- ══════════════════════════════════════════════════════════════════════════════
-- The trip_only branch is a self-join with NO role filter and NO status filter:
--
--   EXISTS (SELECT 1 FROM trip_members tm1 JOIN trip_members tm2
--            ON tm1.trip_id = tm2.trip_id
--           WHERE tm1.user_id = highlights.owner_id AND tm2.user_id = auth.uid())
--
-- "Any two trip_members rows on the same trip" is not "both accepted crew of
-- the same trip". Measured on portava-ci 2026-09-07 (fixture trip, rolled
-- back, viewer = authenticated with a real request.jwt.claims sub) against a
-- trip_only highlight owned by the trip owner, BEFORE this migration:
--
--   viewer                       admitted   should be
--   accepted member/co_host/viewer  yes      yes
--   pending  member,  status=invited yes      NO   <- pending invitee
--   pending  co_host, status=invited yes      NO   <- pending co-host
--   removed  member,  status=removed yes      NO   <- REMOVED from the trip
--   legacy   invited, status=accepted no*     NO   (* masked by trip_members'
--                                                    own RLS, not gated -- 2337)
--   stranger                         no       NO
--   owner of ANOTHER trip the highlight owner is accepted crew of, holding no
--   trip_members row on it          no       YES  <- fail-closed half
--
-- routes/highlights.ts carried the same defect app-side (role IN (owner,member),
-- no status) and is fixed in the same commit; this migration closes the
-- direct-PostgREST path, on which anon and authenticated hold SELECT (verified
-- on both databases).
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY THIS IS NOT A PLAIN DROP/CREATE, AND WHY THAT IS THE WHOLE POINT
-- ══════════════════════════════════════════════════════════════════════════════
-- highlights_select_active is the one policy of 2337's thirty-one where
-- portava-ci and production DISAGREE, and 2337 refused to replace it whole for
-- that reason. The disagreement is now identified, measured and named:
--
--   production   ((deleted_at IS NULL) AND (expires_at > now())
--                  AND (NOT authz.is_blocked(auth.uid(), owner_id))
--                  AND (owner_id = auth.uid() OR <public> OR <circle> OR <trip_only>))
--
--   portava-ci   ((deleted_at IS NULL)
--                  AND (owner_id = auth.uid()
--                       OR ((expires_at IS NULL OR expires_at > now())
--                           AND (NOT authz.is_blocked(auth.uid(), owner_id))
--                           AND (<public> OR <circle> OR <trip_only>))))
--
-- The CI shape is migration 2313_highlights_permanent, applied to CI on
-- 2026-09-07 (schema_migrations 20260907024317) from PR #461 (commit 3babd722,
-- branch remotes/pr/461), which is NOT merged into this branch. It implements
-- two owner rulings of 2026-09-06 -- a Highlight may be permanent (expires_at
-- NULL) and an expired one is archived, visible to its owner -- and it changes
-- highlights.expires_at to nullable, which production's column is not. Both
-- SELECT policies on highlights differ between the databases in exactly this
-- way and no other. The <trip_only> branch is byte-identical on both.
--
-- So the drift is REVIEWED (an owner ruling) but UNMERGED (PR #461), and it is
-- coupled to a column change this migration has no business making. Carrying
-- the CI shape to production would apply half of PR #461 without the column
-- and without the routes; writing the production shape would revert an owner
-- ruling on CI. Neither is this lane's decision, and the decision is not
-- needed: the defect is confined to one branch that both shapes share.
--
-- This migration therefore rewrites ONLY that branch, in place, whatever the
-- surrounding shape is:
--
--   1. read the live qual of highlights_select_active from pg_policies;
--   2. require that it contain the defective self-join EXACTLY ONCE (regex,
--      whitespace-tolerant, schema-qualification-tolerant) -- any other shape
--      is refused, not guessed at;
--   3. replace that one fragment with
--        ((visibility = 'trip_only'::text) AND authz.shares_accepted_trip(owner_id))
--   4. PROVE minimality before writing: the old qual with the fragment cut out
--      must equal the new qual with the replacement cut out, character for
--      character, and the result must not mention trip_members at all;
--   5. DROP and re-CREATE the policy with the new qual, same command, same
--      roles, same permissiveness -- each read back from pg_policies and
--      asserted, never assumed.
--
-- Dry-run of steps 1-4 as a pure SELECT on both databases, 2026-09-07:
-- matched = true, match_count = 1, rest_identical = true,
-- still_has_trip_members = false, on each. The output on CI keeps 2313's
-- owner-first / NULL-arm structure; the output on production keeps 0026's.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE HAZARD THIS LEAVES OPEN, STATED SO IT IS NOT FORGOTTEN
-- ══════════════════════════════════════════════════════════════════════════════
-- PR #461's 2313 reproduces the trip_only self-join "byte-for-byte from the
-- baseline". If 2313 is applied to a database AFTER this migration, it will
-- REINTRODUCE the defect on that database. On CI, 2313 has already run, so
-- this migration lands on top of it and the order is safe. On production, if
-- PR #461 is merged and applied later, its 2313 must first be rebased to emit
-- authz.shares_accepted_trip(owner_id) in that branch. The live shape guard
-- (src/test/rlsPolicyShapeLive.test.ts, rule: no policy may reach trip_members
-- without role AND status) fails on CI the moment any policy reintroduces it.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY authz.shares_accepted_trip AND NOT A NEW HELPER
-- ══════════════════════════════════════════════════════════════════════════════
-- 2337 created it for exactly this line. It answers "the CURRENT viewer
-- (auth.uid(), read inside -- never a parameter) and the named user are both
-- accepted crew of at least one common trip", by the rule lib/http.ts
-- requireTripMember applies: role IN (owner, co_host, member, viewer) AND
-- coalesce(status,'accepted') = 'accepted' where a row exists, plus
-- trips.owner_id where none does. SECURITY DEFINER, pinned search_path, in
-- authz so PostgREST does not expose it, EXECUTE held by anon and authenticated
-- because RLS evaluates it with the querying role's privileges. ua_trip_select
-- and qas_trip_select already use it for the same question.
--
-- public.shares_trip_with(uuid) -- the app-era predecessor of this branch, a
-- SECURITY DEFINER self-join with no role or status gate, EXECUTE-able by anon
-- and authenticated on both databases as a PostgREST RPC -- is NOT touched
-- here. It is named in no policy. It is reported, as an RPC oracle of the
-- class 2182 closed, for a separate lane.
--
-- DEPENDS ON: 2337 (authz.shares_accepted_trip). Refuses to run without it.

BEGIN;

-- pg_policies deparses expressions under the CURRENT search_path: with public
-- on it, trip_members and highlights.owner_id come back unqualified and
-- auth.uid() qualified, which is the shape the regex below is written for
-- (it tolerates a public. prefix on trip_members regardless).
SET LOCAL search_path = public, pg_catalog;

DO $$
DECLARE
  frag_re  constant text := $re$\(\(visibility = 'trip_only'::text\) AND \(EXISTS \( SELECT 1\s+FROM \((public\.)?trip_members tm1\s+JOIN (public\.)?trip_members tm2 ON \(\(tm1\.trip_id = tm2\.trip_id\)\)\)\s+WHERE \(\(tm1\.user_id = highlights\.owner_id\) AND \(tm2\.user_id = auth\.uid\(\)\)\)\)\)\)$re$;
  repl     constant text := $rp$((visibility = 'trip_only'::text) AND authz.shares_accepted_trip(owner_id))$rp$;
  pol        record;
  old_qual   text;
  new_qual   text;
  n_match    int;
  n_before   int;
  n_after    int;
BEGIN
  -- ── Preconditions ──────────────────────────────────────────────────────────
  IF to_regclass('public.highlights') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.highlights missing.';
  END IF;
  IF to_regprocedure('authz.shares_accepted_trip(uuid)') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: authz.shares_accepted_trip(uuid) missing -- apply 2337 first.';
  END IF;
  IF NOT has_function_privilege('authenticated', 'authz.shares_accepted_trip(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: authenticated lacks EXECUTE on authz.shares_accepted_trip -- the policy could not evaluate.';
  END IF;

  SELECT p.permissive, p.roles, p.cmd, p.qual, p.with_check
    INTO pol
    FROM pg_policies p
   WHERE p.schemaname = 'public' AND p.tablename = 'highlights'
     AND p.policyname = 'highlights_select_active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: highlights_select_active does not exist on public.highlights.';
  END IF;
  old_qual := pol.qual;

  -- Already routed through the helper and free of the self-join: nothing to do.
  IF old_qual LIKE '%authz.shares_accepted_trip(owner_id)%' AND old_qual NOT LIKE '%trip_members%' THEN
    RAISE NOTICE '2530: highlights_select_active already routes trip_only through authz.shares_accepted_trip; no change.';
    RETURN;
  END IF;

  -- The migration preserves cmd, roles and permissiveness by re-emitting them.
  -- It only knows how to re-emit THIS combination; anything else is refused so
  -- it cannot silently widen the policy to more roles or commands.
  IF pol.cmd <> 'SELECT' OR pol.permissive <> 'PERMISSIVE' OR pol.roles <> '{authenticated}'::name[] OR pol.with_check IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: highlights_select_active is not (SELECT, PERMISSIVE, TO authenticated, no WITH CHECK) -- found cmd=% permissive=% roles=% with_check=%. Refusing to guess.',
      pol.cmd, pol.permissive, pol.roles, pol.with_check;
  END IF;

  SELECT count(*) INTO n_match FROM regexp_matches(old_qual, frag_re, 'g');
  IF n_match <> 1 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: expected the trip_members self-join to appear exactly once in highlights_select_active, found % time(s). The policy has a shape this migration was not measured against. Live qual: %', n_match, old_qual;
  END IF;

  -- ── The rewrite, and the proof that it is minimal ──────────────────────────
  new_qual := regexp_replace(old_qual, frag_re, repl);

  IF regexp_replace(old_qual, frag_re, '<branch>') IS DISTINCT FROM replace(new_qual, repl, '<branch>') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (pre-write): the rewrite changed something outside the trip_only branch. Refusing to write.';
  END IF;
  IF new_qual ~ 'trip_members' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (pre-write): rewritten qual still mentions trip_members: %', new_qual;
  END IF;
  IF new_qual NOT LIKE '%authz.shares_accepted_trip(owner_id)%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (pre-write): rewritten qual does not call authz.shares_accepted_trip(owner_id).';
  END IF;

  SELECT count(*) INTO n_before FROM pg_policies WHERE schemaname = 'public' AND tablename = 'highlights';

  EXECUTE 'DROP POLICY IF EXISTS highlights_select_active ON public.highlights';
  EXECUTE format(
    'CREATE POLICY highlights_select_active ON public.highlights FOR SELECT TO authenticated USING (%s)',
    new_qual
  );

  -- ── Postconditions ─────────────────────────────────────────────────────────
  SELECT count(*) INTO n_after FROM pg_policies WHERE schemaname = 'public' AND tablename = 'highlights';
  IF n_after <> n_before THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: policy count on highlights changed from % to %.', n_before, n_after;
  END IF;

  SELECT p.permissive, p.roles, p.cmd, p.qual, p.with_check
    INTO pol
    FROM pg_policies p
   WHERE p.schemaname = 'public' AND p.tablename = 'highlights'
     AND p.policyname = 'highlights_select_active';
  IF NOT FOUND OR pol.cmd <> 'SELECT' OR pol.permissive <> 'PERMISSIVE' OR pol.roles <> '{authenticated}'::name[] OR pol.with_check IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: highlights_select_active was not re-created as (SELECT, PERMISSIVE, TO authenticated).';
  END IF;
  IF pol.qual NOT LIKE '%authz.shares_accepted_trip(owner_id)%' OR pol.qual LIKE '%trip_members%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: re-read qual is not routed through authz.shares_accepted_trip: %', pol.qual;
  END IF;
  -- Postgres re-deparses what it stored; the only permitted difference from
  -- what we wrote is whitespace/qualification, never a clause. Compare with
  -- whitespace normalised and the branch masked on both sides.
  IF regexp_replace(replace(pol.qual, repl, '<branch>'), '\s+', '', 'g')
     IS DISTINCT FROM regexp_replace(replace(new_qual, repl, '<branch>'), '\s+', '', 'g') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: stored qual differs from the written qual outside the trip_only branch. stored=% written=%', pol.qual, new_qual;
  END IF;

  -- No policy on highlights may hand-roll a trip_members test.
  IF EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'highlights'
       AND coalesce(qual,'') || coalesce(with_check,'') LIKE '%trip_members%'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: a policy on highlights still references trip_members.';
  END IF;

  -- The helper must answer safely with no session.
  IF (SELECT authz.shares_accepted_trip(NULL)) IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: authz.shares_accepted_trip(NULL) is not false.';
  END IF;
END $$;

COMMIT;
