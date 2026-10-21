-- 3856_layover_routes_session_budget.sql
--
-- LAYOVER 165, lane B1-R1 — owner decision R5 (2026-10-18): Google Routes is
-- approved for Layover, and a layover's routed calls are charged to a
-- LAYOVER-SESSION budget scope, keyed by the session and the user, with its own
-- caps (census-layover L60, L61, L63, L65, L66, L68–L71, L221, L260, L282).
--
--   (a) "A trip-less layover session is charged to a layover-session budget
--       scope, keyed by the session and the user, with its own caps."
--   (b) "The caps must allow the per-candidate routing the rows require. D-7 is
--       3 per trip, and a landside candidate costs 2 billed calls."
--
-- WHAT THIS ADDS (one transaction, additive):
--   * the flag layover_routed_corridor_enabled, seeded FALSE: the operator's
--     kill switch for every layover Routes call
--     (services/airport/layoverRoutesSpendGate.ts reads it; off / absent /
--     unreadable = no call);
--   * public.routes_api_layover_session_usage — calls one layover SESSION has
--     taken over its whole life (cap: 36, see layoverRoutesSpendGate.ts);
--   * public.routes_api_layover_user_daily_usage — calls one person's layover
--     sessions have taken per UTC day (cap: 60);
--   * public.routes_api_try_spend_layover(quota, budget, cost, user, session,
--     session_cap, user_daily_cap) → granted | off | unscoped | unavailable
--     | quota_exhausted | budget_exhausted | session_share_exhausted
--     | user_share_exhausted.
--
-- THE DAY IS SHARED WITH TRIPS. A layover call takes one unit of the SAME day
-- row Trips spends from (3971's public.routes_api_daily_usage: the owner's
-- $10 / 500-call ceiling), so the Cloud bill has one daily ceiling, not two. It
-- is NOT charged to a trip's or a person's Trips share (3973): those are D-7's,
-- and (b) cannot hold under them.
--
-- WHY IT CANNOT OVERSHOOT (3973's argument, with the layover rows). The three
-- counter rows are created if absent and then locked FOR UPDATE in ONE fixed
-- order — the day row, the session row, the user row. Every spender of either
-- kind (3973's takes day → trip → user) takes the DAY row first, so all
-- spenders serialise on it and no lock cycle exists. Holding all three, the
-- function checks the four limits against values it owns and increments all
-- three or none. A refusal changes no counter.
--
-- ORDER INDEPENDENCE (this file is a gap number: on portava-ci and production
-- it is applied AFTER 3999). It depends at CREATE time on nothing above it:
-- auth.users, public.layover_sessions (0127) and public.feature_flags (0118).
-- Its one reference to a later file — 3971's routes_api_daily_usage — is inside
-- the function body, which PL/pgSQL resolves at EXECUTION, and is guarded: until
-- that table exists the function answers 'unavailable' and spends nothing (the
-- gate then makes no call). Nothing numbered above 3856 creates, alters or drops
-- any object this file creates (grep of every migration > 3856 for
-- routes_api_layover / routes_api_try_spend_layover /
-- layover_routed_corridor_enabled: no match), and none alters
-- public.layover_sessions or routes_api_daily_usage's columns
-- (usage_day, calls, spend_micros).
--
-- OWNERSHIP. The function refuses ('unscoped') a session that is not the
-- caller's user's — a server bug cannot charge one traveller's call to
-- another's session.
--
-- ACCESS. Both tables: RLS on, no policy, every client privilege revoked,
-- service_role SELECT only (writes happen only inside the SECURITY DEFINER
-- function). The function: search_path pinned, EXECUTE for service_role only.
--
-- DELETION. Both tables hold a count and nothing else. The session row dies
-- with the layover session (ON DELETE CASCADE) and with the account; the daily
-- row dies with the account (ON DELETE CASCADE from auth.users).
--
-- APPLIED TO NO DATABASE by the lane that wrote it.
-- Rollback: db/rollback/2026-10-18-3856-layover-routes-session-budget-rollback.sql
-- (refuses while a counter row exists, while the flag is TRUE, or while
-- feature_flag_audit_log holds history for the flag).

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('auth.users') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3856): auth.users is missing; the erasure cascades cannot be created';
  END IF;
  IF to_regclass('public.layover_sessions') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3856): public.layover_sessions (0127) does not exist';
  END IF;
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3856): public.feature_flags (0118) does not exist';
  END IF;
  IF to_regclass('public.routes_api_layover_session_usage') IS NOT NULL
     OR to_regclass('public.routes_api_layover_user_daily_usage') IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3856): a layover Routes usage table already exists; this migration is not idempotent by design';
  END IF;
END
$pre$;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  ('layover_routed_corridor_enabled', false,
   '3856 (LAYOVER 165, lane B1-R1; owner decision R5 2026-10-18): Google Routes for the Layover surface — both legs of every pre-filtered landside candidate, charged to the layover session (36 calls per session, 60 per person per UTC day) and the shared Routes day ceiling. FALSE / absent / unreadable: no layover Routes call is made, and every landside leg is the named absence it was. Needs LAYOVER_ROUTED_CORRIDOR_ENABLED=true, GOOGLE_MAPS_API_KEY and the ROUTES_API_DAILY_* configuration as well.')
ON CONFLICT (flag) DO NOTHING;

CREATE TABLE public.routes_api_layover_session_usage (
  session_id uuid        PRIMARY KEY REFERENCES public.layover_sessions (id) ON DELETE CASCADE,
  user_id    uuid        NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  calls      integer     NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT routes_api_layover_session_usage_calls_nonnegative CHECK (calls >= 0)
);
CREATE INDEX routes_api_layover_session_usage_user_idx ON public.routes_api_layover_session_usage (user_id);

CREATE TABLE public.routes_api_layover_user_daily_usage (
  usage_day  date        NOT NULL,
  user_id    uuid        NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  calls      integer     NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (usage_day, user_id),
  CONSTRAINT routes_api_layover_user_daily_usage_calls_nonnegative CHECK (calls >= 0)
);
CREATE INDEX routes_api_layover_user_daily_usage_user_idx ON public.routes_api_layover_user_daily_usage (user_id);

COMMENT ON TABLE public.routes_api_layover_session_usage IS
  '3856 (owner decision R5): Google Routes calls one layover session has taken over its life. Spent only through public.routes_api_try_spend_layover under row locks. A count and nothing else; dies with the session and the account.';
COMMENT ON TABLE public.routes_api_layover_user_daily_usage IS
  '3856 (owner decision R5): Google Routes calls one person''s layover sessions have taken per UTC day. Spent only through public.routes_api_try_spend_layover under row locks. A count and nothing else; dies with the account.';

ALTER TABLE public.routes_api_layover_session_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.routes_api_layover_user_daily_usage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.routes_api_layover_session_usage FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.routes_api_layover_user_daily_usage FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.routes_api_layover_session_usage TO service_role;
GRANT SELECT ON public.routes_api_layover_user_daily_usage TO service_role;

CREATE FUNCTION public.routes_api_try_spend_layover(
  p_quota          integer,
  p_budget_micros  bigint,
  p_cost_micros    bigint,
  p_user_id        uuid,
  p_session_id     uuid,
  p_session_cap    integer,
  p_user_daily_cap integer
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
  d date := (now() AT TIME ZONE 'UTC')::date;
  owner_id uuid; day_calls integer; day_spend bigint; session_calls integer; user_calls integer;
BEGIN
  IF p_quota IS NULL OR p_quota <= 0
     OR p_budget_micros IS NULL OR p_budget_micros <= 0
     OR p_cost_micros IS NULL OR p_cost_micros <= 0
     OR p_session_cap IS NULL OR p_session_cap <= 0
     OR p_user_daily_cap IS NULL OR p_user_daily_cap <= 0 THEN
    RETURN 'off';
  END IF;
  IF p_user_id IS NULL OR p_session_id IS NULL THEN
    RETURN 'unscoped';
  END IF;
  -- The shared day row is 3971's. Until it exists nothing is counted, so nothing is spent.
  IF to_regclass('public.routes_api_daily_usage') IS NULL THEN
    RETURN 'unavailable';
  END IF;
  SELECT s.user_id INTO owner_id FROM public.layover_sessions s WHERE s.id = p_session_id;
  IF owner_id IS NULL OR owner_id <> p_user_id THEN
    RETURN 'unscoped';
  END IF;

  INSERT INTO public.routes_api_daily_usage (usage_day) VALUES (d) ON CONFLICT (usage_day) DO NOTHING;
  INSERT INTO public.routes_api_layover_session_usage (session_id, user_id) VALUES (p_session_id, p_user_id) ON CONFLICT (session_id) DO NOTHING;
  INSERT INTO public.routes_api_layover_user_daily_usage (usage_day, user_id) VALUES (d, p_user_id) ON CONFLICT (usage_day, user_id) DO NOTHING;

  -- ONE lock order for every spender: the day first (as 3973's), then the session, then the user.
  SELECT u.calls, u.spend_micros INTO day_calls, day_spend FROM public.routes_api_daily_usage u WHERE u.usage_day = d FOR UPDATE;
  SELECT s.calls INTO session_calls FROM public.routes_api_layover_session_usage s WHERE s.session_id = p_session_id FOR UPDATE;
  SELECT p.calls INTO user_calls FROM public.routes_api_layover_user_daily_usage p WHERE p.usage_day = d AND p.user_id = p_user_id FOR UPDATE;

  IF day_calls + 1 > p_quota THEN RETURN 'quota_exhausted'; END IF;
  IF day_spend + p_cost_micros > p_budget_micros THEN RETURN 'budget_exhausted'; END IF;
  IF session_calls + 1 > p_session_cap THEN RETURN 'session_share_exhausted'; END IF;
  IF user_calls + 1 > p_user_daily_cap THEN RETURN 'user_share_exhausted'; END IF;

  UPDATE public.routes_api_daily_usage u SET calls = u.calls + 1, spend_micros = u.spend_micros + p_cost_micros, updated_at = now() WHERE u.usage_day = d;
  UPDATE public.routes_api_layover_session_usage s SET calls = s.calls + 1, updated_at = now() WHERE s.session_id = p_session_id;
  UPDATE public.routes_api_layover_user_daily_usage p SET calls = p.calls + 1, updated_at = now() WHERE p.usage_day = d AND p.user_id = p_user_id;
  RETURN 'granted';
END
$fn$;

COMMENT ON FUNCTION public.routes_api_try_spend_layover(integer, bigint, bigint, uuid, uuid, integer, integer) IS
  '3856 (owner decision R5): take one Google Routes call from today''s (UTC) shared quota and hard budget (3971''s day row) AND from this layover session''s and this person''s layover shares, atomically across instances (rows locked day → session → user), or take none. Answers granted | off | unscoped | unavailable | quota_exhausted | budget_exhausted | session_share_exhausted | user_share_exhausted. A refusal changes no counter. service_role only.';

REVOKE ALL ON FUNCTION public.routes_api_try_spend_layover(integer, bigint, bigint, uuid, uuid, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.routes_api_try_spend_layover(integer, bigint, bigint, uuid, uuid, integer, integer) TO service_role;

COMMIT;

-- ── Postconditions (separate transaction: they assert what persisted) ───────
DO $post$
DECLARE n int;
BEGIN
  IF to_regclass('public.routes_api_layover_session_usage') IS NULL OR to_regclass('public.routes_api_layover_user_daily_usage') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3856): a layover Routes usage table was not created';
  END IF;
  IF has_table_privilege('authenticated', 'public.routes_api_layover_session_usage', 'SELECT')
     OR has_table_privilege('authenticated', 'public.routes_api_layover_user_daily_usage', 'SELECT')
     OR has_table_privilege('anon', 'public.routes_api_layover_session_usage', 'SELECT')
     OR has_table_privilege('anon', 'public.routes_api_layover_user_daily_usage', 'SELECT') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3856): a client role can read a layover Routes usage table';
  END IF;
  IF has_function_privilege('authenticated', 'public.routes_api_try_spend_layover(integer, bigint, bigint, uuid, uuid, integer, integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.routes_api_try_spend_layover(integer, bigint, bigint, uuid, uuid, integer, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3856): a client role can spend';
  END IF;
  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid IN ('public.routes_api_layover_session_usage'::regclass, 'public.routes_api_layover_user_daily_usage'::regclass)
     AND contype = 'f' AND confdeltype = 'c';
  IF n <> 3 THEN RAISE EXCEPTION 'POSTCONDITION FAILED (3856): expected 3 ON DELETE CASCADE foreign keys, found %', n; END IF;
  SELECT count(*) INTO n FROM public.feature_flags WHERE flag = 'layover_routed_corridor_enabled' AND enabled = TRUE;
  IF n <> 0 THEN RAISE EXCEPTION 'POSTCONDITION FAILED (3856): layover_routed_corridor_enabled is ON; it is seeded FALSE and turning it on is the owner''s press'; END IF;
  SELECT count(*) INTO n FROM public.feature_flags WHERE flag = 'layover_routed_corridor_enabled';
  IF n <> 1 THEN RAISE EXCEPTION 'POSTCONDITION FAILED (3856): layover_routed_corridor_enabled is not seeded'; END IF;
  -- An unconfigured call spends nothing and says so; an unscoped one likewise.
  IF public.routes_api_try_spend_layover(0, 1, 1, gen_random_uuid(), gen_random_uuid(), 1, 1) <> 'off' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3856): an unconfigured spend was not OFF';
  END IF;
  IF public.routes_api_try_spend_layover(1, 1, 1, NULL, gen_random_uuid(), 1, 1) <> 'unscoped' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3856): a spend with no user was not unscoped';
  END IF;
END
$post$;
