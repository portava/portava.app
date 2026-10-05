-- Rollback for 3780_input_outcome_learning.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3780 DID: created input_outcome_consent, input_outcome_counters and
-- input_record_outcome(uuid, text, text, text), and seeded
-- input_outcome_learning_enabled FALSE.
-- WHAT THIS ROLLBACK DOES: removes all four — ONLY while the flag is FALSE and
-- no one has opted in. A TRUE flag means the owner turned the capability on;
-- a consent row is a person's recorded choice. Dropping either silently would
-- discard a decision someone made, so the rollback RAISES instead. With both
-- clear it drops the objects and deletes 3780's ledger row so the applier can
-- re-apply it.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'input_outcome_learning_enabled' AND enabled = TRUE) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3780): input_outcome_learning_enabled is TRUE. Turn it off deliberately first.';
  END IF;
  IF to_regclass('public.input_outcome_consent') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.input_outcome_consent) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3780): input_outcome_consent holds recorded choices. Decide what happens to them first.';
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.input_record_outcome(uuid, text, text, text);
DROP TABLE IF EXISTS public.input_outcome_counters;
DROP TABLE IF EXISTS public.input_outcome_consent;
DELETE FROM public.feature_flags WHERE flag = 'input_outcome_learning_enabled' AND enabled = FALSE;
DELETE FROM public.schema_migration_ledger WHERE filename = '3780_input_outcome_learning.sql';

COMMIT;

DO $post$
BEGIN
  IF to_regclass('public.input_outcome_consent') IS NOT NULL OR to_regclass('public.input_outcome_counters') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3780 rollback): an outcome table is still present.';
  END IF;
  IF to_regprocedure('public.input_record_outcome(uuid, text, text, text)') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3780 rollback): input_record_outcome is still present.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'input_outcome_learning_enabled') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3780 rollback): the flag is still present.';
  END IF;
END $post$;
