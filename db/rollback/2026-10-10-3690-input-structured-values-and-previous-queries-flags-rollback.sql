-- Rollback for 3690_input_structured_values_and_previous_queries_flags.sql
-- NOT applied anywhere at the time of writing.
--
-- WHAT 3690 DID: seeded input_structured_values_enabled and
-- input_previous_queries_enabled, both FALSE. It stored nothing else.
-- WHAT THIS ROLLBACK DOES: removes both rows — ONLY while each is FALSE (a flag
-- someone turned on is turned off deliberately first). Deletes 3690's ledger row
-- so the applier can re-apply it.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags
             WHERE flag IN ('input_structured_values_enabled', 'input_previous_queries_enabled') AND enabled = TRUE) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3690): a 3690 flag is TRUE. Turn it off deliberately first.';
  END IF;
END $$;

DELETE FROM public.feature_flags
 WHERE flag IN ('input_structured_values_enabled', 'input_previous_queries_enabled') AND enabled = FALSE;
DELETE FROM public.schema_migration_ledger WHERE filename = '3690_input_structured_values_and_previous_queries_flags.sql';

COMMIT;
