-- 3561_compass_search_signal_log.sql
--
-- Port the Compass search-signal decay objects (compass_search_signal_log and
-- upsert_compass_search_signal) into the canonical chain, reviewed, with
-- collection held behind SEARCH_SIGNAL_DECAY_DAYS and the retention period left
-- UNSET for the owner.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band; FLAGS lane, 3561).
-- Creates one table, one index, one RLS policy and two functions (one
-- SECURITY DEFINER, one INVOKER). Writes no
-- row and flips no flag.
--
-- ── WHAT IS WRONG TODAY ─────────────────────────────────────────────────────
-- 2306_search_signal_decay_flag_row.sql states it: decay is wired end to end in
-- TypeScript (compass/CompassSearchDecayService.ts,
-- lib/compassSearchDecayFlushScheduler.ts) and none of its database objects
-- exist. Their DDL sits only in the FROZEN, never-applied root
--     artifacts/api-server/supabase/migrations/20260812_compass_search_signal_log.sql
-- and 2306's own header names the step before the flag may move: "Port that
-- DDL into the canonical chain first, reviewed on its own merits". On the
-- testing database (read-only listing 2026-10-03) neither object exists, so
-- every POST /compass/signals/search nudge warns 42883 and no decay is applied.
--
-- ── WHAT IS PORTED, AND WHAT IS CHANGED ON REVIEW ───────────────────────────
-- Ported as designed: one row per (user_id, category); search_weight is the
-- accumulated effective nudge; last_nudge_at drives on-read decay and is reset
-- by the daily flush; the atomic INSERT ... ON CONFLICT upsert.
-- Changed, each for a reason 2306 or this repo already states:
--   * NOT ported: feature_flags.numeric_value and the flag seed. 2306 moved the
--     reader onto metadata->>'half_life_days' and seeds the row OFF.
--   * Table privileges: the frozen RLS write policy was FOR ALL USING
--     (auth.uid() = user_id) with no WITH CHECK (2306 names it). No client code
--     reads or writes this table (only the service client does: the RPC, the
--     flush scheduler and getDecayedWeights), so anon and authenticated get NO
--     table privilege and an explicit deny policy, following 2490's rule that
--     Supabase's default grants must be revoked by name.
--   * The RPC: SET search_path = '' (the frozen one used public), EXECUTE for
--     service_role only (2973), p_delta must be positive and p_category must
--     satisfy the table's length CHECK.
--   * COLLECTION IS GATED (the reason this is not a plain port). The route
--     (routes/compass.ts) calls logSearchNudge whatever the flag says, so the
--     table would start collecting per-user search categories the moment it
--     exists. That is personal data whose retention period nobody has set, so
--     the RPC records a nudge ONLY while SEARCH_SIGNAL_DECAY_DAYS is present
--     AND enabled = true, and returns false otherwise (true when recorded).
--     2306 seeds the row OFF, so applying this file collects nothing until the
--     flag is deliberately turned on. Absence of the row also collects nothing
--     (stricter than getDecayConfig, which reads an absent row as enabled).
--
-- ── RETENTION: UNSET, AN OWNER DECISION ─────────────────────────────────────
-- Neither the frozen DDL nor any repo design or doc states a retention period
-- for compass_search_signal_log (searched 2026-10-03; the owner's 30-day testing
-- retention covers Discovery recommendation logs only). So:
--   * public.purge_compass_search_signal_log(p_retention interval) is the purge,
--     PARAMETERISED and NOT scheduled. It refuses a NULL or non-positive period
--     instead of guessing one, deletes rows whose last_nudge_at is older than
--     the period, and returns the number deleted. SECURITY INVOKER, EXECUTE for
--     service_role only.
--   * SEARCH_SIGNAL_DECAY_DAYS stays OFF (2306), so nothing is collected.
--   * OWNER DECISION: the retention period for compass_search_signal_log. Once
--     chosen, a scheduler calls the purge with it and the flag may move.
-- Rows also go with the user: user_id REFERENCES auth.users ON DELETE CASCADE.
--
-- Idempotent (IF NOT EXISTS / CREATE OR REPLACE / guarded policy). Postconditions RAISE.
-- Rollback: db/rollback/2026-10-03-3561-compass-search-signal-log-rollback.sql

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION '3561 PRECONDITION FAILED: public.feature_flags is missing.';
  END IF;
  IF to_regprocedure('auth.uid()') IS NULL THEN
    RAISE EXCEPTION '3561 PRECONDITION FAILED: auth.uid() is missing.';
  END IF;
  -- A table of this name that is not this shape would be silently adopted by
  -- CREATE TABLE IF NOT EXISTS; refuse instead.
  -- (Nested, not AND: PL/pgSQL evaluates the ::regclass cast even when the
  -- first operand is false.)
  IF to_regclass('public.compass_search_signal_log') IS NOT NULL THEN
    IF (SELECT count(*) FROM pg_attribute
         WHERE attrelid = to_regclass('public.compass_search_signal_log') AND attnum > 0 AND NOT attisdropped
           AND attname IN ('user_id','category','last_nudge_at','search_weight','created_at')) <> 5 THEN
      RAISE EXCEPTION '3561 PRECONDITION FAILED: public.compass_search_signal_log exists with a different shape.';
    END IF;
  END IF;
END
$pre$;

CREATE TABLE IF NOT EXISTS public.compass_search_signal_log (
  user_id        uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  category       text        NOT NULL CHECK (char_length(category) BETWEEN 1 AND 100),
  last_nudge_at  timestamptz NOT NULL DEFAULT now(),
  search_weight  integer     NOT NULL DEFAULT 1 CHECK (search_weight >= 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, category)
);

COMMENT ON TABLE public.compass_search_signal_log IS
  '3561: per-(user, category) accumulated Compass search nudge, decayed on read by CompassSearchDecayService and flushed daily by compassSearchDecayFlushScheduler. Written only through upsert_compass_search_signal, which records nothing unless SEARCH_SIGNAL_DECAY_DAYS is enabled. RETENTION PERIOD UNSET (owner decision): purge_compass_search_signal_log(interval) exists and is not scheduled.';

-- The purge filters on last_nudge_at; the PK already leads with user_id, which
-- serves every per-user read (the frozen file's separate user_id index is
-- redundant with it and is not ported).
CREATE INDEX IF NOT EXISTS compass_search_signal_log_last_nudge_at_idx
  ON public.compass_search_signal_log (last_nudge_at);

ALTER TABLE public.compass_search_signal_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.compass_search_signal_log FROM PUBLIC;
REVOKE ALL ON TABLE public.compass_search_signal_log FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.compass_search_signal_log TO service_role;

DO $pol$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE schemaname = 'public' AND tablename = 'compass_search_signal_log'
                    AND policyname = 'cssl_deny_client_roles') THEN
    CREATE POLICY cssl_deny_client_roles ON public.compass_search_signal_log
      AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
  END IF;
END
$pol$;

-- The frozen definition RETURNS void; CREATE OR REPLACE cannot change a return
-- type, so a database that ever ran the frozen file gets it dropped first.
DO $drop_frozen$
BEGIN
  IF to_regprocedure('public.upsert_compass_search_signal(uuid,text,integer)') IS NOT NULL
     AND (SELECT prorettype FROM pg_proc
           WHERE oid = to_regprocedure('public.upsert_compass_search_signal(uuid,text,integer)')) <> 'boolean'::regtype THEN
    DROP FUNCTION public.upsert_compass_search_signal(uuid, text, integer);
    RAISE NOTICE '3561: dropped the frozen void upsert_compass_search_signal before re-creating it.';
  END IF;
END
$drop_frozen$;

CREATE OR REPLACE FUNCTION public.upsert_compass_search_signal(
  p_user_id  uuid,
  p_category text,
  p_delta    integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
BEGIN
  -- Defense in depth, kept from the frozen body: a non-service caller may only
  -- write for itself. EXECUTE is service_role's alone below, so this is the
  -- second line, not the first.
  IF coalesce(current_setting('role', true), '') NOT IN ('service_role', 'supabase_admin')
     AND auth.uid() IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'unauthorized: cannot write signal for another user' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL OR p_category IS NULL THEN
    RAISE EXCEPTION 'upsert_compass_search_signal: p_user_id and p_category are required' USING ERRCODE = '22004';
  END IF;
  IF p_delta IS NULL OR p_delta <= 0 THEN
    RAISE EXCEPTION 'upsert_compass_search_signal: p_delta must be positive (got %)', p_delta USING ERRCODE = '22023';
  END IF;

  -- Collection gate: nothing is recorded unless decay is deliberately ON. The
  -- retention period for this table is an open owner decision (see header).
  IF NOT coalesce((SELECT ff.enabled FROM public.feature_flags ff
                    WHERE ff.flag = 'SEARCH_SIGNAL_DECAY_DAYS'), false) THEN
    RETURN false;
  END IF;

  INSERT INTO public.compass_search_signal_log AS l (user_id, category, last_nudge_at, search_weight)
  VALUES (p_user_id, p_category, now(), p_delta)
  ON CONFLICT (user_id, category) DO UPDATE
    SET search_weight = l.search_weight + EXCLUDED.search_weight,
        last_nudge_at = now();
  RETURN true;
END;
$fn$;

COMMENT ON FUNCTION public.upsert_compass_search_signal(uuid, text, integer) IS
  '3561: atomic Compass search-nudge upsert (ported from the frozen 20260812 root, reviewed). Records ONLY while feature_flags SEARCH_SIGNAL_DECAY_DAYS is present and enabled; returns true when recorded, false when collection is off. service_role only.';

REVOKE ALL ON FUNCTION public.upsert_compass_search_signal(uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.upsert_compass_search_signal(uuid, text, integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_compass_search_signal(uuid, text, integer) TO service_role;

-- SECURITY INVOKER, not DEFINER: its only caller is service_role, which holds
-- DELETE on the table (granted above), so it needs no owner's rights; and an
-- unscheduled definer function is exactly what check:security-definer-oracles
-- refuses (reachable over PostgREST, referenced by nothing).
CREATE OR REPLACE FUNCTION public.purge_compass_search_signal_log(p_retention interval)
RETURNS bigint
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  n bigint;
BEGIN
  IF p_retention IS NULL OR p_retention <= interval '0' THEN
    RAISE EXCEPTION 'purge_compass_search_signal_log: no retention period given (got %). The retention period for compass_search_signal_log is an open owner decision; this function does not choose one.', p_retention
      USING ERRCODE = '22023';
  END IF;
  DELETE FROM public.compass_search_signal_log WHERE last_nudge_at < now() - p_retention;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$fn$;

COMMENT ON FUNCTION public.purge_compass_search_signal_log(interval) IS
  '3561: deletes compass_search_signal_log rows whose last_nudge_at is older than p_retention and returns the count. Refuses a NULL or non-positive period. NOT scheduled: the retention period is an open owner decision. SECURITY INVOKER; service_role only.';

REVOKE ALL ON FUNCTION public.purge_compass_search_signal_log(interval) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.purge_compass_search_signal_log(interval) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_compass_search_signal_log(interval) TO service_role;

DO $post$
DECLARE
  up regprocedure := to_regprocedure('public.upsert_compass_search_signal(uuid,text,integer)');
  pg regprocedure := to_regprocedure('public.purge_compass_search_signal_log(interval)');
  r  text;
BEGIN
  IF to_regclass('public.compass_search_signal_log') IS NULL THEN
    RAISE EXCEPTION '3561 POSTCONDITION FAILED: compass_search_signal_log is missing.';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.compass_search_signal_log'::regclass) THEN
    RAISE EXCEPTION '3561 POSTCONDITION FAILED: RLS is not enabled on compass_search_signal_log.';
  END IF;
  IF up IS NULL OR pg IS NULL THEN
    RAISE EXCEPTION '3561 POSTCONDITION FAILED: a 3561 function is missing.';
  END IF;
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF has_table_privilege(r, 'public.compass_search_signal_log', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') THEN
      RAISE EXCEPTION '3561 POSTCONDITION FAILED: % holds a privilege on compass_search_signal_log.', r;
    END IF;
    IF has_function_privilege(r, up, 'EXECUTE') OR has_function_privilege(r, pg, 'EXECUTE') THEN
      RAISE EXCEPTION '3561 POSTCONDITION FAILED: % can EXECUTE a 3561 function.', r;
    END IF;
  END LOOP;
  IF (SELECT prosecdef FROM pg_proc WHERE oid = pg) THEN
    RAISE EXCEPTION '3561 POSTCONDITION FAILED: purge_compass_search_signal_log is SECURITY DEFINER; it must run with its caller''s rights.';
  END IF;
  IF (SELECT prorettype FROM pg_proc WHERE oid = up) <> 'boolean'::regtype THEN
    RAISE EXCEPTION '3561 POSTCONDITION FAILED: upsert_compass_search_signal does not return boolean (an older definition survived).';
  END IF;
  IF NOT has_function_privilege('service_role', up, 'EXECUTE') OR NOT has_function_privilege('service_role', pg, 'EXECUTE') THEN
    RAISE EXCEPTION '3561 POSTCONDITION FAILED: service_role cannot EXECUTE a 3561 function.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid IN (up, pg) AND NOT ('search_path=""' = ANY (coalesce(proconfig, '{}')))) THEN
    RAISE EXCEPTION '3561 POSTCONDITION FAILED: a 3561 function does not pin search_path.';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'upsert_compass_search_signal') <> 1 THEN
    RAISE EXCEPTION '3561 POSTCONDITION FAILED: public.upsert_compass_search_signal has more than one overload.';
  END IF;
  -- This file must not move the flag: the retention period is still unset.
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'SEARCH_SIGNAL_DECAY_DAYS' AND enabled) THEN
    RAISE NOTICE '3561: SEARCH_SIGNAL_DECAY_DAYS is ON on this database, so search nudges ARE being recorded; the retention period is still an owner decision.';
  END IF;
END
$post$;

COMMIT;
