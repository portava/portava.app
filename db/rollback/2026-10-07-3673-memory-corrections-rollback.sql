-- Rollback for 3673_memory_corrections.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3673 DID: created public.memory_corrections, its two indexes and its
-- append-only trigger. These are the owner's statements about a Memory's place.
-- WHAT THIS ROLLBACK DOES: drops it, but ONLY while it is empty. A row is a
-- person's correction, and a rejection is a negative constraint. Dropping one
-- silently would put the owner back at a place they said was wrong, so the
-- rollback RAISES instead. Dropping the table drops its trigger; the shared
-- function public.intel_append_only() (2130) is not touched.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.memory_corrections') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.memory_corrections) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3673): memory_corrections holds owners'' corrections. Decide what happens to them first.';
  END IF;
END $$;

DROP TABLE IF EXISTS public.memory_corrections;
DELETE FROM public.schema_migration_ledger WHERE filename = '3673_memory_corrections.sql';

COMMIT;

DO $post$
BEGIN
  IF to_regclass('public.memory_corrections') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3673 rollback): memory_corrections still exists';
  END IF;
  IF to_regprocedure('public.intel_append_only()') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3673 rollback): the shared intel_append_only() was removed; it belongs to 2130';
  END IF;
END $post$;
