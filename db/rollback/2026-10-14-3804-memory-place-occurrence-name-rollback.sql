-- Rollback for 3804_memory_place_occurrence_name.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3804 DID: added memories.place_display_name_at_occurrence (NULL for every
-- row that existed, no default) with its CHECK, the BEFORE INSERT OR UPDATE OF
-- place_id, place_display_name_at_occurrence trigger and its function, and
-- seeded memory_place_occurrence_name_enabled FALSE.
-- WHAT THIS ROLLBACK DOES: refuses while the flag is ON (the API is serving the
-- field: turn it off first), and while any Memory holds an occurrence name —
-- that text is the place's name AS IT WAS, and once the catalog renames or
-- merges the place nothing can re-derive it. To roll back anyway, copy
-- (id, place_display_name_at_occurrence) somewhere durable by hand first, then
-- null the column, then run this file. With neither, it drops the trigger, the
-- function, the column, its CHECK and the flag.

BEGIN;

-- The column check and the row check are two statements (VERIFY-H4 H4-5): the
-- row check is never planned on a database without the column, so a re-run
-- after a rollback is a no-op.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'memory_place_occurrence_name_enabled' AND enabled) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3804): memory_place_occurrence_name_enabled is ON. Turn it off first.';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'memories' AND column_name = 'place_display_name_at_occurrence') THEN
    IF EXISTS (SELECT 1 FROM public.memories WHERE place_display_name_at_occurrence IS NOT NULL) THEN
      RAISE EXCEPTION 'ROLLBACK REFUSED (3804): some Memories hold the name their place had at the time. Dropping the column would destroy history nothing can re-derive.';
    END IF;
  END IF;
END $$;

DROP TRIGGER IF EXISTS memory_place_occurrence_name_fill ON public.memories;
DROP FUNCTION IF EXISTS public.memory_place_occurrence_name_fill();
ALTER TABLE public.memories DROP CONSTRAINT IF EXISTS memories_place_display_name_at_occurrence_check;
ALTER TABLE public.memories DROP COLUMN IF EXISTS place_display_name_at_occurrence;
DELETE FROM public.feature_flags WHERE flag = 'memory_place_occurrence_name_enabled';
DELETE FROM public.schema_migration_ledger WHERE filename = '3804_memory_place_occurrence_name.sql';

COMMIT;

DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'memories' AND column_name = 'place_display_name_at_occurrence') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3804 rollback): memories.place_display_name_at_occurrence still exists';
  END IF;
  IF to_regprocedure('public.memory_place_occurrence_name_fill()') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3804 rollback): memory_place_occurrence_name_fill still exists';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND tgname = 'memory_place_occurrence_name_fill') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3804 rollback): the occurrence-name trigger still exists';
  END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'memory_place_occurrence_name_enabled') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3804 rollback): memory_place_occurrence_name_enabled still exists';
  END IF;
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger WHERE filename = '3804_memory_place_occurrence_name.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3804 rollback): the ledger still records 3804 as applied';
  END IF;
END $post$;
