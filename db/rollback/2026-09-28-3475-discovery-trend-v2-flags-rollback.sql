-- Rollback for 3475_discovery_trend_v2_flags.sql (census-discovery §84, lane W10-R1)
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3475 DID: inserted five feature_flags rows, all FALSE, ON CONFLICT DO
-- NOTHING. No table, column, type or function.
--
-- WHAT THIS DOES: deletes those rows ONLY while every one is still FALSE. A row
-- that reads TRUE is an owner decision made since 3475; deleting it would
-- silently turn it off (an absent row reads false) with no record that the
-- decision was reversed, so the file refuses instead. Then deletes 3475's
-- schema_migration_ledger row. Deletes no place_momentum or area_momentum row:
-- whether stored snapshots are kept is a retention decision, not a rollback.

BEGIN;

DO $$
DECLARE on_count int;
BEGIN
  SELECT count(*) INTO on_count FROM public.feature_flags
    WHERE flag IN ('discovery_trend_normalised_enabled', 'discovery_trend_rebuild_scheduler_enabled',
                   'discovery_trend_snapshot_retention_enabled', 'discovery_trend_lists_enabled',
                   'discovery_trend_rediscovery_retest_enabled')
      AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3475): a trending flag is TRUE. Turn it off deliberately first, then re-run this file.';
  END IF;
END $$;

DELETE FROM public.feature_flags
  WHERE flag IN ('discovery_trend_normalised_enabled', 'discovery_trend_rebuild_scheduler_enabled',
                 'discovery_trend_snapshot_retention_enabled', 'discovery_trend_lists_enabled',
                 'discovery_trend_rediscovery_retest_enabled')
    AND enabled = FALSE;

DELETE FROM public.schema_migration_ledger WHERE filename = '3475_discovery_trend_v2_flags.sql';

COMMIT;

DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags
              WHERE flag IN ('discovery_trend_normalised_enabled', 'discovery_trend_rebuild_scheduler_enabled',
                             'discovery_trend_snapshot_retention_enabled', 'discovery_trend_lists_enabled',
                             'discovery_trend_rediscovery_retest_enabled')) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3475 rollback): a trending flag row remains.';
  END IF;
END $post$;
