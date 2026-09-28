-- Rollback for 3485_discovery_trail_exploration_flags.sql (census-discovery §86, lane W10-T).
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) or travel-buddy (ajrurzioarfkagpuxfnb).
--
-- Deletes the two flag rows, and ONLY while both are still FALSE: if either reads
-- TRUE the owner has turned it on, and deleting the row would silently turn it off
-- (an absent row reads false). It raises instead. Deletes 3485's ledger row.
-- Rows the flag-on path wrote (content_trails states, trail_member_exposures) are
-- not touched: they are §7 states and counts, and removing them is not a rollback
-- of this file.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags
              WHERE flag IN ('discovery_trail_exploration_enabled', 'discovery_trail_health_order_enabled') AND enabled) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3485): a Trail ranking flag is TRUE. Turn it off deliberately first, then re-run this file.';
  END IF;
END $$;

DELETE FROM public.feature_flags
 WHERE flag IN ('discovery_trail_exploration_enabled', 'discovery_trail_health_order_enabled') AND enabled = FALSE;

DELETE FROM public.schema_migration_ledger WHERE filename = '3485_discovery_trail_exploration_flags.sql';

COMMIT;

DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag IN ('discovery_trail_exploration_enabled', 'discovery_trail_health_order_enabled')) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3485 rollback): a flag row is still present.';
  END IF;
END $post$;
