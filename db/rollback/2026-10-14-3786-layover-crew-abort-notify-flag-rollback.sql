-- Rollback for 3786_layover_crew_abort_notify_flag.sql
-- NOT applied to any database at the time of writing.
-- Deletes the flag row ONLY while it is FALSE (a TRUE row means the owner turned
-- crew abort notices on; deleting it would silently turn them off — this raises
-- instead), then deletes 3786's schema_migration_ledger row so the applier
-- re-applies it. Notices already written to crewmates are NOT removed: they are
-- ordinary `notifications` rows (source_type 'layover_crew_abort') owned by
-- their recipients and expire with that table's own rules.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'layover_crew_abort_notify_enabled' AND enabled = TRUE) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3786): layover_crew_abort_notify_enabled is TRUE. Turn it off deliberately first, then re-run this file.';
  END IF;
END $$;

DELETE FROM public.feature_flags WHERE flag = 'layover_crew_abort_notify_enabled' AND enabled = FALSE;
DELETE FROM public.schema_migration_ledger WHERE filename = '3786_layover_crew_abort_notify_flag.sql';

COMMIT;
