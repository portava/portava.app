-- Rollback for 3487_trail_member_exposures.sql (census-discovery §86, lane W10-T).
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) or travel-buddy (ajrurzioarfkagpuxfnb).
--
-- REFUSES while discovery_trail_exploration_enabled is TRUE (the flag-on path
-- would silently reserve nothing on every read without its counter).
-- Drops the counter function and table: counts only, no personal data (§86), so
-- dropping them loses no record about anyone. Deletes 3487's ledger row.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'discovery_trail_exploration_enabled' AND enabled) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3487): discovery_trail_exploration_enabled is TRUE. Turn it off first.';
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.trail_record_member_exposures(uuid, jsonb, timestamptz);
DROP TABLE IF EXISTS public.trail_member_exposures;
DELETE FROM public.schema_migration_ledger WHERE filename = '3487_trail_member_exposures.sql';

COMMIT;

DO $post$
BEGIN
  IF to_regclass('public.trail_member_exposures') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3487 rollback): the table survived.';
  END IF;
END $post$;
