-- 2198_messaging_rls_recursion_and_correlation.sql
--
-- Messaging reads are BROKEN in production, and underneath the break they are
-- wide open. POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- Found 2026-08-28 while applying 2182. NOT caused by 2182: none of the three
-- policies below references any function 2182 relocated, and the live
-- expressions predate it (they are byte-identical in the 2026-08-19 baseline
-- dump, artifacts/api-server/baseline/20260819_baseline_structure.sql).
--
-- ── THE THREE DEFECTS ───────────────────────────────────────────────────────
--
-- D1 — INFINITE RECURSION (42P17). Reads are dead right now.
--   The SELECT policy on message_thread_members queries message_thread_members:
--     mtm_select  USING (auth.uid() = user_id
--                        OR EXISTS (SELECT 1 FROM message_thread_members self
--                                    WHERE self.thread_id = self.thread_id
--                                      AND self.user_id = auth.uid()))
--   RLS applies to tables named inside a policy expression, so evaluating
--   mtm_select requires evaluating mtm_select. Every read of messages,
--   message_threads or message_thread_members raises
--     42P17 infinite recursion detected in policy for relation
--           "message_thread_members"
--   Verified live as role anon: SELECT count(*) FROM public.messages raises it.
--
-- D2 — THE CORRELATION IS A TAUTOLOGY. Under the error, no isolation.
--   `self.thread_id = self.thread_id` compares a column to ITSELF: always true.
--   The identical shape is live on messages:
--     msg_select  USING (EXISTS (SELECT 1 FROM message_thread_members mtm
--                                 WHERE mtm.thread_id = mtm.thread_id
--                                   AND mtm.user_id = auth.uid()
--                                   AND mtm.left_at IS NULL))
--   That asks "is this user a member of ANY thread", not "of THIS thread".
--   Fixing D1 alone converts a hard error into a silent cross-thread leak.
--
--   ROOT CAUSE, so it is not repeated. The source (migrations/0008_messaging.sql
--   :134 and :167, migrations/0010_group_chat.sql:79) reads
--       WHERE mtm.thread_id = thread_id
--   An unqualified name inside a subquery resolves in the INNERMOST scope that
--   provides it. message_thread_members HAS a thread_id, so `thread_id` binds to
--   the subquery's own alias and Postgres never looks outward — it is not
--   ambiguous, so nothing warns. The sibling policy in the same file wrote
--       WHERE mtm.thread_id = id      -- mt_select, on message_threads
--   and is CORRECT, because message_thread_members has no `id` column, so the
--   name could only resolve outward. The bug appears exactly where the inner and
--   outer columns share a name — which is exactly where a correlation is needed.
--   A repo-wide scan of the live catalog for `x.c = x.c` finds these two policy
--   expressions and nothing else.
--
-- D3 — A PERMISSIVE POLICY THAT WAS MEANT TO SUBTRACT. Not in the report that
--      opened this work; found while auditing what else grants SELECT here.
--     messages_hide_blocked_sender
--       ON public.messages FOR SELECT USING (NOT is_blocked(auth.uid(), sender_id))
--   supabase/migrations/0015_blocks.sql created it to REMOVE blocked senders'
--   messages, reasoning (in its own comment) that "message thread access is
--   already gated by message_thread_members". Permissive policies OR; they do
--   not AND. So this policy independently GRANTS every message whose sender has
--   not blocked you — which is every message in the table, to every caller.
--   anon included: is_blocked(NULL, sender) is false, so NOT(...) is TRUE, and
--   anon holds GRANT ALL on public.messages (baseline:36728).
--   Today D1 masks it — the recursive policy errors before this one can grant.
--   Repairing D1+D2 and leaving D3 would hand every message in the database to
--   every anonymous caller. Its author's intent was a RESTRICTIVE policy; that
--   is what it becomes here, which is the fix AND the behaviour 0015 described.
--
-- ── THE FIX ─────────────────────────────────────────────────────────────────
-- One SECURITY DEFINER predicate, authz.is_thread_member(thread, user), used by
-- both SELECT policies:
--   * it breaks D1 — SECURITY DEFINER runs as the function owner, which is the
--     table owner, and the table is not FORCE ROW LEVEL SECURITY, so the body
--     does not re-enter RLS. Asserted below rather than assumed.
--   * it fixes D2 — the outer thread_id is passed as an ARGUMENT, so there is
--     no unqualified name left to mis-resolve. The failure mode is structurally
--     unavailable, not merely corrected.
--   * one definition of "active member of this thread" for both tables.
--
-- WHY `authz` AND NOT `public`. A SECURITY DEFINER authorization predicate in
-- `public` is a PostgREST oracle: POST /rpc/is_thread_member with a
-- caller-supplied thread and user id answers "who is in which conversation" for
-- anyone holding the publishable key. That is precisely the class 2182 closed by
-- moving is_blocked / in_accepted_circle / can_see_location out of `public`.
-- Creating this one in `public` would reopen it with a new name on the same day.
-- EXECUTE is granted to `authenticated` because a policy expression is evaluated
-- AS THE CALLER, so revoking it would break RLS rather than tighten it (the
-- 2182 lesson); `authz` is not in PostgREST's exposed schemas, so the grant is
-- not an endpoint. NOT granted to anon: every policy here is TO authenticated,
-- so anon never evaluates it.
--
-- ── WHAT CHANGES BEHAVIOURALLY, STATED PLAINLY ──────────────────────────────
-- 1. Reads work again (D1).
-- 2. A member sees only their own threads' messages and memberships (D2/D3).
-- 3. mtm_select gains `left_at IS NULL` on the VIEWER's membership. Prod's
--    mtm_select has no such filter because 0010 added left_at and updated
--    mt_select and msg_select but not mtm_select. A user who left a thread
--    already cannot read its messages; letting them keep reading its roster was
--    an oversight, not a decision. Their own row stays visible to them via the
--    `auth.uid() = user_id` branch.
-- 4. The three policies bind TO authenticated instead of PUBLIC. The predicates
--    already required auth.uid(), so this grants nothing new and makes anon's
--    exclusion structural rather than incidental (the 2143 convention).
--
-- ── WHAT DELIBERATELY DOES NOT CHANGE ───────────────────────────────────────
-- * mt_select on message_threads. Its correlation is correct (see D2), and its
--   subquery on message_thread_members now resolves through the repaired
--   mtm_select, so it stops raising 42P17 without being touched.
-- * msg_insert / msg_update / mtm_insert stay `false`: the API server writes
--   with the service role, which bypasses RLS. This migration governs direct
--   PostgREST/Realtime access only.
-- * The roster read stays available to co-members. FOUR live call sites read
--   OTHER members' rows directly over PostgREST with a user JWT:
--     travel-buddy-standalone/app/messages/[id].tsx:1231  DM read receipt
--                                                 :1245  group member count
--                                                 :1432  group read-receipt avatars
--     travel-buddy-standalone/src/components/GroupChatScreen.tsx:571  the same
--   Three of them are explicitly `.neq('user_id', <me>)`, so `auth.uid() = user_id`
--   alone cannot serve them. Dropping the EXISTS branch outright — the other
--   repair the brief offered — would have broken all four silently, returning
--   empty sets rather than errors. That is why this takes the SECURITY DEFINER
--   route instead. (Nothing in either app reads public.messages directly, and
--   there is no Realtime subscription on it; messages come from the API server,
--   which uses the service role.)
--
-- SAFE TO RE-RUN. Every DROP is IF EXISTS and every CREATE follows a DROP.

BEGIN;

-- ── Preconditions ───────────────────────────────────────────────────────────
DO $$
DECLARE
  forced boolean;
BEGIN
  IF to_regclass('public.messages') IS NULL
     OR to_regclass('public.message_thread_members') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.messages / public.message_thread_members must both exist.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='message_thread_members'
                    AND column_name='left_at') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: message_thread_members.left_at is missing; the active-member predicate depends on it.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='messages'
                    AND column_name='thread_id') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: messages.thread_id is missing; the correlation depends on it.';
  END IF;

  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.messages'::regclass)
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.message_thread_members'::regclass) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: RLS is not enabled on both tables. This migration repairs policies; it does not enable RLS.';
  END IF;

  -- The whole recursion fix rests on SECURITY DEFINER skipping RLS inside the
  -- helper. FORCE ROW LEVEL SECURITY applies policies to the table owner too,
  -- which would defeat it and put 42P17 straight back. Refuse rather than ship
  -- a fix whose mechanism has been disabled underneath it.
  SELECT relforcerowsecurity INTO forced
    FROM pg_class WHERE oid='public.message_thread_members'::regclass;
  IF forced THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: message_thread_members has FORCE ROW LEVEL SECURITY, so a SECURITY DEFINER helper owned by the table owner would still re-enter RLS and recurse. Resolve deliberately before applying.';
  END IF;

  -- D3 needs is_blocked. 2182 moved it public -> authz; both shapes are live
  -- somewhere, so require one of them rather than encoding one environment.
  IF to_regprocedure('authz.is_blocked(uuid,uuid)') IS NULL
     AND to_regprocedure('public.is_blocked(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: is_blocked(uuid,uuid) exists in neither authz nor public; messages_hide_blocked_sender cannot be rebuilt.';
  END IF;
END $$;

-- ── The membership predicate ────────────────────────────────────────────────
-- CREATE SCHEMA IF NOT EXISTS, not a hard dependency on 2182 having landed:
-- this must apply to an environment on either side of that migration.
CREATE SCHEMA IF NOT EXISTS authz;
GRANT USAGE ON SCHEMA authz TO anon, authenticated, service_role;

-- search_path = '' with every reference schema-qualified: the Supabase
-- function_search_path_mutable lint, satisfied at its strictest (cf. 2175).
CREATE OR REPLACE FUNCTION authz.is_thread_member(p_thread_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.message_thread_members m
     WHERE m.thread_id = p_thread_id
       AND m.user_id   = p_user_id
       AND m.left_at IS NULL
  );
$$;

COMMENT ON FUNCTION authz.is_thread_member(uuid, uuid) IS
  'Is p_user_id an ACTIVE member (left_at IS NULL) of p_thread_id? SECURITY '
  'DEFINER so the SELECT policy on message_thread_members can ask the question '
  'without re-entering its own policy (42P17). Lives in authz, not public, so '
  'PostgREST cannot expose it as a "who is in which thread" oracle (see 2182). '
  'Added by 2198.';

REVOKE ALL ON FUNCTION authz.is_thread_member(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.is_thread_member(uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION authz.is_thread_member(uuid, uuid) TO authenticated, service_role;

-- ── message_thread_members ──────────────────────────────────────────────────
DROP POLICY IF EXISTS "mtm_select" ON public.message_thread_members;

CREATE POLICY "mtm_select" ON public.message_thread_members
  FOR SELECT TO authenticated
  USING (
    auth.uid() = user_id
    OR authz.is_thread_member(message_thread_members.thread_id, auth.uid())
  );

-- ── messages ────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "msg_select" ON public.messages;

CREATE POLICY "msg_select" ON public.messages
  FOR SELECT TO authenticated
  USING (authz.is_thread_member(messages.thread_id, auth.uid()));

-- D3. Rebuilt AS RESTRICTIVE so it subtracts (ANDs) instead of granting (ORs).
-- Created through EXECUTE only because the schema of is_blocked differs across
-- environments pre/post-2182; the statement is otherwise ordinary. Note that
-- scripts/auditMigrationsVsLive.ts parses CREATE POLICY textually and so will
-- not claim this one — the live regression suite is what pins it.
DROP POLICY IF EXISTS "messages_hide_blocked_sender" ON public.messages;

DO $$
DECLARE fn text;
BEGIN
  fn := CASE
          WHEN to_regprocedure('authz.is_blocked(uuid,uuid)') IS NOT NULL THEN 'authz.is_blocked'
          ELSE 'public.is_blocked'
        END;
  EXECUTE format(
    'CREATE POLICY "messages_hide_blocked_sender" ON public.messages '
    'AS RESTRICTIVE FOR SELECT TO authenticated '
    'USING (NOT %s(auth.uid(), sender_id))', fn);
END $$;

COMMENT ON TABLE public.messages IS
  'SELECT is granted by exactly one permissive policy (msg_select: active '
  'member of THIS thread, via authz.is_thread_member) and narrowed by one '
  'restrictive policy (messages_hide_blocked_sender). Repaired by 2198: the '
  'previous msg_select correlated a column to itself, and the blocked-sender '
  'policy was permissive, so it granted every message to every caller.';

-- ── Postconditions ──────────────────────────────────────────────────────────
DO $$
DECLARE
  bad          text;
  n            int;
  fn_owner     oid;
  tbl_owner    oid;
  is_permissive text;
BEGIN
  -- 1. THE TAUTOLOGY GUARD. No policy on any messaging table may compare a
  --    column to itself. This is the assertion that makes D2 unreintroducible
  --    by the apply path: a back-referencing regex over the LIVE expression,
  --    not over the file that was supposed to produce it.
  SELECT p.polname || ': ' || pg_get_expr(p.polqual, p.polrelid)
    INTO bad
    FROM pg_policy p
   WHERE p.polrelid IN ('public.messages'::regclass,
                        'public.message_thread_members'::regclass,
                        'public.message_threads'::regclass)
     AND pg_get_expr(p.polqual, p.polrelid) ~ '([a-z_]+)\.([a-z_]+) = \1\.\2'
   LIMIT 1;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: a messaging policy still compares a column to itself (always true) -- %', bad;
  END IF;

  -- 2. Exactly ONE permissive policy may grant SELECT on each table. Permissive
  --    policies OR, so a leftover is a bypass however correct the new one is --
  --    this is what D3 was. FOR ALL counts: it grants SELECT too.
  SELECT count(*) INTO n FROM pg_policies
   WHERE schemaname='public' AND tablename='messages'
     AND permissive='PERMISSIVE' AND cmd IN ('SELECT','ALL');
  IF n <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: expected exactly 1 permissive SELECT-granting policy on messages, found %. Any extra one ORs with msg_select and defeats thread isolation.', n;
  END IF;

  SELECT count(*) INTO n FROM pg_policies
   WHERE schemaname='public' AND tablename='message_thread_members'
     AND permissive='PERMISSIVE' AND cmd IN ('SELECT','ALL');
  IF n <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: expected exactly 1 permissive SELECT-granting policy on message_thread_members, found %.', n;
  END IF;

  -- 3. The blocked-sender policy subtracts.
  SELECT permissive INTO is_permissive FROM pg_policies
   WHERE schemaname='public' AND tablename='messages'
     AND policyname='messages_hide_blocked_sender';
  IF is_permissive IS DISTINCT FROM 'RESTRICTIVE' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: messages_hide_blocked_sender is %, not RESTRICTIVE. As a permissive policy it GRANTS every message whose sender has not blocked the caller.', coalesce(is_permissive,'missing');
  END IF;

  -- 4. Both repaired policies must route through the helper.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy p
     WHERE p.polrelid='public.messages'::regclass AND p.polname='msg_select'
       AND pg_get_expr(p.polqual, p.polrelid) ~ 'is_thread_member'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: msg_select does not call is_thread_member.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy p
     WHERE p.polrelid='public.message_thread_members'::regclass AND p.polname='mtm_select'
       AND pg_get_expr(p.polqual, p.polrelid) ~ 'is_thread_member'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: mtm_select does not call is_thread_member.';
  END IF;

  -- 5. THE MECHANISM, ASSERTED. SECURITY DEFINER only skips RLS when the
  --    function owner is exempt from the table's policies -- i.e. is the table
  --    owner, absent FORCE RLS (checked in the preconditions). If a migration
  --    is ever applied by a different role, this catches it here instead of
  --    letting 42P17 come back at read time.
  SELECT p.proowner INTO fn_owner FROM pg_proc p
    JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname='authz' AND p.proname='is_thread_member';
  SELECT c.relowner INTO tbl_owner FROM pg_class c
   WHERE c.oid='public.message_thread_members'::regclass;
  IF fn_owner IS NULL OR fn_owner <> tbl_owner THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: authz.is_thread_member is owned by % but message_thread_members is owned by %. SECURITY DEFINER would still be subject to RLS and the recursion returns.',
      coalesce(fn_owner::regrole::text,'(missing)'), tbl_owner::regrole::text;
  END IF;
END $$;

-- ── Runtime proof, in the same transaction that made the change ─────────────
-- Everything above inspects the catalog. This EXECUTES the read path as a
-- stranger identity and asserts two things the catalog cannot:
--   * no 42P17 -- D1 is actually gone, not merely rewritten;
--   * a caller who is in NO thread sees ZERO rows. Before this migration that
--     same identity would have seen EVERY message via D3.
-- A failure here aborts the migration, which is the correct outcome: the change
-- has not been proven and must not persist. (The separate-transaction proof the
-- 2195 lesson requires is src/test/messagingThreadIsolation.test.ts, which runs
-- against the live database from its own connection.)
DO $probe$
DECLARE
  stranger constant uuid := '00000000-0000-4000-8000-00000000dead';
  n_msg    bigint;
  n_mtm    bigint;
  n_thr    bigint;
BEGIN
  PERFORM set_config('request.jwt.claims',
                     json_build_object('sub', stranger, 'role', 'authenticated')::text,
                     true);
  -- The handler wraps ONLY the role switch, whose sole failure modes are "not a
  -- member of that role" and "no such role". The reads below sit outside it on
  -- purpose, so a 42P17 propagates and aborts instead of being swallowed as a
  -- skip -- which would turn the one assertion that proves D1 into a no-op.
  BEGIN
    SET LOCAL ROLE authenticated;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '2198: runtime probe SKIPPED -- this connection may not SET ROLE authenticated. The catalog postconditions above still ran; src/test/messagingThreadIsolation.test.ts is the proof of record.';
    PERFORM set_config('request.jwt.claims', NULL, true);
    RETURN;
  END;

  SELECT count(*) INTO n_msg FROM (SELECT 1 FROM public.messages              LIMIT 5) s;
  SELECT count(*) INTO n_mtm FROM (SELECT 1 FROM public.message_thread_members LIMIT 5) s;
  SELECT count(*) INTO n_thr FROM (SELECT 1 FROM public.message_threads        LIMIT 5) s;

  RESET ROLE;
  PERFORM set_config('request.jwt.claims', NULL, true);

  IF n_msg <> 0 OR n_mtm <> 0 OR n_thr <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: an identity belonging to no thread can still read messaging rows (messages=%, memberships=%, threads=%). Thread isolation is not in force.', n_msg, n_mtm, n_thr;
  END IF;
END $probe$;

COMMIT;

-- REVERSAL:
--   NOTE FOR ANY FUTURE `x.c = x.c` SCAN OF THIS TREE: the block below quotes the
--   defective expressions VERBATIM, so a grep for the tautology will hit this
--   file. That is the one intended hit -- it is inside a comment and never
--   executes, and the live-catalog postcondition above is the check that counts.
--
--   Restores the exact pre-2198 live expressions. NOTE that reversing puts back
--   BOTH the 42P17 outage and the total message leak -- there is no state in
--   which the old policies were correct, so this exists for completeness, not as
--   a rollback anyone should want.
--
--   BEGIN;
--     DROP POLICY IF EXISTS "msg_select" ON public.messages;
--     CREATE POLICY "msg_select" ON public.messages FOR SELECT
--       USING (EXISTS (SELECT 1 FROM public.message_thread_members mtm
--                       WHERE mtm.thread_id = mtm.thread_id
--                         AND mtm.user_id = auth.uid()
--                         AND mtm.left_at IS NULL));
--
--     DROP POLICY IF EXISTS "mtm_select" ON public.message_thread_members;
--     CREATE POLICY "mtm_select" ON public.message_thread_members FOR SELECT
--       USING (auth.uid() = user_id
--              OR EXISTS (SELECT 1 FROM public.message_thread_members self
--                          WHERE self.thread_id = self.thread_id
--                            AND self.user_id = auth.uid()));
--
--     DROP POLICY IF EXISTS "messages_hide_blocked_sender" ON public.messages;
--     CREATE POLICY "messages_hide_blocked_sender" ON public.messages FOR SELECT
--       USING (NOT authz.is_blocked(auth.uid(), sender_id));  -- public.is_blocked pre-2182
--
--     DROP FUNCTION IF EXISTS authz.is_thread_member(uuid, uuid);
--   COMMIT;
--   -- CREATE SCHEMA authz is intentionally NOT reversed: 2182 owns that schema.
