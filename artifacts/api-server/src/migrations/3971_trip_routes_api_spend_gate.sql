-- 3971_trip_routes_api_spend_gate.sql
--
-- Trips §6/§7 routed travel time (census-trips TR128, TR267, TR341, TR412) and
-- the owner's decision of 2026-10-04 (Trips, verbatim):
--
--   "Routes API: Yes, for a bounded rollout if routing is a core trip feature.
--    Put calls behind a server-side provider interface, set daily quotas and a
--    hard budget, and fall back gracefully when the limit is reached."
--
-- APPLIED TO NO DATABASE by the lane that wrote it (lane C, 2026-10-05).
--
-- ── WHAT THIS FILE IS ──────────────────────────────────────────────────────
-- The HARD part of "daily quotas and a hard budget": a per-UTC-day counter that
-- every API instance spends against ATOMICALLY, so N instances cannot each
-- spend the whole allowance. One row per day; `routes_api_try_spend` takes one
-- call's worth under the row lock and answers whether it may be made:
--
--   'granted'           counted; the caller may make exactly one paid call
--   'quota_exhausted'   today's call quota is used up — fall back
--   'budget_exhausted'  one more call would cross today's hard budget — fall back
--   'off'               no quota, budget or per-call cost was configured — fall back
--
-- The QUOTA, BUDGET and PER-CALL COST are the caller's arguments, read from
-- deployment configuration by domain/trips/contracts/RoutesSpendGate.ts. None
-- is invented here: Google publishes the per-request price on its own billing
-- page, and the owner sets the quota and budget. Absent configuration is 'off'.
--
-- ── WHAT IT IS NOT ─────────────────────────────────────────────────────────
-- Not a billing record. It counts calls this system decided to make and the
-- cost it ASSUMED per call; Google's invoice is the authority on money. The
-- gate is conservative by construction: a call is counted before it is made,
-- so a call that then fails still spends its unit.
--
-- ── FLAG ───────────────────────────────────────────────────────────────────
-- `trip_routes_api_enabled`, seeded FALSE. OFF / absent / unreadable: no paid
-- call is made and every Trips estimate is the straight-line bound it was
-- before. The function is service_role only; no client can spend or read it.
--
-- Rollback: db/rollback/2026-10-05-3971-trip-routes-api-spend-gate-rollback.sql

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.routes_api_daily_usage') IS NOT NULL THEN
    RAISE EXCEPTION '3971: routes_api_daily_usage already exists; this migration is not idempotent by design';
  END IF;
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION '3971: public.feature_flags does not exist';
  END IF;
END
$pre$;

CREATE TABLE public.routes_api_daily_usage (
  usage_day     date        PRIMARY KEY,
  calls         integer     NOT NULL DEFAULT 0,
  spend_micros  bigint      NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT routes_api_daily_usage_calls_nonnegative CHECK (calls >= 0),
  CONSTRAINT routes_api_daily_usage_spend_nonnegative CHECK (spend_micros >= 0)
);

COMMENT ON TABLE public.routes_api_daily_usage IS
  'Trips routed travel time (owner decision 2026-10-04: daily quotas + hard budget + graceful fallback). One row per UTC day: calls this system decided to make to the Google Routes API and the per-call cost it assumed, in micro-USD. Spent only through public.routes_api_try_spend under the row lock. Holds no user data.';

ALTER TABLE public.routes_api_daily_usage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.routes_api_daily_usage FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.routes_api_daily_usage TO service_role;

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

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'trip_routes_api_enabled',
    false,
    'Trips routed travel time through the Google Routes API (census-trips TR128/TR267/TR341/TR412; owner decision 2026-10-04: bounded rollout, daily quota, hard budget, graceful fallback). ON, with ROUTES_API_DAILY_QUOTA, ROUTES_API_DAILY_BUDGET_USD, ROUTES_API_COST_PER_CALL_USD and GOOGLE_MAPS_API_KEY set: each uncached Trips estimate takes one unit from public.routes_api_try_spend before calling Google; at the limit, or on any failure, the straight-line bound answers and says why. OFF / absent / unreadable (the seed): no paid call is made.'
  )
ON CONFLICT (flag) DO NOTHING;

COMMIT;

-- ── Postconditions (separate transaction: they assert what persisted) ───────
DO $post$
DECLARE n int;
BEGIN
  IF to_regclass('public.routes_api_daily_usage') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3971): routes_api_daily_usage was not created';
  END IF;

  IF has_table_privilege('anon', 'public.routes_api_daily_usage', 'SELECT')
     OR has_table_privilege('authenticated', 'public.routes_api_daily_usage', 'SELECT')
     OR has_table_privilege('authenticated', 'public.routes_api_daily_usage', 'UPDATE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3971): a client role holds a privilege on routes_api_daily_usage';
  END IF;

  IF has_function_privilege('anon', 'public.routes_api_try_spend(integer, bigint, bigint)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.routes_api_try_spend(integer, bigint, bigint)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3971): a client role can spend the Routes API budget';
  END IF;

  -- Unconfigured is OFF, and a refusal writes nothing: an 'off' call must not
  -- create today's row.
  IF public.routes_api_try_spend(0, 0, 0) <> 'off' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3971): an unconfigured spend was not answered off';
  END IF;
  SELECT count(*) INTO n FROM public.routes_api_daily_usage;
  IF n <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3971): an off answer wrote % usage row(s)', n;
  END IF;

  SELECT count(*) INTO n FROM public.feature_flags WHERE flag = 'trip_routes_api_enabled';
  IF n <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3971): trip_routes_api_enabled is not present';
  END IF;
  SELECT count(*) INTO n FROM public.feature_flags WHERE flag = 'trip_routes_api_enabled' AND enabled = TRUE;
  IF n <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3971): trip_routes_api_enabled is ON; it must ship OFF';
  END IF;
END
$post$;
