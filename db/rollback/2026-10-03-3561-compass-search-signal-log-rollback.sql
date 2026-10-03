-- Rollback for 3561_compass_search_signal_log.sql (FLAGS lane).
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) or the testing database (ajrurzioarfkagpuxfnb).
--
-- Drops the two functions and the table, and ONLY while SEARCH_SIGNAL_DECAY_DAYS
-- is not ON and the table holds no row. With the flag ON the route records
-- nudges through the RPC; with rows present, dropping the table would erase
-- per-user search signals that the stored category weights still owe a decay
-- to. Either way it raises instead. Deletes 3561's ledger row.

BEGIN;

DO $$
DECLARE
  has_rows boolean;
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'SEARCH_SIGNAL_DECAY_DAYS' AND enabled) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3561): SEARCH_SIGNAL_DECAY_DAYS is TRUE. Turn it off deliberately first, then re-run this file.';
  END IF;
  IF to_regclass('public.compass_search_signal_log') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.compass_search_signal_log)' INTO has_rows;
    IF has_rows THEN
      RAISE EXCEPTION 'ROLLBACK REFUSED (3561): compass_search_signal_log holds rows. Decide what happens to them (purge_compass_search_signal_log with the owner''s period, or keep) first.';
    END IF;
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.purge_compass_search_signal_log(interval);
DROP FUNCTION IF EXISTS public.upsert_compass_search_signal(uuid, text, integer);
DROP TABLE IF EXISTS public.compass_search_signal_log;

DELETE FROM public.schema_migration_ledger WHERE filename = '3561_compass_search_signal_log.sql';

COMMIT;

DO $post$
BEGIN
  IF to_regclass('public.compass_search_signal_log') IS NOT NULL
     OR to_regprocedure('public.upsert_compass_search_signal(uuid,text,integer)') IS NOT NULL
     OR to_regprocedure('public.purge_compass_search_signal_log(interval)') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3561 rollback): a 3561 object is still present.';
  END IF;
END $post$;
