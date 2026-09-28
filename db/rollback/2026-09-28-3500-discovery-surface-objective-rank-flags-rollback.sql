-- Rollback for 3500_discovery_surface_objective_rank_flags.sql (census-discovery §93, lane W11-X1).
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) or travel-buddy (ajrurzioarfkagpuxfnb).
--
-- Deletes the three flag rows, and ONLY while all three are still FALSE: if one
-- reads TRUE the owner has turned it on, and deleting the row would silently turn
-- it off (an absent row reads false). It raises instead. Deletes 3500's ledger row.
-- Nothing else was written by these flags: each only reorders a response.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags
              WHERE flag IN ('discovery_trail_objective_rank_enabled', 'discovery_trending_objective_rank_enabled', 'discovery_trip_planning_objective_rank_enabled') AND enabled) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3500): a surface objective flag is TRUE. Turn it off deliberately first, then re-run this file.';
  END IF;
END $$;

DELETE FROM public.feature_flags
 WHERE flag IN ('discovery_trail_objective_rank_enabled', 'discovery_trending_objective_rank_enabled', 'discovery_trip_planning_objective_rank_enabled') AND enabled = FALSE;

DELETE FROM public.schema_migration_ledger WHERE filename = '3500_discovery_surface_objective_rank_flags.sql';

COMMIT;

DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag IN ('discovery_trail_objective_rank_enabled', 'discovery_trending_objective_rank_enabled', 'discovery_trip_planning_objective_rank_enabled')) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3500 rollback): a flag row is still present.';
  END IF;
END $post$;
