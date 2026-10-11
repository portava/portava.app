-- Rollback for 3624_layover_snapshot_compaction_flag.sql
-- NOT applied to any database at the time of writing.
-- Deletes the flag row ONLY while it is FALSE (a TRUE row means the owner turned
-- compaction on; deleting it would silently turn it off — this raises instead),
-- then deletes 3624's schema_migration_ledger row so the applier re-applies it.
-- Rows already compacted are NOT restored (deletion is the flag's purpose).

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'layover_snapshot_compaction_enabled' AND enabled = TRUE) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3624): layover_snapshot_compaction_enabled is TRUE. Turn it off deliberately first, then re-run this file.';
  END IF;
END $$;

DELETE FROM public.feature_flags WHERE flag = 'layover_snapshot_compaction_enabled' AND enabled = FALSE;
DELETE FROM public.schema_migration_ledger WHERE filename = '3624_layover_snapshot_compaction_flag.sql';

COMMIT;
