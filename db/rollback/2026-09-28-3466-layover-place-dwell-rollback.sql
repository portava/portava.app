-- Rollback for 3466_layover_place_dwell.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3466 DID: created public.layover_place_dwell (RLS on, four restrictive
-- client-deny policies, service_role grants).
-- WHAT THIS ROLLBACK DOES: reports how many curated dwell rows it is about to
-- drop (each is an administrator's statement about a place; nothing derives
-- them, so a drop loses them), then drops the table, and 3466's ledger row.
-- Run 3465's rollback too, or leave `layover_place_dwell_enabled` OFF: with the
-- table gone and the flag ON, every Layover-mode read reports
-- `dwell_source_unreadable` (an absence, never a number).

BEGIN;

DO $$
DECLARE n int;
BEGIN
  IF to_regclass('public.layover_place_dwell') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.layover_place_dwell' INTO n;
    RAISE NOTICE '3466 rollback: dropping public.layover_place_dwell with % curated row(s)', n;
  END IF;
END $$;

DROP TABLE IF EXISTS public.layover_place_dwell;
DELETE FROM public.schema_migration_ledger WHERE filename = '3466_layover_place_dwell.sql';

COMMIT;

DO $post$
BEGIN
  IF to_regclass('public.layover_place_dwell') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3466 rollback): layover_place_dwell still exists.';
  END IF;
END $post$;
