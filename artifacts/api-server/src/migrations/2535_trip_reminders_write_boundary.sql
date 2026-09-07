-- 2535_trip_reminders_write_boundary.sql
--
-- `trip_reminders_own` stops being a FOR ALL policy with no WITH CHECK, which
-- is what currently makes 2534's repair of `trip_reminders_insert` decorative.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2535.
-- Policy-only: no table, no column, no grant, no row. Idempotent (DROP POLICY
-- IF EXISTS then CREATE).
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE DEFECT, MEASURED ON PRODUCTION 2026-09-07
-- ══════════════════════════════════════════════════════════════════════════════
-- Two PERMISSIVE policies sit on public.trip_reminders:
--
--   trip_reminders_insert  INSERT  WITH CHECK ((user_id = auth.uid())
--                                              AND can_see_trip(trip_id))
--   trip_reminders_own     ALL     USING (user_id = auth.uid())
--                                  with_check = NULL
--
-- A FOR ALL policy with no WITH CHECK reuses its USING expression as the write
-- check, so `trip_reminders_own` offers `user_id = auth.uid()` on INSERT. Both
-- policies are PERMISSIVE, and PERMISSIVE policies are **OR-ed**. So an INSERT
-- that satisfies only `user_id = auth.uid()` is admitted through
-- `trip_reminders_own`, and the `can_see_trip(trip_id)` half of the careful
-- policy is never required of anybody.
--
-- 2534 repoints `trip_reminders_insert` at the repaired `can_see_trip` and says
-- plainly in its own header that this domination "makes the crew gate on
-- trip_reminders_insert decorative". It reported the problem rather than fixing
-- it. This migration is that fix; without it, 2534's work on this table has no
-- effect at all.
--
-- ── SEVERITY, STATED HONESTLY RATHER THAN INFLATED ───────────────────────────
-- This is a WRITE-BOUNDARY defect, not a disclosure. Measured:
--
--   * An authenticated user can INSERT a reminder row naming ANY trip_id,
--     including a trip they cannot see.
--   * They CANNOT read anyone else's rows back: every SELECT path is still
--     `user_id = auth.uid()`.
--   * `lib/tripReminderScheduler.ts` does NOT read this table. It drives trip
--     reminders from `trips` directly, so a planted row is not consumed and
--     cannot become a push notification. There is no leak path today.
--   * public.trip_reminders holds 0 rows in production.
--
-- So: a real integrity defect with no current consumer, cheap to close, and it
-- unblocks the repair 2534 already landed. It is not an open door, and calling
-- it one would be wrong.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE SHAPE, AND WHY NOT SIMPLY "ADD A WITH CHECK"
-- ══════════════════════════════════════════════════════════════════════════════
-- Adding `WITH CHECK ((user_id = auth.uid()) AND can_see_trip(trip_id))` to
-- `trip_reminders_own` would work, but it would state the same predicate twice
-- on the same table, in two policies that must then be kept in step by hand.
-- Instead the FOR ALL policy is split so that each command is governed once:
--
--   INSERT  -> trip_reminders_insert  (already correct; left exactly as it is,
--                                      so applying this migration before or
--                                      after 2534 gives the same result)
--   SELECT  -> trip_reminders_select  USING (user_id = auth.uid())
--   UPDATE  -> trip_reminders_update  USING + WITH CHECK. The WITH CHECK is the
--              point: without it an UPDATE could move an existing row onto a
--              trip_id the writer cannot see, re-opening the same hole through
--              a different verb.
--   DELETE  -> trip_reminders_delete  USING (user_id = auth.uid())
--
-- Ownership is unchanged in every direction: a user still reads, edits and
-- deletes exactly their own reminders. What changes is that creating or
-- retargeting one now requires being able to see the trip.
--
-- The API is unaffected: routes/trips-expansion.ts:2671-2736 reaches this table
-- on the service client, which is BYPASSRLS.
--
-- ROLLBACK: db/rollback/2026-09-07-2535-trip-reminders-write-boundary-rollback.sql
-- ══════════════════════════════════════════════════════════════════════════════

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = 'trip_reminders'
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.trip_reminders is absent -- apply 0079_trip_sub_tables.sql first.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'trip_reminders'
       AND policyname = 'trip_reminders_insert'
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: policy trip_reminders_insert is absent. This migration deliberately does NOT recreate it (0079 creates it, 2534 repoints it); without it, splitting trip_reminders_own would leave INSERT ungoverned.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'can_see_trip'
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.can_see_trip(uuid) is absent; trip_reminders_insert and the new UPDATE check both call it.';
  END IF;
END $$;

DROP POLICY IF EXISTS "trip_reminders_own"    ON public.trip_reminders;
DROP POLICY IF EXISTS "trip_reminders_select" ON public.trip_reminders;
DROP POLICY IF EXISTS "trip_reminders_update" ON public.trip_reminders;
DROP POLICY IF EXISTS "trip_reminders_delete" ON public.trip_reminders;

CREATE POLICY "trip_reminders_select" ON public.trip_reminders
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "trip_reminders_update" ON public.trip_reminders
  FOR UPDATE TO authenticated
  USING      (user_id = auth.uid())
  WITH CHECK ((user_id = auth.uid()) AND can_see_trip(trip_id));

CREATE POLICY "trip_reminders_delete" ON public.trip_reminders
  FOR DELETE TO authenticated
  USING (user_id = auth.uid());

-- ═══════════════════════════════════════════════════════════════════════════
-- POSTCONDITIONS
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_count    int;
  v_offender text;
BEGIN
  -- VACUITY GUARD. If this ever examines zero policies, the checks below would
  -- all pass having verified nothing.
  SELECT count(*) INTO v_count
    FROM pg_policies WHERE schemaname = 'public' AND tablename = 'trip_reminders';

  IF v_count < 4 THEN
    RAISE EXCEPTION
      '2535 postcondition VACUOUS: only % policies on trip_reminders; expected 4 (insert, select, update, delete).',
      v_count;
  END IF;

  -- 1. No FOR ALL policy survives on this table. This is the actual defect:
  --    a FOR ALL with no WITH CHECK reuses USING as the write check, and being
  --    PERMISSIVE it ORs over -- and therefore dominates -- the careful one.
  SELECT string_agg(policyname, ', ') INTO v_offender
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'trip_reminders' AND cmd = 'ALL';

  IF v_offender IS NOT NULL THEN
    RAISE EXCEPTION
      '2535 postcondition FAILED: FOR ALL policy still present on trip_reminders: %', v_offender;
  END IF;

  -- 2. Every write-capable policy states a WITH CHECK explicitly. A NULL
  --    with_check on INSERT/UPDATE/ALL is the silent reuse this file exists to
  --    remove, so it must never be reintroduced by any later migration.
  SELECT string_agg(policyname || ' (' || cmd || ')', ', ') INTO v_offender
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'trip_reminders'
     AND cmd IN ('INSERT','UPDATE','ALL') AND with_check IS NULL;

  IF v_offender IS NOT NULL THEN
    RAISE EXCEPTION
      '2535 postcondition FAILED: write policy with no explicit WITH CHECK on trip_reminders: %', v_offender;
  END IF;

  -- 3. The trip gate is actually required on both write verbs. Without this the
  --    file could "pass" while granting user_id = auth.uid() and nothing else.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'trip_reminders'
       AND policyname = 'trip_reminders_update' AND with_check LIKE '%can_see_trip%'
  ) THEN
    RAISE EXCEPTION
      '2535 postcondition FAILED: trip_reminders_update does not require can_see_trip, so a row could still be retargeted onto an unseeable trip.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'trip_reminders'
       AND policyname = 'trip_reminders_insert' AND with_check LIKE '%can_see_trip%'
  ) THEN
    RAISE EXCEPTION
      '2535 postcondition FAILED: trip_reminders_insert no longer requires can_see_trip; the domination this migration removes has been replaced by a weaker insert policy.';
  END IF;

  RAISE NOTICE '2535 OK: % policies on trip_reminders, no FOR ALL, every write policy states WITH CHECK, can_see_trip required on INSERT and UPDATE.', v_count;
END $$;

COMMIT;
