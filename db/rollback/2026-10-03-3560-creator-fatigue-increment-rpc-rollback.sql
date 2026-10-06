-- Rollback for 3560_creator_fatigue_increment_rpc.sql (FLAGS lane).
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) or the testing database (ajrurzioarfkagpuxfnb).
--
-- Drops increment_creator_fatigue_batch, and ONLY while CREATOR_FATIGUE_ENABLED is
-- not ON: with the flag ON, lib/rankLog.ts calls this function after every
-- impression batch, and dropping it would turn every one of those writes into a
-- reported 42883 failure. It raises instead. viewer_creator_fatigue rows the
-- function wrote are kept (their retention is lib/rankingFatigueSweeper.ts, 30
-- days). Deletes 3560's ledger row.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'CREATOR_FATIGUE_ENABLED' AND enabled) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3560): CREATOR_FATIGUE_ENABLED is TRUE. Turn it off deliberately first, then re-run this file.';
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.increment_creator_fatigue_batch(uuid, uuid[], integer, integer);

DELETE FROM public.schema_migration_ledger WHERE filename = '3560_creator_fatigue_increment_rpc.sql';

COMMIT;

DO $post$
BEGIN
  IF to_regprocedure('public.increment_creator_fatigue_batch(uuid,uuid[],integer,integer)') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3560 rollback): increment_creator_fatigue_batch is still present.';
  END IF;
END $post$;
