-- Rollback for 3692_input_trip_actions_flag.sql
-- NOT applied anywhere at the time of writing.
--
-- WHAT 3692 DID: seeded input_trip_actions_enabled FALSE. Nothing else.
-- WHAT THIS ROLLBACK DOES: removes the row ONLY while it is FALSE, and deletes
-- 3692's ledger row so the applier can re-apply it.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'input_trip_actions_enabled' AND enabled = TRUE) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3692): input_trip_actions_enabled is TRUE. Turn it off deliberately first.';
  END IF;
END $$;

DELETE FROM public.feature_flags WHERE flag = 'input_trip_actions_enabled' AND enabled = FALSE;
DELETE FROM public.schema_migration_ledger WHERE filename = '3692_input_trip_actions_flag.sql';

COMMIT;
