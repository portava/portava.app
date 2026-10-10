-- 3704_compass_live_search_quota.sql
-- Lead ruling CPH-08-ADAPT (2026-10-07; census-compass CPH-08): Compass's
-- search_places / search_events may consult a LIVE provider (Foursquare /
-- Ticketmaster) at tool time — behind a flag seeded FALSE, a per-person daily
-- quota of 5, and the D-67 identity rule for anything labelled live.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (lane L band 3700-3719). APPLIED TO
-- NO DATABASE by the lane that wrote it. Sequenced by the integration owner.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT IT CREATES
-- ══════════════════════════════════════════════════════════════════════════════
--   compass_live_search_usage   one row per (person, UTC day): how many live
--                               provider searches Compass ran for them that day.
--   compass_live_search_take()  ATOMICALLY takes one unit of the day's quota:
--                               TRUE and the count incremented when the person is
--                               under p_daily_limit, FALSE (and nothing written
--                               beyond the existing row) when they are not. One
--                               INSERT … ON CONFLICT … DO UPDATE … WHERE, so two
--                               concurrent calls cannot both take the last unit.
--   compass_live_search_enabled seeded FALSE.
--
-- POSTURE. RLS on, NO policies, every client privilege revoked (REVOKE ALL from
-- PUBLIC, anon, authenticated); only service_role reads/writes the table and
-- executes the function (SECURITY INVOKER — it runs with service_role's own
-- rights; no definer escalation exists to abuse).
--
-- ACCOUNT DELETION. user_id REFERENCES auth.users(id) ON DELETE CASCADE, the
-- sensing_consent_grants / wall_telemetry_events mechanism (lib/deletionDispositions.ts).
--
-- SPEND. No provider call happens unless the owner BOTH supplies the provider
-- keys AND turns compass_live_search_enabled on (docs/ops/compass-live-search-setup.md).
-- That turn-on is the owner's spend decision; this file decides nothing about it.
--
-- Rollback: db/rollback/2026-10-07-3704-compass-live-search-quota-rollback.sql
-- (refuses while the flag is TRUE; drops the function, the table and the flag row).

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3704): public.feature_flags must exist.';
  END IF;
  IF to_regclass('public.compass_live_search_usage') IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3704): public.compass_live_search_usage already exists; read it before re-running.';
  END IF;
END $pre$;

CREATE TABLE public.compass_live_search_usage (
  user_id    uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  usage_day  date        NOT NULL,
  calls      integer     NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, usage_day),
  CONSTRAINT compass_live_search_usage_calls_check CHECK (calls >= 0)
);

COMMENT ON TABLE public.compass_live_search_usage IS
  'CPH-08-ADAPT: live provider searches Compass ran per person per UTC day (quota 5/day, enforced by compass_live_search_take). Service-role only.';

ALTER TABLE public.compass_live_search_usage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.compass_live_search_usage FROM PUBLIC;
REVOKE ALL ON public.compass_live_search_usage FROM anon;
REVOKE ALL ON public.compass_live_search_usage FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.compass_live_search_usage TO service_role;

CREATE FUNCTION public.compass_live_search_take(p_user_id uuid, p_daily_limit integer)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_calls integer;
BEGIN
  IF p_user_id IS NULL OR p_daily_limit IS NULL OR p_daily_limit < 1 THEN
    RETURN FALSE;
  END IF;
  INSERT INTO public.compass_live_search_usage AS u (user_id, usage_day, calls, updated_at)
  VALUES (p_user_id, (now() AT TIME ZONE 'utc')::date, 1, now())
  ON CONFLICT (user_id, usage_day) DO UPDATE
    SET calls = u.calls + 1, updated_at = now()
    WHERE u.calls < p_daily_limit
  RETURNING u.calls INTO v_calls;
  RETURN v_calls IS NOT NULL;
END
$fn$;

COMMENT ON FUNCTION public.compass_live_search_take(uuid, integer) IS
  'CPH-08-ADAPT: atomically take one unit of the person''s daily live-search quota; TRUE when taken, FALSE when the day''s limit is reached.';

REVOKE ALL ON FUNCTION public.compass_live_search_take(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.compass_live_search_take(uuid, integer) FROM anon;
REVOKE ALL ON FUNCTION public.compass_live_search_take(uuid, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.compass_live_search_take(uuid, integer) TO service_role;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'compass_live_search_enabled',
    FALSE,
    'CPH-08-ADAPT: Compass search_places / search_events also consult Foursquare / Ticketmaster at tool time (5 per person per day; provider listings are never labelled verified live unless matched to a Portava place by D-67). Off: catalog only. Turning it on is the owner''s spend decision.'
  )
ON CONFLICT (flag) DO NOTHING;

COMMIT;

DO $post$
DECLARE
  bad text;
BEGIN
  IF to_regclass('public.compass_live_search_usage') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3704): compass_live_search_usage was not created.';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.compass_live_search_usage'::regclass) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3704): RLS is not enabled on compass_live_search_usage.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.compass_live_search_usage'::regclass) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3704): compass_live_search_usage has a policy; it must be service-role only.';
  END IF;
  SELECT string_agg(format('%s:%s', CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END, a.privilege_type), ', ')
    INTO bad
    FROM pg_class c, LATERAL aclexplode(c.relacl) a
   WHERE c.oid = 'public.compass_live_search_usage'::regclass
     AND (a.grantee = 0 OR a.grantee IN ('anon'::regrole, 'authenticated'::regrole));
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3704): a client role holds privileges on compass_live_search_usage: %.', bad;
  END IF;
  IF has_function_privilege('anon', 'public.compass_live_search_take(uuid, integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.compass_live_search_take(uuid, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3704): a client role can execute compass_live_search_take.';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.compass_live_search_take(uuid, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3704): service_role cannot execute compass_live_search_take.';
  END IF;
  IF (SELECT prosecdef FROM pg_proc WHERE oid = 'public.compass_live_search_take(uuid, integer)'::regprocedure) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3704): compass_live_search_take must be SECURITY INVOKER.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'compass_live_search_enabled' AND enabled IS FALSE) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3704): the compass_live_search_enabled flag row is missing or not FALSE.';
  END IF;
  RAISE NOTICE '3704 postcondition: compass_live_search_usage and compass_live_search_take are service-role only; compass_live_search_enabled is seeded FALSE.';
END $post$;
