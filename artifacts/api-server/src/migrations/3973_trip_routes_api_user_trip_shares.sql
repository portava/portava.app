-- 3973_trip_routes_api_user_trip_shares.sql
--
-- census-trips §82; verifier finding 7 (2026-10-05): "one member can drain the
-- shared daily quota". 3971 bounded the DAY: one quota and one hard budget,
-- shared by everyone. Nothing bounded a member or a trip, so one person reading
-- one trip's route chain and feasibility often enough took every call of the
-- day from every other trip.
--
-- This adds a per-USER and a per-TRIP daily share, taken TOGETHER with the
-- day's unit in one function call, or not at all:
--
--   routes_api_try_spend_scoped(quota, budget, cost, user, trip, user_share, trip_share)
--     → granted | quota_exhausted | budget_exhausted | user_share_exhausted
--       | trip_share_exhausted | unscoped | off
--
-- WHY IT CANNOT OVERSHOOT UNDER CONCURRENCY (the same argument as 3971's,
-- extended to three rows). The three counter rows are created if absent
-- (INSERT … ON CONFLICT DO NOTHING) and then locked FOR UPDATE in ONE fixed
-- order — the day row, then the trip row, then the user row. Every spender
-- takes the day row first, so all spenders serialise on it: no two can hold
-- a trip or user row while waiting for the day row, and there is no lock cycle.
-- Holding all three, the function checks all four limits against the values it
-- now owns and either increments all three or changes nothing. The locks are
-- held to the end of the caller's transaction (one PostgREST RPC = one
-- transaction), so the next spender re-reads the incremented totals. A refusal
-- writes no counter.
--
-- 3971's routes_api_try_spend is left in place and unused by this tree (its
-- one caller now calls this function); dropping it is not needed to be safe.
--
-- DELETION. Both new tables carry a user's or a trip's id; each row dies with
-- the account or the trip (ON DELETE CASCADE). They hold a count and nothing else.
--
-- APPLIED TO NO DATABASE by the lane that wrote it (lane C, 2026-10-05). Needs 3971.
-- Rollback: db/rollback/2026-10-05-3973-trip-routes-api-user-trip-shares-rollback.sql

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.routes_api_daily_usage') IS NULL THEN
    RAISE EXCEPTION '3973: requires 3971 (routes_api_daily_usage)';
  END IF;
  IF to_regclass('public.routes_api_daily_user_usage') IS NOT NULL OR to_regclass('public.routes_api_daily_trip_usage') IS NOT NULL THEN
    RAISE EXCEPTION '3973: a share table already exists; this migration is not idempotent by design';
  END IF;
END
$pre$;

CREATE TABLE public.routes_api_daily_user_usage (
  usage_day  date        NOT NULL,
  user_id    uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  calls      integer     NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (usage_day, user_id),
  CONSTRAINT routes_api_daily_user_usage_calls_nonnegative CHECK (calls >= 0)
);

CREATE TABLE public.routes_api_daily_trip_usage (
  usage_day  date        NOT NULL,
  trip_id    uuid        NOT NULL REFERENCES public.trips(id) ON DELETE CASCADE,
  calls      integer     NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (usage_day, trip_id),
  CONSTRAINT routes_api_daily_trip_usage_calls_nonnegative CHECK (calls >= 0)
);

COMMENT ON TABLE public.routes_api_daily_user_usage IS
  'census-trips §82: Routes API calls charged to one user per UTC day, so no member can drain the shared quota. Spent only through public.routes_api_try_spend_scoped under row locks. A count and nothing else; dies with the account.';
COMMENT ON TABLE public.routes_api_daily_trip_usage IS
  'census-trips §82: Routes API calls charged to one trip per UTC day. Spent only through public.routes_api_try_spend_scoped under row locks. A count and nothing else; dies with the trip.';

ALTER TABLE public.routes_api_daily_user_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.routes_api_daily_trip_usage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.routes_api_daily_user_usage FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.routes_api_daily_trip_usage FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.routes_api_daily_user_usage TO service_role;
GRANT SELECT ON public.routes_api_daily_trip_usage TO service_role;

CREATE OR REPLACE FUNCTION public.routes_api_try_spend_scoped(
  p_quota          integer,
  p_budget_micros  bigint,
  p_cost_micros    bigint,
  p_user_id        uuid,
  p_trip_id        uuid,
  p_user_share     integer,
  p_trip_share     integer
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
  d date := (now() AT TIME ZONE 'UTC')::date;
  day_calls integer; day_spend bigint; trip_calls integer; user_calls integer;
BEGIN
  IF p_quota IS NULL OR p_quota <= 0
     OR p_budget_micros IS NULL OR p_budget_micros <= 0
     OR p_cost_micros IS NULL OR p_cost_micros <= 0
     OR p_user_share IS NULL OR p_user_share <= 0
     OR p_trip_share IS NULL OR p_trip_share <= 0 THEN
    RETURN 'off';
  END IF;
  IF p_user_id IS NULL OR p_trip_id IS NULL THEN
    RETURN 'unscoped';
  END IF;

  INSERT INTO public.routes_api_daily_usage (usage_day) VALUES (d) ON CONFLICT (usage_day) DO NOTHING;
  INSERT INTO public.routes_api_daily_trip_usage (usage_day, trip_id) VALUES (d, p_trip_id) ON CONFLICT (usage_day, trip_id) DO NOTHING;
  INSERT INTO public.routes_api_daily_user_usage (usage_day, user_id) VALUES (d, p_user_id) ON CONFLICT (usage_day, user_id) DO NOTHING;

  -- ONE lock order for every spender: day, trip, user. The day row serialises them.
  SELECT u.calls, u.spend_micros INTO day_calls, day_spend FROM public.routes_api_daily_usage u WHERE u.usage_day = d FOR UPDATE;
  SELECT t.calls INTO trip_calls FROM public.routes_api_daily_trip_usage t WHERE t.usage_day = d AND t.trip_id = p_trip_id FOR UPDATE;
  SELECT s.calls INTO user_calls FROM public.routes_api_daily_user_usage s WHERE s.usage_day = d AND s.user_id = p_user_id FOR UPDATE;

  IF day_calls + 1 > p_quota THEN RETURN 'quota_exhausted'; END IF;
  IF day_spend + p_cost_micros > p_budget_micros THEN RETURN 'budget_exhausted'; END IF;
  IF trip_calls + 1 > p_trip_share THEN RETURN 'trip_share_exhausted'; END IF;
  IF user_calls + 1 > p_user_share THEN RETURN 'user_share_exhausted'; END IF;

  UPDATE public.routes_api_daily_usage u SET calls = u.calls + 1, spend_micros = u.spend_micros + p_cost_micros, updated_at = now() WHERE u.usage_day = d;
  UPDATE public.routes_api_daily_trip_usage t SET calls = t.calls + 1, updated_at = now() WHERE t.usage_day = d AND t.trip_id = p_trip_id;
  UPDATE public.routes_api_daily_user_usage s SET calls = s.calls + 1, updated_at = now() WHERE s.usage_day = d AND s.user_id = p_user_id;
  RETURN 'granted';
END
$fn$;

COMMENT ON FUNCTION public.routes_api_try_spend_scoped(integer, bigint, bigint, uuid, uuid, integer, integer) IS
  'census-trips §82: take one Routes API call from today''s (UTC) quota and hard budget AND from this user''s and this trip''s daily share, atomically across instances (rows locked day → trip → user), or take none. Answers granted | quota_exhausted | budget_exhausted | trip_share_exhausted | user_share_exhausted | unscoped | off. A refusal changes no counter. service_role only.';

REVOKE ALL ON FUNCTION public.routes_api_try_spend_scoped(integer, bigint, bigint, uuid, uuid, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.routes_api_try_spend_scoped(integer, bigint, bigint, uuid, uuid, integer, integer) TO service_role;

COMMIT;

-- ── Postconditions (separate transaction: they assert what persisted) ───────
DO $post$
DECLARE n int;
BEGIN
  IF to_regclass('public.routes_api_daily_user_usage') IS NULL OR to_regclass('public.routes_api_daily_trip_usage') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3973): a share table was not created';
  END IF;
  IF has_table_privilege('authenticated', 'public.routes_api_daily_user_usage', 'SELECT')
     OR has_table_privilege('authenticated', 'public.routes_api_daily_trip_usage', 'SELECT')
     OR has_table_privilege('anon', 'public.routes_api_daily_user_usage', 'SELECT')
     OR has_table_privilege('anon', 'public.routes_api_daily_trip_usage', 'SELECT') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3973): a client role can read a share table';
  END IF;
  IF has_function_privilege('authenticated', 'public.routes_api_try_spend_scoped(integer, bigint, bigint, uuid, uuid, integer, integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.routes_api_try_spend_scoped(integer, bigint, bigint, uuid, uuid, integer, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3973): a client role can spend';
  END IF;
  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid IN ('public.routes_api_daily_user_usage'::regclass, 'public.routes_api_daily_trip_usage'::regclass) AND contype = 'f' AND confdeltype = 'c';
  IF n <> 2 THEN RAISE EXCEPTION 'POSTCONDITION FAILED (3973): expected 2 ON DELETE CASCADE foreign keys, found %', n; END IF;
  -- An unconfigured call spends nothing and says so; an unscoped one likewise.
  IF public.routes_api_try_spend_scoped(0, 1, 1, gen_random_uuid(), gen_random_uuid(), 1, 1) <> 'off' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3973): an unconfigured spend was not OFF';
  END IF;
  IF public.routes_api_try_spend_scoped(1, 1, 1, NULL, gen_random_uuid(), 1, 1) <> 'unscoped' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3973): a spend with no user was not unscoped';
  END IF;
END
$post$;
