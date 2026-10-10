-- Rollback for 3622_layover_post_session_pseudonymisation.sql (lane R, PR-R-L163a).
--
-- Removes the dead-letter table, the named-events index and the flag row. It
-- does NOT un-pseudonymise anything: a row the pass pseudonymised has no user
-- and no session any more, and nothing can — or should — restore them. Those
-- rows stay under 3621's CHECK and the retention sweep deletes them at
-- retain_until, as it does any other pseudonymised row.
--
-- Turning the flag OFF stops the pass without losing the dead letters, and is
-- usually what is wanted instead of this file.

BEGIN;

DROP TABLE IF EXISTS public.layover_event_pseudonymisation_dead_letters;
DROP INDEX IF EXISTS public.layover_events_named_session_idx;
DELETE FROM public.feature_flags WHERE flag = 'layover_events_post_session_pseudonymisation_enabled';
DELETE FROM public.schema_migration_ledger WHERE filename = '3622_layover_post_session_pseudonymisation.sql';

DO $post$
BEGIN
  IF to_regclass('public.layover_event_pseudonymisation_dead_letters') IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3622): the dead-letter table remains';
  END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'layover_events_post_session_pseudonymisation_enabled') THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3622): the flag row remains';
  END IF;
END $post$;

COMMIT;
