-- Rollback for 3900_layover_presence.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3900 DID: created public.layover_presence (service-role only, no
-- coordinate) and seeded `layover_presence_intents_enabled` FALSE.
-- WHAT THIS ROLLBACK DOES: refuses while the flag is TRUE (turning a live
-- capability off by deleting its row would be silent); otherwise drops the
-- table, deletes the flag row and 3900's schema_migration_ledger row.
-- DATA LOSS, stated: every presence record is dropped. They are short-lived
-- by design (expires_at <= the session's departure) and carry no history a
-- traveller would lose beyond their current intents.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'layover_presence_intents_enabled' AND enabled = TRUE) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3900): layover_presence_intents_enabled is TRUE. Turn it off deliberately first, then re-run this file.';
  END IF;
END $$;

DROP TABLE IF EXISTS public.layover_presence;
DELETE FROM public.feature_flags WHERE flag = 'layover_presence_intents_enabled' AND enabled = FALSE;
DELETE FROM public.schema_migration_ledger WHERE filename = '3900_layover_presence.sql';

COMMIT;

DO $post$
BEGIN
  IF to_regclass('public.layover_presence') IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3900): layover_presence still exists';
  END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'layover_presence_intents_enabled') THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3900): layover_presence_intents_enabled still present';
  END IF;
END $post$;
