-- Rollback for 3783_input_outcome_task_aggregate.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3783 DID: created input_outcome_task_daily (aggregate counts, no
-- identifying column) and input_record_task_outcome(text, text, boolean).
-- WHAT THIS ROLLBACK DOES: drops both, and deletes 3783's ledger row so the
-- applier can re-apply it. The counts are aggregates of no one; they are
-- discarded with the table. ORDER MATTERS: revert the ingest code that calls
-- input_record_task_outcome first, or consented outcome events are refused.

BEGIN;

DROP FUNCTION IF EXISTS public.input_record_task_outcome(text, text, boolean);
DROP TABLE IF EXISTS public.input_outcome_task_daily;
DELETE FROM public.schema_migration_ledger WHERE filename = '3783_input_outcome_task_aggregate.sql';

COMMIT;

DO $post$
BEGIN
  IF to_regclass('public.input_outcome_task_daily') IS NOT NULL
     OR to_regprocedure('public.input_record_task_outcome(text, text, boolean)') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3783 rollback): an object is still present.';
  END IF;
END $post$;
