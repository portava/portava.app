-- Rollback for 3971_trip_routes_api_spend_gate.sql (census-trips TR128/TR267/TR341/TR412, lane C).
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) or travel-buddy (ajrurzioarfkagpuxfnb).
--
-- Refuses while trip_routes_api_enabled is TRUE: dropping the spend gate under a
-- live rollout would make every estimate fall back mid-day without anyone
-- having decided it. The usage rows hold no user data; they are dropped with
-- the table. After this rollback the gate answers 'unavailable' (the function
-- is absent), which the provider treats as "fall back", so no paid call can
-- be made.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'trip_routes_api_enabled' AND enabled) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3971): trip_routes_api_enabled is TRUE. Turn it off deliberately first.';
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.routes_api_try_spend(integer, bigint, bigint);
DROP TABLE IF EXISTS public.routes_api_daily_usage;
DELETE FROM public.feature_flags WHERE flag = 'trip_routes_api_enabled' AND enabled = FALSE;
DELETE FROM public.schema_migration_ledger WHERE filename = '3971_trip_routes_api_spend_gate.sql';

COMMIT;

DO $post$
BEGIN
  IF to_regclass('public.routes_api_daily_usage') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3971 rollback): the table is still present.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'routes_api_try_spend') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3971 rollback): the function is still present.';
  END IF;
END $post$;
