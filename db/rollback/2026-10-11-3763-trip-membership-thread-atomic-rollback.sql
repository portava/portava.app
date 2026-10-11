-- Rollback for artifacts/api-server/src/migrations/3763_trip_membership_thread_atomic.sql
-- census-telegraph T319 — a trip membership that ends takes its trip-thread
-- membership with it, in the same transaction.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THIS DESTROYS
-- ══════════════════════════════════════════════════════════════════════════════
-- Nothing stored. 3763 adds one trigger and its function, and no table, column
-- or row. Dropping them returns every trip-membership write to the pre-3763
-- behaviour: the membership changes now, and the removed member's thread row is
-- ended only when the fire-and-forget syncTripChatMembers runs — i.e. the defect
-- 3763 closes comes back.
--
-- Rows the trigger already wrote stay as written: a `left_at` it set is the
-- value a successful sync would have set.

BEGIN;

DROP TRIGGER IF EXISTS trip_members_end_thread_membership ON public.trip_members;
DROP FUNCTION IF EXISTS public.trip_members_end_thread_membership();

DO $post$
BEGIN
  IF to_regprocedure('public.trip_members_end_thread_membership()') IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3763): trip_members_end_thread_membership() still exists';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trip_members_end_thread_membership' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3763): trigger trip_members_end_thread_membership still exists';
  END IF;
END
$post$;

COMMIT;
