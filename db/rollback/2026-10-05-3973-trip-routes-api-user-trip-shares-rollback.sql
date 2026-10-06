-- Rollback for 3973_trip_routes_api_user_trip_shares.sql (census-trips §82, lane C).
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) or travel-buddy (ajrurzioarfkagpuxfnb).
--
-- Refuses while trip_routes_api_enabled is TRUE: the API's spend gate calls
-- routes_api_try_spend_scoped, and without it every spend answers `unavailable`
-- (the straight-line bound) — safe, but a silent end of routing the owner should
-- choose. Then drops the function, both share tables and 3973's ledger row.
-- 3971's day counter is untouched.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'trip_routes_api_enabled' AND enabled) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3973): trip_routes_api_enabled is TRUE. Turn it off deliberately first.';
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.routes_api_try_spend_scoped(integer, bigint, bigint, uuid, uuid, integer, integer);
DROP TABLE IF EXISTS public.routes_api_daily_user_usage;
DROP TABLE IF EXISTS public.routes_api_daily_trip_usage;

DELETE FROM public.schema_migration_ledger WHERE filename = '3973_trip_routes_api_user_trip_shares.sql';

COMMIT;

DO $post$
BEGIN
  IF to_regclass('public.routes_api_daily_user_usage') IS NOT NULL OR to_regclass('public.routes_api_daily_trip_usage') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3973 rollback): a share table is still present.';
  END IF;
END $post$;
