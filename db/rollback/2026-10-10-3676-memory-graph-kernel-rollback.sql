-- Rollback for 3676_memory_graph_kernel.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3676 DID: created public.memory_graph_kernel_execute(jsonb), the
-- MERGE_MEMORY / SPLIT_MEMORY kernel. It holds no data.
-- WHAT THIS ROLLBACK DOES: drops the function. Merges and splits already made
-- stay made: their redirects (3674's memory_id_redirects), events, receipts and
-- audit rows are untouched, so a merged id keeps resolving. With the function
-- gone the routes answer kernel_unavailable (503), never a direct write.

BEGIN;

DROP FUNCTION IF EXISTS public.memory_graph_kernel_execute(jsonb);
DELETE FROM public.schema_migration_ledger WHERE filename = '3676_memory_graph_kernel.sql';

COMMIT;

DO $post$
BEGIN
  IF to_regprocedure('public.memory_graph_kernel_execute(jsonb)') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3676 rollback): memory_graph_kernel_execute still exists';
  END IF;
END $post$;
