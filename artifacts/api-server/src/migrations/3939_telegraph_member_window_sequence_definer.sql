-- 3939_telegraph_member_window_sequence_definer.sql
-- 3935's membership-window trigger runs as its OWNER (census-telegraph T210 / T139).
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band; lane TELEGRAPH's census-drive band
-- 3934-3949, 2026-10-24).
--
-- WRITTEN, NOT APPLIED. ONE RELEASE UNIT WITH 3935: 3935 must not be applied without 3939, and the
-- two are applied together. Two ALTER FUNCTION statements; no data, table, policy, grant or flag
-- change.
--
-- THE DEFECT IN 3935. Its trigger function public.telegraph_member_window_sequence() was SECURITY
-- INVOKER and calls public.telegraph_window_first_sequence(), whose EXECUTE 3935 revokes from PUBLIC,
-- anon and authenticated. A BEFORE trigger runs before row-level security's WITH CHECK, so a
-- client-role INSERT into message_thread_members was answered "permission denied for function
-- telegraph_window_first_sequence" — not by the table's policy (mtm_insert, WITH CHECK false on
-- production). Nothing was admitted, but the refusal came from a grant on a helper rather than from
-- the policy that is supposed to decide, and a wrong refusal reason can hide a real gap: had the
-- policy been loosened, the helper's grant would have kept the test green. As INVOKER the helper would
-- also have computed the bound over the CALLER's row-level-security view of messages, which is not the
-- conversation's sequence.
--
-- THE FIX, AND THE SECURITY DEFINER CHANGE STATED IN FULL:
--   * OWNER. The function keeps 3935's owner, the migration role (postgres on Supabase — the owner
--     of every Telegraph SECURITY DEFINER function, e.g. telegraph_unsend_message_before_seen and
--     telegraph_write_conversation_snapshot, and of public.messages and public.message_threads,
--     neither of which forces row-level security). The postcondition asserts the owner is not a
--     client role.
--   * search_path IS PINNED TO THE MINIMUM: pg_catalog, pg_temp — the system catalog only, with
--     pg_temp named LAST so a temporary object can never shadow a name. Nothing else is needed: the
--     body names one object, public.telegraph_window_first_sequence, schema-qualified, and that
--     helper names public.messages and public.message_threads schema-qualified (3935).
--   * CLIENT EXECUTE STAYS REVOKED from PUBLIC, anon and authenticated (re-stated below). A trigger
--     function is not reachable through PostgREST at all: it can only run as the trigger on a write
--     to message_thread_members.
--   * NO DYNAMIC SQL. Neither function builds or EXECUTEs a statement. The only inputs are the row
--     being written (NEW.thread_id uuid, NEW.visible_from_at timestamptz), passed as typed
--     parameters to a LANGUAGE sql helper; nothing a client can pass reaches a query string.
--   * WHY DEFINER ON THE TRIGGER, NOT A GRANT ON THE HELPER. Granting EXECUTE on
--     telegraph_window_first_sequence(uuid, timestamptz) to authenticated would publish a callable
--     RPC that answers, for ANY thread id, the first sequence at or after ANY time — a probe of
--     conversations the caller is not in. Making the TRIGGER function the definer exposes nothing
--     callable: it runs only inside a write the table's own policy then judges, it computes one
--     column of the row being written, and the helper stays unexecutable by every client role.
--     A client write therefore reaches mtm_insert and is refused THERE.
--
-- PINNED BY src/test/db/telegraphMemberWindowSequence.db.test.ts (a client INSERT is refused by
-- row-level security and NOT by a function-permission error; the function is SECURITY DEFINER with
-- this search_path and no client EXECUTE) and src/test/db/telegraphMemberRemovedAt.db.test.ts
-- ("NO CLIENT WRITES IT"). Mutant WD1 (back to INVOKER) turns both red.
--
-- ORDER: depends on 3935 (the function and its trigger). Nothing numbered above 3939 alters it.
--
-- ROLLBACK (restores 3935's exact posture):
--   BEGIN;
--   ALTER FUNCTION public.telegraph_member_window_sequence() SECURITY INVOKER;
--   ALTER FUNCTION public.telegraph_member_window_sequence() SET search_path = pg_catalog, public;
--   DELETE FROM public.schema_migration_ledger WHERE filename = '3939_telegraph_member_window_sequence_definer.sql';
--   COMMIT;

BEGIN;

DO $pre$
BEGIN
  IF to_regprocedure('public.telegraph_member_window_sequence()') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3939): public.telegraph_member_window_sequence() (3935) does not exist.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.message_thread_members'::regclass
                   AND tgname = 'telegraph_member_window_sequence' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3939): trigger telegraph_member_window_sequence (3935) is not on message_thread_members.';
  END IF;
  IF position('EXECUTE' IN upper(pg_get_functiondef('public.telegraph_member_window_sequence()'::regprocedure))) > 0 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3939): telegraph_member_window_sequence() contains dynamic SQL; this migration does not make such a function a definer.';
  END IF;
END $pre$;

ALTER FUNCTION public.telegraph_member_window_sequence() SECURITY DEFINER;
ALTER FUNCTION public.telegraph_member_window_sequence() SET search_path = pg_catalog, pg_temp;
REVOKE ALL ON FUNCTION public.telegraph_member_window_sequence() FROM PUBLIC, anon, authenticated;

COMMIT;

DO $post$
DECLARE
  v_owner text;
BEGIN
  SELECT pg_get_userbyid(proowner) INTO v_owner FROM pg_proc WHERE oid = 'public.telegraph_member_window_sequence()'::regprocedure;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.telegraph_member_window_sequence()'::regprocedure) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3939): telegraph_member_window_sequence() is not SECURITY DEFINER.';
  END IF;
  IF (SELECT proconfig FROM pg_proc WHERE oid = 'public.telegraph_member_window_sequence()'::regprocedure)
       IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp'] THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3939): telegraph_member_window_sequence() search_path is not exactly pg_catalog, pg_temp.';
  END IF;
  IF v_owner IN ('anon', 'authenticated', 'authenticator', 'public') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3939): telegraph_member_window_sequence() is owned by a client role (%).', v_owner;
  END IF;
  IF has_function_privilege('anon', 'public.telegraph_member_window_sequence()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.telegraph_member_window_sequence()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.telegraph_window_first_sequence(uuid, timestamptz)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.telegraph_window_first_sequence(uuid, timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3939): a client role can execute the window trigger function or its helper.';
  END IF;
END $post$;
