-- Rollback for 3651_nearby_proximity_observation_budget.sql (lane T, census-telegraph T26).
--
-- Drops public.nearby_proximity_observations. The rows are short-lived budget
-- records (no history, no coordinate), so nothing of value is lost. AFTER this,
-- GET /nearby/reachable refuses with 503 whenever nearby_reachable_enabled is ON,
-- because the budget it must record cannot be read — turn the flag off first if
-- Nearby is in use.

BEGIN;

DROP TABLE IF EXISTS public.nearby_proximity_observations;

DO $$
BEGIN
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL THEN
    DELETE FROM public.schema_migration_ledger WHERE filename = '3651_nearby_proximity_observation_budget.sql';
  END IF;
END $$;

COMMIT;
