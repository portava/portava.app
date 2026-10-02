-- Rollback for 3476_discovery_trend_v2_store.sql (census-discovery §84, lane W10-R1)
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3476 DID: thirteen nullable columns on place_momentum, the area_momentum
-- table, and discovery_trend_place_context().
--
-- WHAT THIS DOES: refuses while 3477's v2 rebuild still exists (roll 3477 back
-- first: it writes these columns), then drops the function, the table and the
-- columns. Dropping them DELETES the v2 evidence stored in them; v1's columns
-- and rows are untouched. Whether stored snapshots may be discarded is a
-- retention question: run this only where no v2 run needs to be kept.

BEGIN;

DO $pre$
BEGIN
  IF to_regprocedure('public.rebuild_place_momentum_v2(timestamptz)') IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3476): 3477''s rebuild_place_momentum_v2 still exists and writes these columns. Roll 3477 back first.';
  END IF;
END
$pre$;

DROP FUNCTION IF EXISTS public.discovery_trend_place_context();
DROP TABLE IF EXISTS public.area_momentum;
ALTER TABLE public.place_momentum
  DROP COLUMN IF EXISTS recent_exposures,
  DROP COLUMN IF EXISTS mid_exposures,
  DROP COLUMN IF EXISTS prior_exposures,
  DROP COLUMN IF EXISTS recent_groups,
  DROP COLUMN IF EXISTS mid_groups,
  DROP COLUMN IF EXISTS prior_groups,
  DROP COLUMN IF EXISTS velocity,
  DROP COLUMN IF EXISTS time_of_day_factor,
  DROP COLUMN IF EXISTS peer_factor,
  DROP COLUMN IF EXISTS lifecycle_state,
  DROP COLUMN IF EXISTS driver,
  DROP COLUMN IF EXISTS cell_key,
  DROP COLUMN IF EXISTS city;

DELETE FROM public.schema_migration_ledger WHERE filename = '3476_discovery_trend_v2_store.sql';

COMMIT;

DO $post$
BEGIN
  IF to_regclass('public.area_momentum') IS NOT NULL
     OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'place_momentum'
                   AND column_name IN ('recent_exposures','lifecycle_state','driver','cell_key')) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3476 rollback): a v2 store object remains.';
  END IF;
END
$post$;
