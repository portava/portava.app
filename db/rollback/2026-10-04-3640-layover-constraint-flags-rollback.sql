-- Rollback for 3640_layover_constraint_flags.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3640 DID: inserted the capability flag row(s) below, FALSE.
-- WHAT THIS ROLLBACK DOES: deletes them ONLY while every one is still FALSE —
-- a TRUE row means the owner turned the capability on since 3640 was applied,
-- and deleting it would silently turn it off. It raises instead. Then it
-- deletes 3640's schema_migration_ledger row so the applier re-applies it.
--
-- WHAT IT DOES NOT TOUCH: `layover_constraints` and every row in it (2992 owns
-- that table). Rows declared while the flag was ON stay where they are and are
-- simply not read again.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag IN ('layover_constraints_enabled', 'layover_entry_forbid_landside_enabled') AND enabled = TRUE) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3640): a flag seeded by 3640 is TRUE. Turn it off deliberately first, then re-run this file.';
  END IF;
END $$;

DELETE FROM public.feature_flags WHERE flag IN ('layover_constraints_enabled', 'layover_entry_forbid_landside_enabled') AND enabled = FALSE;
DELETE FROM public.schema_migration_ledger WHERE filename = '3640_layover_constraint_flags.sql';

COMMIT;

DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag IN ('layover_constraints_enabled', 'layover_entry_forbid_landside_enabled')) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3640 rollback): a flag is still present.';
  END IF;
END $post$;
