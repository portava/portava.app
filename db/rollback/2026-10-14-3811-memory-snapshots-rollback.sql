-- Rollback for 3811_memory_snapshots.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3811 DID: created public.memory_snapshots (RLS on, no policy, service
-- role SELECT and DELETE only), memory_snapshot_record() and its AFTER INSERT OR
-- UPDATE trigger on public.memories, and memory_snapshots_guard() and its BEFORE
-- UPDATE OR DELETE trigger on the table. It seeded no flag and wrote no row.
--
-- WHAT THIS ROLLBACK DOES: stops the writer FIRST (the trigger on memories), then
-- drops the table, both functions and 3811's ledger row. Run again after a
-- rollback, it is a no-op.
--
-- IT REFUSES WHILE ANY VERSION EXISTS, unless told otherwise. The trigger records
-- a version on every Memory write from the moment 3811 is applied, so on any
-- database that served traffic the table holds history, and that history cannot
-- be re-derived: the Memories hold only their CURRENT facts. Dropping it is a
-- decision, so it must be stated in the session that runs this file:
--     PGOPTIONS='-c portava.rollback_3811_discard_history=discard' psql -f <this file>
-- (or `SET portava.rollback_3811_discard_history = 'discard';` first in the same
-- session). What is discarded is fact history only — never a Memory, a title, a
-- caption, a coordinate or a person, none of which 3811 copies.

BEGIN;

-- The table check and the row check are separate statements: PL/pgSQL plans a
-- statement when it first runs it, so the row check is never planned on a
-- database without the table.
DO $$
DECLARE
  v_rows bigint;
BEGIN
  IF to_regclass('public.memory_snapshots') IS NOT NULL THEN
    SELECT count(*) INTO v_rows FROM public.memory_snapshots;
    IF v_rows > 0 AND coalesce(current_setting('portava.rollback_3811_discard_history', true), '') <> 'discard' THEN
      RAISE EXCEPTION 'ROLLBACK REFUSED (3811): public.memory_snapshots holds % version(s) of Memory fact history, which nothing can re-derive. Set portava.rollback_3811_discard_history = ''discard'' in this session to drop them deliberately.', v_rows;
    END IF;
    RAISE NOTICE '3811 rollback: discarding % snapshot version(s)', v_rows;
  END IF;
END $$;

DROP TRIGGER IF EXISTS memory_snapshot_record ON public.memories;
DROP TABLE IF EXISTS public.memory_snapshots;
DROP FUNCTION IF EXISTS public.memory_snapshot_record();
DROP FUNCTION IF EXISTS public.memory_snapshots_guard();
DELETE FROM public.schema_migration_ledger WHERE filename = '3811_memory_snapshots.sql';

COMMIT;

DO $post$
BEGIN
  IF to_regclass('public.memory_snapshots') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3811 rollback): public.memory_snapshots still exists';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.memories'::regclass AND tgname = 'memory_snapshot_record') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3811 rollback): the snapshot trigger on public.memories still exists';
  END IF;
  IF to_regprocedure('public.memory_snapshot_record()') IS NOT NULL
     OR to_regprocedure('public.memory_snapshots_guard()') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3811 rollback): a 3811 function still exists';
  END IF;
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger WHERE filename = '3811_memory_snapshots.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3811 rollback): the ledger still records 3811 as applied';
  END IF;
END $post$;
