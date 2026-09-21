-- 2461_meetup_rls_recursion.sql
-- Meetups: repair of the two-table policy-graph cycle that makes EVERY
-- non-service read and write of public.meetups, public.meetup_invites,
-- public.meetup_time_options — and, through them, public.meetup_time_votes —
-- fail with 42P17 "infinite recursion detected in policy".
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Meetup lane 2460-2469.
--
-- NOT APPLIED. The owner runs all SQL. Rehearsed on portava-ci inside a
-- ROLLED-BACK transaction on 2026-09-07 (matrix in the accompanying report);
-- nothing was committed to any database by the author.
--
-- ⚠ NOT INERT. This file changes what a direct PostgREST caller can observe.
-- Read "WHAT BECOMES VISIBLE" before applying it anywhere but CI. It REFUSES
-- to run unless 2460's postconditions already hold, because without 2460 this
-- repair converts a hard error into a self-service invitation: any
-- authenticated caller could INSERT their own meetup_invites row on any meetup
-- id and then read the meetup, its time options and its votes.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE CYCLE, AS MEASURED (2026-09-07, pg_policies, identical on CI and prod
-- except for the trip-visibility branch — see below)
-- ══════════════════════════════════════════════════════════════════════════════
--   meetups.meetups_invitee_select
--     USING (EXISTS (SELECT 1 FROM meetup_invites
--                     WHERE meetup_invites.meetup_id = meetups.id
--                       AND meetup_invites.user_id = auth.uid()))
--   meetup_invites.mi_creator_select / mi_creator_write / mi_circle_select /
--   mi_trip_select
--     USING (EXISTS (SELECT 1 FROM meetups ... WHERE meetups.id = meetup_invites.meetup_id ...))
--
-- Reading meetups expands meetups_invitee_select, whose subquery on
-- meetup_invites is itself subject to RLS, which expands mi_creator_select,
-- whose subquery on meetups is again subject to RLS — and Postgres, finding
-- meetups already on the policy-expansion stack, raises 42P17 rather than
-- loop. No policy selects FROM its own table, which is exactly why the
-- self-reference sweep in test/rlsPolicyShapeLive.test.ts never flagged it:
-- the cycle is of length two. meetup_time_options.mto_invitee_select
-- subqueries meetup_invites and mto_creator/mto_circle_select/mto_trip_select
-- subquery meetups, so every read of that table enters the same cycle;
-- meetup_time_votes.mtv_creator_select / mtv_invitee_select join both.
--
-- Verified live, inside rolled-back transactions, on BOTH databases, for BOTH
-- anon and authenticated (with a request.jwt.claim.sub set):
--   SELECT count(*) FROM meetups / meetup_invites / meetup_time_options /
--   meetup_time_votes                                → 42P17, all four
--   INSERT INTO meetup_invites (meetup_id, user_id)  → 42P17 (CI)
-- Production holds 2 meetups, 4 invites, 0 time options; none readable.
--
-- Blast radius today: NONE through the product. routes/meetups.ts reads and
-- writes every meetup table through the SERVICE-ROLE client (requireUser hands
-- back getServiceClient()), which bypasses RLS, and the mobile client makes no
-- direct PostgREST read of any meetup table (grep of app/, lib/, components/:
-- only lib/database.types.ts names them). So, unlike Telegraph (2402), no
-- screen is broken by the recursion and no screen changes when it is fixed.
-- What changes is the security posture of the anon key: today it cannot read
-- these tables because of an error; after this file it cannot read them
-- because of the policies.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE FIX — the 2199/2402 pattern
-- ══════════════════════════════════════════════════════════════════════════════
-- The invitee branch is resolved through authz.is_meetup_invitee(uuid), the
-- SECURITY DEFINER helper 2460 created (owned by postgres, EXECUTE for anon /
-- authenticated / service_role, no user-id parameter). Its owner-read of
-- meetup_invites bypasses RLS, so it can never re-enter a policy. Two policies
-- are rewritten on top of it:
--
--   meetups.meetups_invitee_select              USING (authz.is_meetup_invitee(id))
--   meetup_time_options.mto_invitee_select      USING (authz.is_meetup_invitee(meetup_id))
--
-- and NOTHING ELSE moves. After that the policy graph is layered:
--
--   meetups              → circle_memberships, trip crew (2337 helper on CI; the
--                          pre-2337 trip_members form on prod, whose
--                          trip_members_select routes through the SECURITY
--                          DEFINER public.can_see_trip) — never a meetup table
--   meetup_invites       → meetups
--   meetup_time_options  → meetups
--   meetup_time_votes    → meetup_time_options, meetup_invites, meetups
--
-- Every edge points DOWN the list, so there is no cycle, and the
-- postconditions below assert that layering on the live catalog rather than
-- trusting this comment. The seven remaining meetup_invites /
-- meetup_time_options policies keep their correlated EXISTS over meetups on
-- purpose: they are correct, they are not on a cycle once meetups stops
-- looking back, and rewriting the trip branch would collide with 2337, whose
-- CI/prod divergence (authz.is_trip_crew vs an inline trip_members join) this
-- file must not depend on — it is applied identically to both.
--
-- What the helper does NOT do: consult status. A pending, declined or
-- cancelled invitee still reads the meetup — exactly as routes/meetups.ts
-- canAccessMeetup admits them today, and a pending invitee must see the
-- meetup to answer it. Narrowing that is a product decision, not a repair.
-- Nor is there a block-list gate: no policy on any meetup table consults
-- public.blocks today, and this file adds none (the API's invite path checks
-- blocks; a blocked user cannot acquire an invite row in the first place).
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT BECOMES VISIBLE (why this is not inert)
-- ══════════════════════════════════════════════════════════════════════════════
-- Through PostgREST, with a user JWT:
--   creator            reads own meetups (any visibility), every invite row on
--                      them, every time option; writes them (unchanged policies)
--   invitee, any status reads the meetup, own invite row ONLY, the time options;
--                      may UPDATE own status and DELETE own row
--   accepted trip crew reads trip-visibility meetups, their invites and options
--   circle member      reads circle-visibility meetups, their invites and options
--   stranger           reads nothing; cannot self-insert an invite (2460)
--   anon               reads nothing (every predicate needs auth.uid())
-- Rehearsed on CI with a five-user fixture; the matrix is in the report.
--
-- AFTER APPLYING TO CI: remove the meetup entry from KNOWN_CYCLES in
-- test/rlsPolicyShapeLive.test.ts, whose stale-allowlist case fails by design.
--
-- ROLLBACK: db/rollback/2026-09-07-2461-meetup-rls-recursion-rollback.sql

BEGIN;

-- ── Preconditions ─────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_check text;
  v_owner text;
  v_force boolean;
BEGIN
  -- 2460 must be in effect: this repair MUST NOT land on a self-insertable mi_own.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'authz' AND p.proname = 'is_meetup_invitee' AND p.prosecdef
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: authz.is_meetup_invitee (SECURITY DEFINER) is absent — apply 2460 first. Repairing the recursion without it lets any authenticated caller invite themselves to any meetup and read it.';
  END IF;
  IF NOT has_function_privilege('authenticated', 'authz.is_meetup_invitee(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('anon', 'authz.is_meetup_invitee(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: anon and authenticated must hold EXECUTE on authz.is_meetup_invitee (apply 2460 first).';
  END IF;
  SELECT with_check INTO v_check FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'meetup_invites' AND policyname = 'mi_own';
  IF v_check IS NULL OR v_check NOT LIKE '%authz.is_meetup_invitee(meetup_id)%' THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: meetup_invites.mi_own WITH CHECK does not require an existing invitation (apply 2460 first). Current: %', coalesce(v_check, '<absent>');
  END IF;

  IF to_regclass('public.meetups') IS NULL OR to_regclass('public.meetup_time_options') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.meetups and public.meetup_time_options must exist.';
  END IF;
  -- The helper reads meetup_invites as its owner; that bypass is what breaks the cycle.
  SELECT pg_get_userbyid(c.relowner), c.relforcerowsecurity INTO v_owner, v_force
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'meetup_invites';
  IF v_owner <> 'postgres' OR v_force THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: meetup_invites must be owned by postgres without FORCE ROW LEVEL SECURITY (owner %, force %).', v_owner, v_force;
  END IF;
END $$;

-- ── The two policies ──────────────────────────────────────────────────────────
DROP POLICY IF EXISTS meetups_invitee_select ON public.meetups;
CREATE POLICY meetups_invitee_select ON public.meetups
  FOR SELECT
  USING (authz.is_meetup_invitee(id));

DROP POLICY IF EXISTS mto_invitee_select ON public.meetup_time_options;
CREATE POLICY mto_invitee_select ON public.meetup_time_options
  FOR SELECT
  USING (authz.is_meetup_invitee(meetup_id));

-- ── Postconditions ────────────────────────────────────────────────────────────
DO $$
DECLARE
  r record;
  v_expr text;
  v_state text;
BEGIN
  -- 1. The layering certificate. Each table's policies may name only tables
  --    BELOW it in the order meetups < meetup_invites < meetup_time_options <
  --    meetup_time_votes. A single upward edge would be a cycle.
  FOR r IN
    SELECT tablename, policyname, coalesce(qual, '') || ' ' || coalesce(with_check, '') AS expr
      FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename IN ('meetups', 'meetup_invites', 'meetup_time_options', 'meetup_time_votes')
  LOOP
    IF r.tablename = 'meetups'
       AND r.expr ~ '\m(meetup_invites|meetup_time_options|meetup_time_votes)\M' THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED: meetups.% still looks back at a dependent meetup table (cycle): %', r.policyname, r.expr;
    END IF;
    IF r.tablename = 'meetup_invites'
       AND r.expr ~ '\m(meetup_time_options|meetup_time_votes)\M' THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED: meetup_invites.% references a table above it (cycle): %', r.policyname, r.expr;
    END IF;
    IF r.tablename = 'meetup_time_options'
       AND r.expr ~ '\mmeetup_time_votes\M' THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED: meetup_time_options.% references meetup_time_votes (cycle): %', r.policyname, r.expr;
    END IF;
    -- 2. No policy selects FROM its own table, and none compares a column to itself.
    IF r.expr ~ ('(FROM|JOIN)\s+(public\.)?' || r.tablename || '\M') THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED: %.% selects from its own table: %', r.tablename, r.policyname, r.expr;
    END IF;
    IF r.expr ~ '\(([a-z_]+)\.([a-z_]+) = \1\.\2\)' THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED: %.% compares a column to itself: %', r.tablename, r.policyname, r.expr;
    END IF;
  END LOOP;

  -- 3. The two rewritten policies route through the helper.
  SELECT qual INTO v_expr FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'meetups' AND policyname = 'meetups_invitee_select';
  IF v_expr IS NULL OR v_expr NOT LIKE '%authz.is_meetup_invitee(id)%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: meetups_invitee_select does not route through authz.is_meetup_invitee: %', coalesce(v_expr, '<absent>');
  END IF;
  SELECT qual INTO v_expr FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'meetup_time_options' AND policyname = 'mto_invitee_select';
  IF v_expr IS NULL OR v_expr NOT LIKE '%authz.is_meetup_invitee(meetup_id)%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: mto_invitee_select does not route through authz.is_meetup_invitee: %', coalesce(v_expr, '<absent>');
  END IF;

  -- 4. Policy counts unchanged (scripts/rlsDispositions.ts): 4 / 5 / 4 / 3.
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'meetups') <> 4
     OR (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'meetup_invites') <> 5
     OR (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'meetup_time_options') <> 4
     OR (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'meetup_time_votes') <> 3 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: policy counts on the meetup tables no longer match rlsDispositions (expected 4 / 5 / 4 / 3).';
  END IF;

  -- 5. The error path is GONE, measured rather than inferred: read all four
  --    tables as a non-service role inside this transaction. A surviving cycle
  --    raises 42P17 here and aborts the migration.
  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000000', true);
    PERFORM count(*) FROM public.meetups;
    PERFORM count(*) FROM public.meetup_invites;
    PERFORM count(*) FROM public.meetup_time_options;
    PERFORM count(*) FROM public.meetup_time_votes;
    EXECUTE 'RESET ROLE';
  EXCEPTION WHEN OTHERS THEN
    v_state := SQLSTATE;
    EXECUTE 'RESET ROLE';
    RAISE EXCEPTION 'POSTCONDITION FAILED: a non-service read of the meetup tables still fails (%): %', v_state, SQLERRM;
  END;
END $$;

COMMIT;
