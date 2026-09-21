-- 2460_meetup_invites_self_invite_latent_disclosure.sql
-- Meetups: the one write policy that would let ANY authenticated caller invite
-- THEMSELVES to ANY meetup — and thereby read it — the moment the
-- meetups/meetup_invites RLS recursion (2461) is repaired.
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Meetup lane 2460-2469.
--
-- NOT APPLIED. The owner runs all SQL. Rehearsed on portava-ci inside a
-- ROLLED-BACK transaction on 2026-09-07 (see the accompanying report); nothing
-- was committed to any database by the author.
--
-- INERT BY CONSTRUCTION. After this file, every non-service read AND write of
-- public.meetups, public.meetup_invites, public.meetup_time_options (and
-- public.meetup_time_votes, which subqueries the first two) still fails with
-- 42P17 exactly as it does today, because the policy-graph cycle described in
-- 2461 is untouched: an INSERT into meetup_invites is still gated by the OR of
-- mi_own's WITH CHECK and mi_creator_write's WITH CHECK, and the latter
-- subqueries meetups, whose meetups_invitee_select subqueries meetup_invites.
-- The cycle is repaired SEPARATELY, in 2461, which is NOT inert; this file
-- exists so that 2461 — or any future hand-fix of meetups_invitee_select —
-- cannot turn a hard error into a silent self-service invitation. Order is
-- enforced: 2461 refuses to run unless this file's postconditions hold. This is
-- the same two-file shape as 2401 (inert defuse) + 2402 (repair) on Telegraph.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT WAS MEASURED (2026-09-07, pg_policies on BOTH databases — identical)
-- ══════════════════════════════════════════════════════════════════════════════
-- public.meetup_invites carries five PERMISSIVE policies:
--
--   mi_own             FOR ALL  USING (auth.uid() = user_id)
--                               WITH CHECK (auth.uid() = user_id)
--   mi_creator_select  SELECT   EXISTS (meetups WHERE id = meetup_id AND creator_id = auth.uid())
--   mi_creator_write   INSERT   EXISTS (meetups WHERE id = meetup_id AND creator_id = auth.uid())
--   mi_circle_select   SELECT   EXISTS (meetups m ... visibility='circle' ... circle_memberships)
--   mi_trip_select     SELECT   EXISTS (meetups m ... visibility='trip' ... crew test)
--
-- None of them is a tautology and none is true for anon: every predicate
-- compares a column to auth.uid() or reaches it through a subquery, and
-- auth.uid() IS NULL for anon. That is the good news, and it is why THIS
-- migration touches only one policy. The Telegraph trap (a PERMISSIVE hide
-- policy that granted every row to anon) has no counterpart here.
--
-- The bad news is mi_own. It is FOR ALL, so it is the INSERT policy for the
-- invitee, and its WITH CHECK binds only user_id. It says nothing about
-- meetup_id. Once meetup_invites is writable at all, an authenticated caller
-- with the anon key can run, through PostgREST,
--
--     INSERT INTO meetup_invites (meetup_id, user_id) VALUES (<any meetup>, auth.uid())
--
-- and from that moment on the meetup is theirs to read:
--   * meetups_invitee_select admits any meetup for which the caller holds an
--     invite row, regardless of status;
--   * mto_invitee_select admits that meetup's time options the same way;
--   * mtv_invitee_select admits its votes the same way;
--   * routes/meetups.ts canAccessMeetup (service role, so RLS-blind) admits ANY
--     caller with an invite row — status is not consulted — so the API's
--     GET /api/meetups/:id, RSVP and vote endpoints open too.
-- The same WITH CHECK also lets an invitee UPDATE their own row's meetup_id and
-- re-point a real invitation at a meetup they were never invited to.
-- meetups.id is a v4 UUID, so this needs the id — but meetup ids travel in
-- chat messages, push payloads and deep links, which is not a secret.
--
-- Today none of this is reachable: the INSERT (and the UPDATE) raise 42P17
-- before any predicate is evaluated, verified on CI and on production inside
-- rolled-back transactions (SET LOCAL ROLE authenticated; INSERT ... → 42P17).
-- As on Telegraph, that is not a guarantee; it is an error that happens to be
-- in the way, and 2461 removes the error.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE FIX
-- ══════════════════════════════════════════════════════════════════════════════
-- A SECURITY DEFINER helper, authz.is_meetup_invitee(p_meetup_id), answers
-- "does the CALLER hold an invite row on meetup P" by reading meetup_invites
-- as its owner (postgres), which bypasses RLS and so cannot re-enter any
-- policy. It takes NO user-id parameter — as 2199/2402 explain, a policy
-- predicate evaluates with the querying role's privileges, so anon and
-- authenticated must hold EXECUTE, and a (meetup, user) signature would be an
-- invitation oracle. With auth.uid() read internally the only question anyone
-- can ask is "am I invited to P", whose answer they already have.
--
-- mi_own is recreated with the same USING and a WITH CHECK that ALSO requires
-- authz.is_meetup_invitee(meetup_id):
--   INSERT  the new row's meetup must already carry an invite for the caller —
--           i.e. the row must already exist, so a self-INSERT is refused (and a
--           duplicate would hit meetup_invites_unique anyway);
--   UPDATE  the new row's meetup must carry an invite for the caller — true
--           when meetup_id is unchanged (the RSVP case), false when re-pointed;
--   DELETE  unchanged (USING only): an invitee may still remove their own row.
-- Invitations are CREATED by the meetup creator (mi_creator_write, and the API
-- through the service role); this file does not touch that path.
--
-- The helper is created HERE rather than in 2461 because this file is the one
-- 2461 depends on, and the helper is what 2461's precondition checks for. The
-- policy COUNT on meetup_invites is unchanged (5), so
-- scripts/rlsDispositions.ts (`meetup_invites: policyCount 5`) still holds.
--
-- NOT TOUCHED, AND WHY: meetup_time_votes.mtv_own has the same FOR ALL /
-- WITH CHECK (auth.uid() = user_id) shape, so after 2461 an authenticated
-- caller could INSERT a vote on any option id. That is a vote-integrity issue
-- (the confirm-time count is taken by the service role), not a disclosure:
-- reading votes still requires an invite row (mtv_invitee_select) or being the
-- creator, and this file makes an invite row non-self-serviceable. It is
-- reported for a follow-on in the same lane rather than widened into here.
--
-- ROLLBACK: db/rollback/2026-09-07-2460-meetup-invites-self-invite-latent-disclosure-rollback.sql

BEGIN;

-- ── Preconditions ─────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_owner text;
  v_force boolean;
  v_cmd   text;
BEGIN
  IF to_regclass('public.meetups') IS NULL
     OR to_regclass('public.meetup_invites') IS NULL
     OR to_regclass('public.meetup_time_options') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.meetups, meetup_invites and meetup_time_options must exist.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'authz') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: schema authz must exist (migration 2182).';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'meetup_invites' AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: RLS must be enabled on public.meetup_invites.';
  END IF;

  -- The owner-bypass the helper relies on: table owned by the role that will
  -- own the function, and RLS not FORCEd.
  SELECT pg_get_userbyid(c.relowner), c.relforcerowsecurity INTO v_owner, v_force
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'meetup_invites';
  IF v_owner <> 'postgres' THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: meetup_invites must be owned by postgres for the SECURITY DEFINER bypass; owner is %', v_owner;
  END IF;
  IF v_force THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: meetup_invites has FORCE ROW LEVEL SECURITY; the owner bypass this file relies on would not apply.';
  END IF;

  -- The policy being hardened must be the one measured: FOR ALL, on this table.
  SELECT cmd INTO v_cmd FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'meetup_invites' AND policyname = 'mi_own';
  IF v_cmd IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: meetup_invites.mi_own is absent; this file hardens it, it does not invent it.';
  END IF;
  IF v_cmd <> 'ALL' THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: meetup_invites.mi_own is FOR %, not FOR ALL; re-measure before applying.', v_cmd;
  END IF;
END $$;

-- ── The helper ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION authz.is_meetup_invitee(p_meetup_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $fn$
  SELECT p_meetup_id IS NOT NULL
     AND auth.uid() IS NOT NULL
     AND EXISTS (
       SELECT 1
         FROM public.meetup_invites mi
        WHERE mi.meetup_id = p_meetup_id
          AND mi.user_id = auth.uid()
     );
$fn$;

ALTER FUNCTION authz.is_meetup_invitee(uuid) OWNER TO postgres;

COMMENT ON FUNCTION authz.is_meetup_invitee(uuid) IS
  'Meetups: does the CALLER (auth.uid(), read internally — never a parameter) hold an invite row, of any status, on meetup p_meetup_id. SECURITY DEFINER owned by postgres so policies on meetups, meetup_invites and meetup_time_options can consult invitations without re-entering the meetup_invites policies (42P17 cycle, see 2461). Any-status on purpose: it mirrors routes/meetups.ts canAccessMeetup, which admits a pending or declined invitee, and a pending invitee must be able to read the meetup to answer it. Takes no user id on purpose: a (meetup, user) signature would be an invitation oracle to anon/authenticated, which must hold EXECUTE for the policies to evaluate at all (see 2199, 2402).';

-- Policy predicates evaluate with the querying role's privileges: anon and
-- authenticated MUST be able to execute this, or every read fails outright.
GRANT USAGE ON SCHEMA authz TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION authz.is_meetup_invitee(uuid) TO anon, authenticated, service_role;

-- ── mi_own: an invitee may read, answer and remove their own row — not mint one
DROP POLICY IF EXISTS mi_own ON public.meetup_invites;
CREATE POLICY mi_own ON public.meetup_invites
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id AND authz.is_meetup_invitee(meetup_id));

-- ── Postconditions ────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_prosecdef boolean;
  v_config    text[];
  v_owner     text;
  v_cmd       text;
  v_using     text;
  v_check     text;
  v_count     integer;
BEGIN
  SELECT p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) INTO v_prosecdef, v_config, v_owner
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'authz' AND p.proname = 'is_meetup_invitee';
  IF v_prosecdef IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: authz.is_meetup_invitee does not exist.';
  END IF;
  IF v_prosecdef IS NOT TRUE THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: authz.is_meetup_invitee must be SECURITY DEFINER.';
  END IF;
  IF v_owner <> 'postgres' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: authz.is_meetup_invitee must be owned by postgres (the meetup_invites owner), is owned by %', v_owner;
  END IF;
  IF v_config IS NULL OR array_to_string(v_config, ',') NOT LIKE '%search_path%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: authz.is_meetup_invitee must pin search_path.';
  END IF;
  IF NOT has_function_privilege('authenticated', 'authz.is_meetup_invitee(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('anon', 'authz.is_meetup_invitee(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: anon and authenticated must hold EXECUTE on authz.is_meetup_invitee, or every policy that calls it fails.';
  END IF;
  -- One uuid parameter and nothing else: no caller-supplied identity, ever.
  IF (SELECT pg_get_function_identity_arguments(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'authz' AND p.proname = 'is_meetup_invitee') <> 'p_meetup_id uuid' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: authz.is_meetup_invitee must take exactly (p_meetup_id uuid).';
  END IF;

  SELECT cmd, qual, with_check INTO v_cmd, v_using, v_check FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'meetup_invites' AND policyname = 'mi_own';
  IF v_cmd IS DISTINCT FROM 'ALL' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: mi_own must remain FOR ALL, is %', v_cmd;
  END IF;
  IF v_using NOT LIKE '%auth.uid() = user_id%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: mi_own USING must bind user_id to the caller: %', v_using;
  END IF;
  IF v_check NOT LIKE '%auth.uid() = user_id%' OR v_check NOT LIKE '%authz.is_meetup_invitee(meetup_id)%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: mi_own WITH CHECK must bind user_id AND require an existing invitation on meetup_id: %', v_check;
  END IF;

  SELECT count(*) INTO v_count FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'meetup_invites';
  IF v_count <> 5 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: public.meetup_invites must carry exactly 5 policies (rlsDispositions), has %', v_count;
  END IF;
END $$;

COMMIT;
