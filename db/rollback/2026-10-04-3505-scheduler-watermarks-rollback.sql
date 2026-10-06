-- Rollback for 3505_scheduler_watermarks.sql.
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) or the testing database
-- (ajrurzioarfkagpuxfnb). Rehearsed on a local PostgreSQL 16 only.
--
-- Drops public.scheduler_watermarks and deletes 3505's ledger row, so the
-- applier re-applies 3505 on its next run.
--
-- WHAT IS LOST, AND WHY THIS FILE DOES NOT REFUSE OVER IT. The table holds one
-- row per job: how far that job's work is known to have got. Dropping it loses
-- every mark. That is safe in the sense the forward file's design states: with
-- the table absent, lib/schedulerWatermark.readWatermark answers `ok: false`,
-- and every caller answers a refusal by keeping its own original lookback and
-- withholding the commit. So the jobs go back to what they did before 3505 —
-- which is the defect 3505 exists to fix (a window relative to `now` loses the
-- rows that fall in a gap), not a new one, and it holds for exactly as long as
-- the table is gone. A mark is not a record of anything a person did and no
-- retention rule covers it, so there is nothing to keep; the count is printed
-- so an operator can see that marks existed and are gone.
--
-- Run it only with the API stopped or already on a build that tolerates the
-- table's absence (every build does: the reader was written for it).

BEGIN;

DO $$
DECLARE
  n bigint := 0;
BEGIN
  IF to_regclass('public.scheduler_watermarks') IS NULL THEN
    RAISE NOTICE '3505 rollback: public.scheduler_watermarks is absent; nothing to drop.';
  ELSE
    EXECUTE 'SELECT count(*) FROM public.scheduler_watermarks' INTO n;
    RAISE NOTICE '3505 rollback: dropping public.scheduler_watermarks with % mark(s). Each job falls back to its fixed lookback until 3505 is re-applied and the job next succeeds.', n;
  END IF;
END $$;

DROP TABLE IF EXISTS public.scheduler_watermarks;

DELETE FROM public.schema_migration_ledger WHERE filename = '3505_scheduler_watermarks.sql';

COMMIT;

DO $post$
BEGIN
  IF to_regclass('public.scheduler_watermarks') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3505 rollback): public.scheduler_watermarks is still present.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger WHERE filename = '3505_scheduler_watermarks.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3505 rollback): the ledger still carries 3505''s row, so the applier would not re-apply it.';
  END IF;
END $post$;
