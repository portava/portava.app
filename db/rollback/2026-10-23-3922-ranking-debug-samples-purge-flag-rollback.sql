-- Rollback for 3922_ranking_debug_samples_purge_flag.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3922 DID: inserted ranking_debug_samples_purge_enabled, FALSE.
-- WHAT THIS ROLLBACK DOES: deletes it ONLY while it is still FALSE — a TRUE row
-- means the owner ruled a retention and turned the purge on; deleting it would
-- silently stop the purge. It raises instead. Then it deletes 3922's
-- schema_migration_ledger row so the applier re-applies it. The scheduler reads
-- an absent row as OFF and deletes nothing, so nothing breaks.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'ranking_debug_samples_purge_enabled' AND enabled = TRUE) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3922): ranking_debug_samples_purge_enabled is TRUE. Turn it off deliberately first, then re-run this file.';
  END IF;
END $$;

DELETE FROM public.feature_flags WHERE flag = 'ranking_debug_samples_purge_enabled' AND enabled = FALSE;
DELETE FROM public.schema_migration_ledger WHERE filename = '3922_ranking_debug_samples_purge_flag.sql';

COMMIT;

DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'ranking_debug_samples_purge_enabled') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3922 rollback): the flag is still present.';
  END IF;
END $post$;
