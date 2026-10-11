-- Rollback for 3677_highlight_lifecycle_events.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3677 DID: created public.highlight_create_execute(jsonb) (CREATE_HIGHLIGHT)
-- and public.highlight_expiry_emit(timestamptz, integer) (highlight.expired), and
-- seeded highlight_expiry_events_enabled FALSE. It holds no data of its own.
-- WHAT THIS ROLLBACK DOES: drops both functions and the flag. Highlights already
-- created through the kernel, and the events, outbox rows, receipts and audit
-- rows they wrote, are untouched (they are ordinary rows of 2710/2993's tables).
-- With the create function gone and memory_kernel_enabled ON, POST /highlights
-- answers kernel_unavailable (503), never a direct write; with the kernel OFF it
-- is the legacy insert, as before 3677. The expiry scheduler reads the absent
-- flag as OFF and does nothing.

BEGIN;

DROP FUNCTION IF EXISTS public.highlight_create_execute(jsonb);
DROP FUNCTION IF EXISTS public.highlight_expiry_emit(timestamptz, integer);
DELETE FROM public.feature_flags WHERE flag = 'highlight_expiry_events_enabled';
DELETE FROM public.schema_migration_ledger WHERE filename = '3677_highlight_lifecycle_events.sql';

COMMIT;

DO $post$
BEGIN
  IF to_regprocedure('public.highlight_create_execute(jsonb)') IS NOT NULL
     OR to_regprocedure('public.highlight_expiry_emit(timestamptz,integer)') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3677 rollback): a 3677 function still exists';
  END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'highlight_expiry_events_enabled') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3677 rollback): highlight_expiry_events_enabled still exists';
  END IF;
END $post$;
