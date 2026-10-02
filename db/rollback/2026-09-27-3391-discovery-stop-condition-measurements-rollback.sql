-- Rollback for 3391_discovery_stop_condition_measurements.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
-- Rehearsed on the local PostgreSQL 16 harness: apply → rollback → re-apply.
--
-- WHAT 3391 DID
-- =============
--   * CREATE INDEX rank_events_discovery_served_at ON rank_events (served_at)
--     WHERE surface = 'discovery'.
--   * CREATE FUNCTION public.discovery_stop_measurements(timestamptz, timestamptz),
--     SECURITY INVOKER, EXECUTE for service_role only. It writes nothing.
--
-- WHAT THIS ROLLBACK DOES
-- =======================
-- Drops the function and the index, and deletes 3391's ledger row. Nothing is
-- lost: the function stores nothing and the index is derived. The reader
-- (lib/discoveryStopMeasurements.ts) treats a missing function as `unreadable`
-- for the four database-measured conditions, which reports them rather than
-- clearing them, and none of them can trip without an owner ruling anyway.
-- Roll this back BEFORE 3390's rollback if both are rolled back: 3391's
-- precondition names 3390's posture.

BEGIN;

DROP FUNCTION IF EXISTS public.discovery_stop_measurements(timestamptz, timestamptz);
DROP INDEX IF EXISTS public.rank_events_discovery_served_at;

DO $$
BEGIN
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL THEN
    DELETE FROM public.schema_migration_ledger
     WHERE filename = '3391_discovery_stop_condition_measurements.sql';
  END IF;
END $$;

COMMIT;

-- ── Postconditions ──────────────────────────────────────────────────────────
DO $post$
BEGIN
  IF to_regprocedure('public.discovery_stop_measurements(timestamptz, timestamptz)') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3391 rollback): discovery_stop_measurements still exists.';
  END IF;
  IF to_regclass('public.rank_events_discovery_served_at') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3391 rollback): rank_events_discovery_served_at still exists.';
  END IF;
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.schema_migration_ledger
                  WHERE filename = '3391_discovery_stop_condition_measurements.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3391 rollback): the ledger still records 3391 as applied.';
  END IF;
END $post$;
