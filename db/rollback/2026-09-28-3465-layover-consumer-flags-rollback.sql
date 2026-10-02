-- Rollback for 3465_layover_consumer_flags.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3465 DID: inserted the capability flag row(s) below, FALSE.
-- WHAT THIS ROLLBACK DOES: deletes them ONLY while every one is still FALSE —
-- a TRUE row means the owner turned the capability on since 3465 was applied,
-- and deleting it would silently turn it off. It raises instead. Then it
-- deletes 3465's schema_migration_ledger row so the applier re-applies it.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag IN ('layover_snapshot_consumers_enabled', 'layover_place_dwell_enabled') AND enabled = TRUE) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3465): a flag seeded by 3465 is TRUE. Turn it off deliberately first, then re-run this file.';
  END IF;
END $$;

DELETE FROM public.feature_flags WHERE flag IN ('layover_snapshot_consumers_enabled', 'layover_place_dwell_enabled') AND enabled = FALSE;
DELETE FROM public.schema_migration_ledger WHERE filename = '3465_layover_consumer_flags.sql';

COMMIT;

DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag IN ('layover_snapshot_consumers_enabled', 'layover_place_dwell_enabled')) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3465 rollback): a flag is still present.';
  END IF;
END $post$;
