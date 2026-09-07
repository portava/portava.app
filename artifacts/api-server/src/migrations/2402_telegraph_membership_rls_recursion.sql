-- 2402_telegraph_membership_rls_recursion.sql
-- Telegraph §26 "Non-member reads conversation → DENY" and §27.3 "Every RLS
-- role has intended positive and negative access" — repair of the
-- self-recursive membership policy that makes EVERY non-service read of
-- message_thread_members, messages and message_threads fail with 42P17.
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Telegraph lane 2400-2409.
--
-- ⚠ NOT INERT. This file changes what a user can observe. Read the section
-- "WHAT BECOMES VISIBLE" before applying it anywhere but CI. It is kept
-- separate from 2401 (inert) for exactly that reason, and it REFUSES to run
-- unless 2401's postconditions already hold, because without 2401 this repair
-- converts a hard error into a silent grant of every message to every caller.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT WAS MEASURED (2026-09-07)
-- ══════════════════════════════════════════════════════════════════════════════
-- message_thread_members.mtm_select, identical on CI and production:
--   USING ((auth.uid() = user_id) OR (EXISTS (SELECT 1
--           FROM message_thread_members self
--          WHERE self.thread_id = self.thread_id AND self.user_id = auth.uid())))
-- Two defects in one predicate. It selects FROM the table it protects, so
-- Postgres re-enters the policy and raises 42P17 on every evaluation; and its
-- correlation is a column compared to itself. test/rlsPolicyShapeLive.test.ts
-- has carried it as the single KNOWN_OPEN entry since 2026-08-28 with the note
-- "being fixed separately — deliberately both at once".
--
-- Verified live, inside rolled-back transactions, on BOTH databases:
--   SET LOCAL ROLE authenticated; SELECT count(*) FROM message_thread_members
--     → 42P17 infinite recursion detected in policy for relation "message_thread_members"
--   SET LOCAL ROLE anon; SELECT count(*) FROM messages
--     → 42P17 (msg_select subqueries the recursive table)
-- Blast radius: messages (msg_select), message_threads (mt_select) and the
-- table itself. The API server is unaffected — routes/messaging.ts reads
-- through the SERVICE-ROLE client (lib/http.ts requireUser hands back
-- getServiceClient()), which bypasses RLS. The mobile client is not: it makes
-- five direct PostgREST reads of message_thread_members
-- (app/messages/[id].tsx:1234, :1248, :1260, :1435; GroupChatScreen.tsx:575),
-- every one of which has failed on every call since the policy was written.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE FIX — the 2199 pattern, verbatim in spirit
-- ══════════════════════════════════════════════════════════════════════════════
-- Membership is resolved through a SECURITY DEFINER helper in `authz`, owned
-- by postgres. message_thread_members is ENABLE (not FORCE) ROW LEVEL SECURITY
-- and owned by postgres (checked in the preconditions), so the owner's read
-- inside the function bypasses RLS and the cycle is broken.
--
-- The helper takes ONLY the thread id; the viewer is auth.uid() INSIDE the
-- function. As 2199 explains: a policy predicate runs with the QUERYING
-- role's privileges, so the function must be EXECUTE-able by anon and
-- authenticated and therefore must never accept a caller-supplied identity —
-- a (thread_id, user_id) signature would be a membership oracle. With
-- auth.uid() read internally the only question anyone can ask is "am I an
-- active member of thread T", whose answer they already have.
--
-- It lives in `authz` so PostgREST does not expose it as an RPC. USAGE on the
-- schema is (re)granted idempotently; 2182 granted it originally.
--
-- Three policies are rewritten on top of it:
--   mtm_select  USING (auth.uid() = user_id OR authz.is_active_thread_member(thread_id))
--   msg_select  USING (authz.is_active_thread_member(thread_id))
--   mt_select   USING (authz.is_active_thread_member(id))
-- Each says exactly what its name says, and none selects from its own table.
-- msg_select's 2401 form (a correlated EXISTS over message_thread_members)
-- would also have worked once mtm_select stopped recursing — the subquery
-- evaluates under mtm_select, whose first disjunct admits the caller's own
-- row — but routing all three through one helper means one predicate to read,
-- one to test, and one place a future change lands.
--
-- The RESTRICTIVE messages_hide_blocked_sender from 2401 stays and is AND-ed.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT BECOMES VISIBLE (why this is not inert)
-- ══════════════════════════════════════════════════════════════════════════════
-- The five client reads above start returning rows instead of an error:
--   - the member count on trip/circle threads renders;
--   - the DM read-receipt (other party's last_read_at) renders;
--   - the "accepted member" gate at app/messages/[id].tsx:1260 becomes true for
--     an active member, and the composer it guards (:2088) APPEARS for trip
--     and circle threads opened through that screen.
-- Everything that appears is what the client code already intends to show to
-- an active member and nothing more: no non-member, departed member or anon
-- caller gains a row (rehearsed below). But "appears" is a change, so this
-- file is applied on purpose, not as a side effect.
--
-- REHEARSAL. Applied on CI with a two-member fixture: member A reads both
-- membership rows and both messages; non-member C reads 0 of each; anon reads
-- 0 of each; no 42P17. Recorded in the accompanying report, not here.
--
-- AFTER APPLYING TO CI: remove "message_thread_members::mtm_select" from
-- KNOWN_OPEN in test/rlsPolicyShapeLive.test.ts, whose third case fails on a
-- stale allowlist entry by design.
--
-- ROLLBACK: db/rollback/2026-09-07-2402-telegraph-membership-rls-recursion-rollback.sql

BEGIN;

-- ── Preconditions ─────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_hide_perm  text;
  v_select_qual text;
  v_owner      text;
  v_force      boolean;
BEGIN
  -- 2401 must be in effect: this repair MUST NOT land on a permissive hide policy.
  SELECT permissive INTO v_hide_perm FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'messages' AND policyname = 'messages_hide_blocked_sender';
  IF v_hide_perm IS DISTINCT FROM 'RESTRICTIVE' THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: messages_hide_blocked_sender must be RESTRICTIVE (apply 2401 first). Repairing the recursion over a PERMISSIVE hide policy opens every message to every caller.';
  END IF;
  SELECT qual INTO v_select_qual FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'messages' AND policyname = 'msg_select';
  IF v_select_qual IS NULL OR v_select_qual ~ '\(([a-z_]+)\.([a-z_]+) = \1\.\2\)' THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: msg_select is absent or still tautological (apply 2401 first).';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'authz') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: schema authz must exist (migration 2182).';
  END IF;

  -- The owner-bypass the helper relies on: table owned by the role that will
  -- own the function, and RLS not FORCEd.
  SELECT pg_get_userbyid(c.relowner), c.relforcerowsecurity INTO v_owner, v_force
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'message_thread_members';
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.message_thread_members must exist.';
  END IF;
  IF v_owner <> 'postgres' THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: message_thread_members must be owned by postgres for the SECURITY DEFINER bypass; owner is %', v_owner;
  END IF;
  IF v_force THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: message_thread_members has FORCE ROW LEVEL SECURITY; the owner bypass this repair relies on would not apply.';
  END IF;

  IF to_regclass('public.messages') IS NULL OR to_regclass('public.message_threads') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.messages and public.message_threads must exist.';
  END IF;
END $$;

-- ── The helper ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION authz.is_active_thread_member(p_thread_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $fn$
  SELECT EXISTS (
    SELECT 1
      FROM public.message_thread_members m
     WHERE m.thread_id = p_thread_id
       AND m.user_id = auth.uid()
       AND m.left_at IS NULL
  );
$fn$;

ALTER FUNCTION authz.is_active_thread_member(uuid) OWNER TO postgres;

COMMENT ON FUNCTION authz.is_active_thread_member(uuid) IS
  'Telegraph §26: is the CALLER (auth.uid(), read internally — never a parameter) an active member of thread p_thread_id. SECURITY DEFINER owned by postgres so RLS policies on message_thread_members, messages and message_threads can consult membership without re-entering mtm_select (42P17). Takes no user id on purpose: a (thread, user) signature would be a membership oracle to anon/authenticated, which must hold EXECUTE for the policies to evaluate at all (see 2199).';

-- Policy predicates evaluate with the querying role's privileges: anon and
-- authenticated MUST be able to execute this, or every read fails outright.
GRANT USAGE ON SCHEMA authz TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION authz.is_active_thread_member(uuid) TO anon, authenticated, service_role;

-- ── The three policies ────────────────────────────────────────────────────────
DROP POLICY IF EXISTS mtm_select ON public.message_thread_members;
CREATE POLICY mtm_select ON public.message_thread_members
  FOR SELECT
  USING (auth.uid() = user_id OR authz.is_active_thread_member(thread_id));

DROP POLICY IF EXISTS msg_select ON public.messages;
CREATE POLICY msg_select ON public.messages
  FOR SELECT
  USING (authz.is_active_thread_member(thread_id));

DROP POLICY IF EXISTS mt_select ON public.message_threads;
CREATE POLICY mt_select ON public.message_threads
  FOR SELECT
  USING (authz.is_active_thread_member(id));

-- ── Postconditions ────────────────────────────────────────────────────────────
DO $$
DECLARE
  r record;
  v_prosecdef boolean;
  v_config text[];
BEGIN
  SELECT p.prosecdef, p.proconfig INTO v_prosecdef, v_config
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'authz' AND p.proname = 'is_active_thread_member';
  IF v_prosecdef IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: authz.is_active_thread_member does not exist.';
  END IF;
  IF v_prosecdef IS NOT TRUE THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: authz.is_active_thread_member must be SECURITY DEFINER.';
  END IF;
  IF v_config IS NULL OR array_to_string(v_config, ',') NOT LIKE '%search_path%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: authz.is_active_thread_member must pin search_path.';
  END IF;
  IF NOT has_function_privilege('authenticated', 'authz.is_active_thread_member(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('anon', 'authz.is_active_thread_member(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: anon and authenticated must hold EXECUTE on authz.is_active_thread_member, or every policy that calls it fails.';
  END IF;

  -- No policy on the three tables selects FROM its own table any more, and
  -- none compares a column to itself.
  FOR r IN
    SELECT tablename, policyname, qual FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename IN ('message_thread_members', 'messages', 'message_threads')
  LOOP
    IF r.qual ~ ('(FROM|JOIN)\s+(public\.)?' || r.tablename || '\M') THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED: %.% still selects from its own table: %', r.tablename, r.policyname, r.qual;
    END IF;
    IF r.qual ~ '\(([a-z_]+)\.([a-z_]+) = \1\.\2\)' THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED: %.% still compares a column to itself: %', r.tablename, r.policyname, r.qual;
    END IF;
  END LOOP;

  -- Policy counts unchanged (scripts/rlsDispositions.ts): mtm 2, messages 4, threads 1.
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'message_thread_members') <> 2
     OR (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'messages') <> 4
     OR (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'message_threads') <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: policy counts on the three Telegraph tables no longer match rlsDispositions (expected 2 / 4 / 1).';
  END IF;
END $$;

COMMIT;
