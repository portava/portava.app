-- Rollback for 3484_compass_city_confidence_provenance.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3484 DID
-- =============
-- Added three nullable columns to public.compass_city_confidence (model_version,
-- feature_version, source_window) and seeded compass_city_confidence_windowed_reads_enabled
-- FALSE.
--
-- WHAT THIS ROLLBACK DOES
-- =======================
-- Refuses while the flag is TRUE: the producer would then upsert the dropped
-- columns and every city would fail to score (42703). Otherwise it deletes the
-- flag row, drops the three columns, and deletes 3484's ledger row. No row of
-- compass_city_confidence is deleted; what it gives up is the recorded
-- provenance (census-discovery DC-17: the reading returns to 1 of 4 facts, and
-- src/test/compassCityConfidenceWindow.test.ts W3 describes a database that no
-- longer exists). The next daily rebuild rewrites every row without them.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags
              WHERE flag = 'compass_city_confidence_windowed_reads_enabled' AND enabled = TRUE) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3484): compass_city_confidence_windowed_reads_enabled is TRUE; the producer writes the columns this would drop. Turn it off first.';
  END IF;
END $$;

DELETE FROM public.feature_flags WHERE flag = 'compass_city_confidence_windowed_reads_enabled' AND enabled = FALSE;

ALTER TABLE public.compass_city_confidence DROP COLUMN IF EXISTS source_window;
ALTER TABLE public.compass_city_confidence DROP COLUMN IF EXISTS feature_version;
ALTER TABLE public.compass_city_confidence DROP COLUMN IF EXISTS model_version;

DELETE FROM public.schema_migration_ledger WHERE filename = '3484_compass_city_confidence_provenance.sql';

COMMIT;

DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'compass_city_confidence'
                AND column_name IN ('model_version', 'feature_version', 'source_window')) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3484 rollback): a provenance column is still present.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'compass_city_confidence_windowed_reads_enabled') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3484 rollback): the flag row is still present.';
  END IF;
END $post$;
