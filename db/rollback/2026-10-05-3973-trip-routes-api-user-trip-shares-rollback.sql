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

-- 3971's unscoped spend, which 3973 dropped, re-created verbatim from 3971.
CREATE OR REPLACE FUNCTION public.routes_api_try_spend(
  p_quota          integer,
  p_budget_micros  bigint,
  p_cost_micros    bigint
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
  d date := (now() AT TIME ZONE 'UTC')::date;
  c integer;
BEGIN
  IF p_quota IS NULL OR p_quota <= 0
     OR p_budget_micros IS NULL OR p_budget_micros <= 0
     OR p_cost_micros IS NULL OR p_cost_micros <= 0 THEN
    RETURN 'off';
  END IF;

  INSERT INTO public.routes_api_daily_usage (usage_day) VALUES (d)
  ON CONFLICT (usage_day) DO NOTHING;

  -- The row lock taken by this UPDATE is what makes the allowance shared: a
  -- concurrent spender waits here and then re-evaluates against the new totals.
  UPDATE public.routes_api_daily_usage
     SET calls = calls + 1,
         spend_micros = spend_micros + p_cost_micros,
         updated_at = now()
   WHERE usage_day = d
     AND calls + 1 <= p_quota
     AND spend_micros + p_cost_micros <= p_budget_micros;
  IF FOUND THEN
    RETURN 'granted';
  END IF;

  SELECT calls INTO c FROM public.routes_api_daily_usage WHERE usage_day = d;
  IF c + 1 > p_quota THEN
    RETURN 'quota_exhausted';
  END IF;
  RETURN 'budget_exhausted';
END
$fn$;

COMMENT ON FUNCTION public.routes_api_try_spend(integer, bigint, bigint) IS
  'Take one Routes API call from today''s (UTC) quota and hard budget, atomically across instances. Answers granted | quota_exhausted | budget_exhausted | off. A refusal changes nothing. service_role only.';

REVOKE ALL ON FUNCTION public.routes_api_try_spend(integer, bigint, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.routes_api_try_spend(integer, bigint, bigint) TO service_role;
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
