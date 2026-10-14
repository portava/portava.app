-- Rollback for 3803_memory_type.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3803 DID: added memories.memory_type (NULL for every row that existed,
-- DEFAULT 'MOMENT' for new rows) with its §4 vocabulary CHECK, and seeded
-- memory_type_enabled FALSE.
-- WHAT THIS ROLLBACK DOES: refuses while the flag is ON (the API is serving the
-- field: turn it off first), and while any Memory carries a type other than the
-- default — an owner's choice, a TRIP or an EPISODE — because dropping the
-- column destroys it and nothing can re-derive it. With neither, it drops the
-- column, its CHECK and the flag. An owner's explicit MOMENT is
-- indistinguishable from the default and IS lost; re-applying 3803 reads every
-- row then present as NULL (unknown), the conservative direction.

BEGIN;

-- The column check and the row check are two statements, not one expression:
-- PL/pgSQL plans a statement when it first runs it, so the row check is never
-- planned on a database without the column (VERIFY-H4 H4-5). Run again after a
-- rollback, this file is a no-op.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'memory_type_enabled' AND enabled) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3803): memory_type_enabled is ON. Turn it off first.';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'memories' AND column_name = 'memory_type') THEN
    IF EXISTS (SELECT 1 FROM public.memories WHERE memory_type IS NOT NULL AND memory_type <> 'MOMENT') THEN
      RAISE EXCEPTION 'ROLLBACK REFUSED (3803): some Memories carry a type other than the default (an owner''s choice, TRIP or EPISODE). Dropping the column would destroy it.';
    END IF;
  END IF;
END $$;

ALTER TABLE public.memories DROP CONSTRAINT IF EXISTS memories_memory_type_check;
ALTER TABLE public.memories DROP COLUMN IF EXISTS memory_type;
DELETE FROM public.feature_flags WHERE flag = 'memory_type_enabled';
DELETE FROM public.schema_migration_ledger WHERE filename = '3803_memory_type.sql';

COMMIT;

DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'memories' AND column_name = 'memory_type') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3803 rollback): memories.memory_type still exists';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memories_memory_type_check') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3803 rollback): memories_memory_type_check still exists';
  END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'memory_type_enabled') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3803 rollback): memory_type_enabled still exists';
  END IF;
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger WHERE filename = '3803_memory_type.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3803 rollback): the ledger still records 3803 as applied';
  END IF;
END $post$;
