-- 2401_telegraph_messages_rls_latent_disclosure.sql
-- Telegraph §26 "Non-member reads conversation → DENY", §29 "No silent schema
-- failures that become plausible empty state" — the two messages SELECT
-- policies that would open every message to every caller the moment the
-- membership-table recursion (2402) is repaired.
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Telegraph lane 2400-2409.
--
-- INERT BY CONSTRUCTION. After this file, every non-service read of
-- public.messages still fails with 42P17 exactly as it does today, because
-- message_thread_members.mtm_select (which msg_select subqueries) is still
-- self-recursive. That recursion is repaired SEPARATELY, in 2402, which is NOT
-- inert; this file exists so that 2402 — or any future hand-fix of mtm_select —
-- cannot turn a hard error into a silent cross-tenant read. It defuses the trap
-- 2402 would otherwise spring. Order is enforced: 2402 refuses to run unless
-- this file's postconditions hold.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT WAS MEASURED (2026-09-07, pg_policies on both databases)
-- ══════════════════════════════════════════════════════════════════════════════
-- public.messages carries two PERMISSIVE SELECT policies. Permissive policies
-- are OR-ed, so a row is visible if EITHER admits it.
--
--   msg_select                     PRODUCTION (ajrurzioarfkagpuxfnb):
--     USING (EXISTS (SELECT 1 FROM message_thread_members mtm
--             WHERE mtm.thread_id = mtm.thread_id      ← a column compared to ITSELF
--               AND mtm.user_id = auth.uid() AND mtm.left_at IS NULL))
--     The correlation was written unqualified (`= thread_id`) inside a
--     subquery whose FROM is also called thread_id, so Postgres bound it to the
--     inner table. It reads "is the caller an active member of ANY thread",
--     not "of THIS thread". The 2026-08-19 production baseline dump
--     (baseline/20260819_baseline_structure.sql:29376) shows the same text.
--     CI (hwokxgbmezheskbzskfr) already has the correct `= messages.thread_id`;
--     no migration in the tree authored either — the fix reached CI by hand
--     and never reached production. This file makes it a recorded migration.
--
--   messages_hide_blocked_sender   BOTH databases:
--     USING (NOT authz.is_blocked(auth.uid(), sender_id))
--     Named as a HIDE rule, written as a PERMISSIVE policy. OR-ed beside
--     msg_select it does not hide anything — it GRANTS every row whose sender
--     the caller has not blocked. And authz.is_blocked(NULL, x) is false, so
--     for the anon role (auth.uid() IS NULL) it grants every row outright.
--     This is the exact shape commit 4a166aeb documented on three other
--     tables: a careful policy dominated by a permissive neighbour.
--
-- Today neither matters, because the mtm_select recursion (42P17) aborts the
-- whole read before either predicate is evaluated — verified on CI and on
-- production with `SET LOCAL ROLE anon; SELECT count(*) FROM public.messages`
-- inside a rolled-back transaction: both raise 42P17. That is the only reason
-- every message in production is not readable with the anon key. It is not a
-- guarantee; it is an error that happens to be in the way.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE FIX
-- ══════════════════════════════════════════════════════════════════════════════
--   msg_select                     correlated on messages.thread_id, explicitly
--                                  table-qualified so it cannot rebind.
--   messages_hide_blocked_sender   RESTRICTIVE, and requires a non-null
--                                  auth.uid(). A restrictive policy is AND-ed
--                                  with the permissive set: it can only ever
--                                  narrow. Its NAME finally matches its effect.
--
-- The policy COUNT on public.messages is unchanged (4: hide, select, insert,
-- update), so scripts/rlsDispositions.ts (`messages: policyCount 4`) still
-- holds and test/rlsPolicyShapeLive.test.ts's TAUTOLOGY sweep gains no new
-- offender.
--
-- WHY NOT ALSO FIX THE RECURSION HERE. Because that changes behaviour: the
-- mobile client makes five direct PostgREST reads of message_thread_members
-- (app/messages/[id].tsx:1234,1248,1260,1435; GroupChatScreen.tsx:575) that
-- fail today and would start succeeding. One of them gates the composer for
-- trip and circle threads. Un-breaking that is the right thing, and it is a
-- visible change, so it is its own file (2402) that an operator applies
-- deliberately. This file changes nothing anyone can observe.
--
-- ROLLBACK: db/rollback/2026-09-07-2401-telegraph-messages-rls-latent-disclosure-rollback.sql

BEGIN;

-- ── Preconditions ─────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.messages') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.messages must exist.';
  END IF;
  IF to_regclass('public.message_thread_members') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.message_thread_members must exist.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'authz' AND p.proname = 'is_blocked'
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: authz.is_blocked must exist (migration 2182).';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'messages' AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: RLS must be enabled on public.messages.';
  END IF;
END $$;

-- ── msg_select: correlate on THIS message's thread ───────────────────────────
DROP POLICY IF EXISTS msg_select ON public.messages;
CREATE POLICY msg_select ON public.messages
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
        FROM public.message_thread_members mtm
       WHERE mtm.thread_id = messages.thread_id
         AND mtm.user_id = auth.uid()
         AND mtm.left_at IS NULL
    )
  );

-- ── messages_hide_blocked_sender: a HIDE rule must be RESTRICTIVE ─────────────
DROP POLICY IF EXISTS messages_hide_blocked_sender ON public.messages;
CREATE POLICY messages_hide_blocked_sender ON public.messages
  AS RESTRICTIVE
  FOR SELECT
  USING (
    auth.uid() IS NOT NULL
    AND NOT authz.is_blocked(auth.uid(), sender_id)
  );

-- ── Postconditions ────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_select_qual text;
  v_hide_perm   text;
  v_hide_qual   text;
  v_count       integer;
BEGIN
  SELECT qual INTO v_select_qual FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'messages' AND policyname = 'msg_select';
  IF v_select_qual IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: msg_select is absent.';
  END IF;
  IF v_select_qual NOT LIKE '%mtm.thread_id = messages.thread_id%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: msg_select is not correlated on messages.thread_id: %', v_select_qual;
  END IF;
  IF v_select_qual ~ '\(([a-z_]+)\.([a-z_]+) = \1\.\2\)' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: msg_select still compares a column to itself: %', v_select_qual;
  END IF;

  SELECT permissive, qual INTO v_hide_perm, v_hide_qual FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'messages' AND policyname = 'messages_hide_blocked_sender';
  IF v_hide_perm IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: messages_hide_blocked_sender is absent.';
  END IF;
  IF v_hide_perm <> 'RESTRICTIVE' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: messages_hide_blocked_sender must be RESTRICTIVE, is %', v_hide_perm;
  END IF;
  IF v_hide_qual NOT LIKE '%auth.uid() IS NOT NULL%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: messages_hide_blocked_sender must require a non-null auth.uid(): %', v_hide_qual;
  END IF;

  SELECT count(*) INTO v_count FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'messages';
  IF v_count <> 4 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: public.messages must carry exactly 4 policies (rlsDispositions), has %', v_count;
  END IF;
END $$;

COMMIT;
