-- Rollback for 3784_layover_ranking_mode_flag.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3784 DID: inserted the ranking rollout-mode row below, enabled FALSE,
-- metadata.mode 'legacy'.
-- WHAT THIS ROLLBACK DOES: deletes it ONLY while it is still FALSE — a TRUE row
-- means the owner put the ranking into shadow or on since 3784 was applied, and
-- deleting it would silently put every traveller back on legacy. It raises
-- instead. Then it deletes 3784's schema_migration_ledger row so the applier
-- re-applies it.
--
-- WHAT IT DOES NOT TOUCH: nothing else exists to touch; 3784 created no object.
-- With the row gone the resolver answers legacy (flag_absent), which is what
-- the seed answered (flag_disabled): no traveller-visible change either way.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'layover_ranking_mode' AND enabled = TRUE) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3784): layover_ranking_mode is TRUE. Turn it off deliberately first, then re-run this file.';
  END IF;
END $$;

DELETE FROM public.feature_flags WHERE flag = 'layover_ranking_mode' AND enabled = FALSE;
DELETE FROM public.schema_migration_ledger WHERE filename = '3784_layover_ranking_mode_flag.sql';

COMMIT;

DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'layover_ranking_mode') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3784 rollback): the flag is still present.';
  END IF;
END $post$;
