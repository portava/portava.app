-- Rollback for 2402_telegraph_membership_rls_recursion.sql
-- Applied by hand to portava-ci (hwokxgbmezheskbzskfr) on 2026-09-07, with a
-- schema_migration_ledger row (applied_by = 'manual').
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 2402 DID
-- =============
--   1. CREATE FUNCTION authz.is_active_thread_member(uuid), SECURITY DEFINER,
--      owned by postgres, EXECUTE granted to anon/authenticated/service_role.
--   2. Rewrote three SELECT policies to use it:
--        message_thread_members.mtm_select
--        messages.msg_select
--        message_threads.mt_select
--
-- WHAT THIS RESTORES, AND WHAT IT DELIBERATELY DOES NOT
-- ====================================================
-- msg_select and mt_select go back to their 2401 / original correlated-EXISTS
-- forms. mtm_select is NOT restored to its recursive, tautological original:
-- reintroducing a policy that raises 42P17 on every read and would grant every
-- thread's membership rows once fixed is not a rollback, it is a regression
-- with a rollback's filename. It is restored to the NON-recursive predicate the
-- original was evidently reaching for — the caller's own rows only:
--
--   USING (auth.uid() = user_id)
--
-- This is STRICTLY NARROWER than the original's intent (a member no longer
-- sees the other members' rows through PostgREST), so the client's member
-- count read (app/messages/[id].tsx:1248) and the DM read-receipt read (:1234)
-- return 0 / null rather than erroring; the composer gate (:1260) still works
-- because it reads the caller's own row. If you need the ORIGINAL bytes back
-- verbatim, they are in baseline/20260819_baseline_structure.sql:29408, and
-- test/rlsPolicyShapeLive.test.ts must regain its KNOWN_OPEN entry.
--
-- After this rollback, msg_select and mt_select subquery message_thread_members
-- under the narrowed mtm_select, whose predicate admits the caller's own row —
-- so both keep working, without recursion.
--
-- Roll this back BEFORE 2401's rollback (2401's rollback refuses otherwise).
--
-- Idempotent.

BEGIN;

DROP POLICY IF EXISTS mtm_select ON public.message_thread_members;
CREATE POLICY mtm_select ON public.message_thread_members
  FOR SELECT
  USING (auth.uid() = user_id);

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

DROP POLICY IF EXISTS mt_select ON public.message_threads;
CREATE POLICY mt_select ON public.message_threads
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
        FROM public.message_thread_members mtm
       WHERE mtm.thread_id = message_threads.id
         AND mtm.user_id = auth.uid()
         AND mtm.left_at IS NULL
    )
  );

DROP FUNCTION IF EXISTS authz.is_active_thread_member(uuid);

DELETE FROM public.schema_migration_ledger WHERE filename = '2402_telegraph_membership_rls_recursion.sql';

COMMIT;
