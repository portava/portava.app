-- Rollback for 2789_trip_activity_log_retention.sql
--
-- Removes the retention policy from trip_activity_log: the prune function,
-- the two CHECKs, the index and the column. The rows themselves are untouched
-- — a rollback of a policy is not a deletion of evidence. Rehearsed on the
-- local replica: apply 2789 → this file → 2789 again.

DO $pre$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'trip_activity_log' AND column_name = 'retain_until') THEN
    RAISE EXCEPTION '2789 rollback: trip_activity_log.retain_until is not present — 2789 is not applied';
  END IF;
END
$pre$;

DROP FUNCTION IF EXISTS public.trip_activity_log_prune();
DROP INDEX IF EXISTS public.idx_trip_activity_log_retain;
ALTER TABLE public.trip_activity_log DROP CONSTRAINT IF EXISTS trip_activity_log_metadata_minimised;
ALTER TABLE public.trip_activity_log DROP CONSTRAINT IF EXISTS trip_activity_log_retention_after_create;
ALTER TABLE public.trip_activity_log DROP COLUMN retain_until;

DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'trip_activity_log' AND column_name = 'retain_until') THEN
    RAISE EXCEPTION '2789 rollback: retain_until survived';
  END IF;
  IF to_regprocedure('public.trip_activity_log_prune()') IS NOT NULL THEN
    RAISE EXCEPTION '2789 rollback: trip_activity_log_prune() survived';
  END IF;
END
$post$;
