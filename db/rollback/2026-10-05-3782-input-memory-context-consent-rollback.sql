-- Rollback for 3782_input_memory_context_consent.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3782 DID: created input_memory_context_consent and seeded
-- input_memory_context_enabled FALSE.
-- WHAT THIS ROLLBACK DOES: removes both — ONLY while the flag is FALSE and no
-- one has opted in (a consent row is a person's recorded choice; it is not
-- silently discarded). The person's memories are untouched either way: 3782
-- never stored any. Deletes 3782's ledger row so the applier can re-apply it.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'input_memory_context_enabled' AND enabled = TRUE) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3782): input_memory_context_enabled is TRUE. Turn it off deliberately first.';
  END IF;
  IF to_regclass('public.input_memory_context_consent') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.input_memory_context_consent) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3782): input_memory_context_consent holds recorded choices. Decide what happens to them first.';
  END IF;
END $$;

DROP TABLE IF EXISTS public.input_memory_context_consent;
DELETE FROM public.feature_flags WHERE flag = 'input_memory_context_enabled' AND enabled = FALSE;
DELETE FROM public.schema_migration_ledger WHERE filename = '3782_input_memory_context_consent.sql';

COMMIT;

DO $post$
BEGIN
  IF to_regclass('public.input_memory_context_consent') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3782 rollback): input_memory_context_consent is still present.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'input_memory_context_enabled') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3782 rollback): the flag is still present.';
  END IF;
END $post$;
