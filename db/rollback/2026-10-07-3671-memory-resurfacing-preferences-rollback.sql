-- Rollback for 3671_memory_resurfacing_preferences.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3671 DID: created public.memory_resurfacing_preferences and its owner index —
-- the per-Memory §11 controls (a row is the control ON).
-- WHAT THIS ROLLBACK DOES: drops it — ONLY while it is empty. A row is a person's
-- recorded choice (for example "keep this Memory private forever"); dropping it
-- silently would discard a decision someone made, so the rollback RAISES instead.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.memory_resurfacing_preferences') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.memory_resurfacing_preferences) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3671): memory_resurfacing_preferences holds recorded choices. Decide what happens to them first.';
  END IF;
END $$;

DROP TABLE IF EXISTS public.memory_resurfacing_preferences;
DELETE FROM public.schema_migration_ledger WHERE filename = '3671_memory_resurfacing_preferences.sql';

COMMIT;

DO $post$
BEGIN
  IF to_regclass('public.memory_resurfacing_preferences') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3671 rollback): memory_resurfacing_preferences still exists';
  END IF;
END $post$;
