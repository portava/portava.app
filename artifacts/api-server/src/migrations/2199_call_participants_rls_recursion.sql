-- 2199_call_participants_rls_recursion.sql
--
-- Fix infinite recursion in the call RLS policies. Calls are unreadable today.
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- THE DEFECT, VERIFIED LIVE ON PRODUCTION 2026-08-28
-- -------------------------------------------------
--     SELECT count(*) FROM public.call_participants   -- as authenticated
--     ERROR: 42P17 infinite recursion detected in policy for relation "call_participants"
--
-- The same error for `anon`. The policy on call_participants queries
-- call_participants:
--
--     call_participants_select  USING (
--       EXISTS (SELECT 1 FROM call_participants me
--                WHERE me.call_id = call_participants.call_id
--                  AND me.user_id = auth.uid()))
--
-- The inner SELECT is itself subject to call_participants_select, which runs the
-- inner SELECT again. Postgres detects the cycle and raises rather than looping.
--
-- BLAST RADIUS IS BOTH TABLES, not one. call_sessions_select subqueries
-- call_participants, so reading a call session evaluates the recursive policy
-- too and fails identically. Every read path for the calling feature is dead.
--
-- Production holds REAL rows here — 4 call sessions and 7 participant rows
-- across 5 distinct users, from 2026-07-21 to 2026-08-05. (An earlier reading of
-- `pg_stat_user_tables.n_live_tup` showed 0 and was wrong: that column is a
-- stale estimate, not a count. Count the rows.) So this is not a latent defect
-- waiting on first use — every read of that existing history fails today.
--
-- Because real rows are involved, the change was REHEARSED against production
-- inside a transaction that was then rolled back. Ground truth computed without
-- RLS said a given participant should see 2 participant rows; under the new
-- policy that participant saw exactly 2, a non-participant saw 0, and anon saw
-- 0, with no 42P17. The policy is not merely "not an error" — it returns the
-- same set the intended predicate describes.
--
-- Found by mechanising the pattern behind the message_thread_members recursion
-- discovered the same day: a sweep of all 742 policies across 332 public tables
-- for "policy whose expression selects FROM its own table" returned exactly two
-- hits — mtm_select, and this one.
--
--
-- THE FIX, AND WHY THE FUNCTION TAKES NO USER ID
-- ----------------------------------------------
-- Membership is resolved through a SECURITY DEFINER helper. Owned by `postgres`
-- and call_participants is `ENABLE` (not `FORCE`) ROW LEVEL SECURITY, so the
-- owner's read inside the function bypasses RLS and the cycle is broken.
--
-- The helper takes ONLY the call id. The viewer comes from auth.uid() INSIDE the
-- function. That is deliberate and load-bearing:
--
--   * A policy predicate must be EXECUTE-able by the querying role, because
--     Postgres evaluates RLS expressions with the QUERYING role's privileges
--     (the finding that shaped 2182). So this function CANNOT be revoked from
--     anon/authenticated the way an ordinary helper would be.
--   * Therefore it must not accept a caller-supplied identity. A
--     `(call_id, user_id)` signature would be exactly the privacy oracle 2182
--     closed: any caller could ask "is user X in call Y" about arbitrary users.
--     With auth.uid() read internally, the only question anyone can ask is "am
--     I in call Y", whose answer they already have.
--
-- It lives in `authz` (created by 2182) rather than `public` so PostgREST does
-- not expose it as an RPC endpoint; PostgREST exposure is governed by its
-- db-schemas setting, and `authz` is not in it. USAGE on the schema is already
-- granted to anon/authenticated by 2182 and is required for the policies to
-- resolve the function at all.
--
-- DO NOT "harden" THIS BY REVOKING EXECUTE. Revoking it from anon/authenticated
-- does not narrow anything — it breaks every call read outright, because the
-- policy can no longer evaluate. That mistake is the reason 2182 chose
-- SET SCHEMA over REVOKE, and the same reasoning applies here.

BEGIN;

DO $$
BEGIN
  IF to_regnamespace('authz') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: schema authz missing — apply 2182 first.';
  END IF;
  IF to_regclass('public.call_participants') IS NULL OR to_regclass('public.call_sessions') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: call tables missing.';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION authz.viewer_in_call(p_call_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM public.call_participants cp
    WHERE cp.call_id = p_call_id
      AND cp.user_id = auth.uid()
  );
$fn$;

COMMENT ON FUNCTION authz.viewer_in_call(uuid) IS
  'True when the CURRENT viewer (auth.uid(), read inside the function — never a parameter) is a participant of the given call. SECURITY DEFINER so the membership read bypasses RLS on call_participants and cannot recurse into the policy that calls it. Must remain EXECUTE-able by anon and authenticated: RLS predicates are evaluated with the querying role''s privileges, so revoking it does not harden anything, it breaks every call read.';

-- EXECUTE for the roles that evaluate the policies. See the header: this is
-- required for correctness, not an oversight.
GRANT EXECUTE ON FUNCTION authz.viewer_in_call(uuid) TO anon, authenticated, service_role;

-- ── call_participants: no longer self-referential ────────────────────────────
-- Semantics preserved exactly: a viewer sees participant rows of any call they
-- are in. The `user_id = auth.uid()` disjunct is kept first so a viewer's own
-- row resolves without the function call at all.
DROP POLICY IF EXISTS call_participants_select ON public.call_participants;
CREATE POLICY call_participants_select ON public.call_participants
  FOR SELECT
  USING (user_id = auth.uid() OR authz.viewer_in_call(call_id));

-- ── call_sessions: same predicate, no dependence on the other table's policy ──
-- Previously it subqueried call_participants, so it inherited the recursion.
-- Routing it through the same helper makes the two policies agree by
-- construction rather than by two hand-written expressions staying in step.
DROP POLICY IF EXISTS call_sessions_select ON public.call_sessions;
CREATE POLICY call_sessions_select ON public.call_sessions
  FOR SELECT
  USING (authz.viewer_in_call(id));

-- ── A snapshot the shape guard can read ──────────────────────────────────────
-- pg_policies is a catalog view and is not exposed through PostgREST, so the
-- regression test that keeps these two defect classes from coming back has no
-- way to see policy text. This returns just enough for that check: the table,
-- the policy name, and the combined USING/WITH CHECK expression.
--
-- service_role ONLY. Policy expressions describe the authorization logic itself,
-- so this is deliberately not readable by anon or authenticated.
CREATE OR REPLACE FUNCTION public.pg_policies_snapshot()
RETURNS TABLE (tablename text, policyname text, cmd text, roles text, expr text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $fn$
  SELECT p.tablename::text, p.policyname::text, p.cmd::text, p.roles::text,
         coalesce(p.qual,'') || ' ' || coalesce(p.with_check,'')
  FROM pg_policies p
  WHERE p.schemaname = 'public';
$fn$;

REVOKE ALL ON FUNCTION public.pg_policies_snapshot() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pg_policies_snapshot() TO service_role;

COMMENT ON FUNCTION public.pg_policies_snapshot() IS
  'Diagnostic: public-schema RLS policy shapes (table, policy, cmd, roles, combined USING/WITH CHECK text) for the policy-shape regression guard. pg_policies is a catalog view and is not reachable through PostgREST. service_role only — policy expressions describe the authorization logic itself.';

DO $$
BEGIN
  IF to_regprocedure('authz.viewer_in_call(uuid)') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: authz.viewer_in_call missing';
  END IF;
  IF to_regprocedure('public.pg_policies_snapshot()') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: pg_policies_snapshot missing';
  END IF;
  IF has_function_privilege('anon', 'public.pg_policies_snapshot()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.pg_policies_snapshot()', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: pg_policies_snapshot is reachable by anon/authenticated';
  END IF;
  -- search_path must be pinned on a SECURITY DEFINER function.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname='authz' AND p.proname='viewer_in_call'
      AND array_to_string(p.proconfig, ',') LIKE '%search_path%'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: authz.viewer_in_call has no pinned search_path';
  END IF;
  -- The policies must NOT reference their own tables any more.
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='call_participants'
      AND coalesce(qual,'') ~ '(FROM|JOIN)\s+(public\.)?call_participants\M'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: call_participants policy still selects from its own table';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='call_sessions'
      AND coalesce(qual,'') ~ '(FROM|JOIN)\s+(public\.)?call_participants\M'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: call_sessions policy still subqueries call_participants';
  END IF;
  -- Inverted on purpose: these roles MUST keep EXECUTE or the policies cannot
  -- evaluate and every call read fails.
  IF NOT has_function_privilege('anon', 'authz.viewer_in_call(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'authz.viewer_in_call(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: anon/authenticated must retain EXECUTE on authz.viewer_in_call, or RLS cannot evaluate it';
  END IF;
END $$;

COMMIT;

-- REVERSAL:
--   DROP POLICY IF EXISTS call_participants_select ON public.call_participants;
--   CREATE POLICY call_participants_select ON public.call_participants FOR SELECT
--     USING (EXISTS (SELECT 1 FROM call_participants me
--                     WHERE me.call_id = call_participants.call_id AND me.user_id = auth.uid()));
--   DROP POLICY IF EXISTS call_sessions_select ON public.call_sessions;
--   CREATE POLICY call_sessions_select ON public.call_sessions FOR SELECT
--     USING (EXISTS (SELECT 1 FROM call_participants cp
--                     WHERE cp.call_id = call_sessions.id AND cp.user_id = auth.uid()));
--   DROP FUNCTION IF EXISTS authz.viewer_in_call(uuid);
--   NOTE: reversing restores the 42P17 recursion — both tables become unreadable again.
