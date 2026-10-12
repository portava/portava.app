-- Rollback for artifacts/api-server/src/migrations/3770_trip_hard_delete_thread_guard.sql
-- OD-1012-DEL-1 — a trip that still has its conversation is refused a hard delete
-- with a typed PT409 before anything cascades.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THIS DESTROYS
-- ══════════════════════════════════════════════════════════════════════════════
-- Nothing stored. 3770 adds one trigger and its function, and no table, column
-- or row. Dropping them returns the hard delete of such a trip to the pre-3770
-- failure: the same statement is still refused, by the SET NULL foreign key
-- against chk_thread_context, as a raw 23514 on message_threads.

BEGIN;

DROP TRIGGER IF EXISTS trips_refuse_delete_with_thread ON public.trips;
DROP FUNCTION IF EXISTS public.trips_refuse_delete_with_thread();

DO $post$
BEGIN
  IF to_regprocedure('public.trips_refuse_delete_with_thread()') IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3770): trips_refuse_delete_with_thread() still exists';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trips_refuse_delete_with_thread' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3770): trigger trips_refuse_delete_with_thread still exists';
  END IF;
END
$post$;

COMMIT;
