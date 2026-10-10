-- Rollback for 3633_layover_map_bands_flag.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3633 DID: inserted the capability flag row below, FALSE.
-- WHAT THIS ROLLBACK DOES: deletes it ONLY while it is still FALSE — a TRUE row
-- means the owner turned the capability on since 3633 was applied, and deleting
-- it would silently turn it off. It raises instead. Then it deletes 3633's
-- schema_migration_ledger row so the applier re-applies it.
--
-- WHAT IT DOES NOT TOUCH: nothing else exists to touch; 3633 created no object.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'layover_map_bands_enabled' AND enabled = TRUE) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3633): layover_map_bands_enabled is TRUE. Turn it off deliberately first, then re-run this file.';
  END IF;
END $$;

DELETE FROM public.feature_flags WHERE flag = 'layover_map_bands_enabled' AND enabled = FALSE;
DELETE FROM public.schema_migration_ledger WHERE filename = '3633_layover_map_bands_flag.sql';

COMMIT;

DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'layover_map_bands_enabled') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3633 rollback): the flag is still present.';
  END IF;
END $post$;
