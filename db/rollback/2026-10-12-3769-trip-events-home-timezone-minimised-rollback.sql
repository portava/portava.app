-- Rollback for 3769_trip_events_home_timezone_minimised.sql (owner ruling 2026-10-12, census-trips §94).
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) or travel-buddy (ajrurzioarfkagpuxfnb).
--
-- Removes the BEFORE INSERT trigger and its two functions. Events written while
-- 3769 was installed stay without `home_timezone` (trip_events is append-only);
-- events written after this rollback carry it again in `payload_json.result`
-- wherever 3768 is applied. Nothing else reads either function.

BEGIN;

DROP TRIGGER IF EXISTS trg_trip_events_home_timezone_minimise ON public.trip_events;
DROP FUNCTION IF EXISTS public.trip_events_home_timezone_minimise_on_insert();
DROP FUNCTION IF EXISTS public.trip_event_home_timezone_removed(jsonb);

DELETE FROM public.schema_migration_ledger WHERE filename = '3769_trip_events_home_timezone_minimised.sql';

DO $rb$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_trip_events_home_timezone_minimise' AND NOT tgisinternal)
     OR to_regprocedure('public.trip_event_home_timezone_removed(jsonb)') IS NOT NULL
     OR to_regprocedure('public.trip_events_home_timezone_minimise_on_insert()') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback 3769: a trace of 3769 survived';
  END IF;
END
$rb$;

COMMIT;
