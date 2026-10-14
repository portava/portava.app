-- 3790_airport_timing_aggregates.sql
-- census-layover L161 ("Aggregate airport timing — may persist after de-identification/aggregation").
-- B58 cluster LAY-R, layover band 3784-3799. APPLIED TO NO DATABASE by the lane that wrote it.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THIS ADDS
-- ══════════════════════════════════════════════════════════════════════════════
-- 1. public.airport_timing_aggregates — the de-identified per-airport, per-fact,
--    per-local-hour timing bands folded from EXPIRED community observations in
--    airport_fact_observations (2860, applied). One row is one band of one fold:
--    airport, fact type, local hour, the hour-aligned window the folded readings
--    fall in, how many readings, how many distinct observers, and p50/p75/p90.
--
--    IT HAS NO IDENTIFIER COLUMN, BY CONSTRUCTION. Not an observer handle, not a
--    row id of an observation, not a user, session or profile id, and no instant
--    finer than the hour. The postcondition below asserts the EXACT column set,
--    so a column that could hold one cannot be added by editing this file. The
--    one string that may look like a UUID is `airport_ref`, which is an AIRPORT's
--    id (an airport profile without an IATA code), never a person's.
--
--    THE DISTINCT-OBSERVER FLOOR IS IN THE SCHEMA: CHECK (distinct_observers >= 10).
--    k = 10 is the fail-closed default of owner question OQ-5 (L261 proposal Q8
--    recommends 5; the stricter 10 holds until the owner answers). A band below it
--    is never written: the fold withholds it, the function below refuses it, and
--    this CHECK refuses it.
--
-- 2. public.airport_timing_fold_commit(jsonb, jsonb, uuid[], timestamptz) — the
--    ONE door into the table, and the reason "fold before delete" is a property of
--    the database rather than of two statements issued in order. In ONE
--    transaction it:
--      a. answers {status: disabled} and writes NOTHING unless
--         airport_timing_aggregate_enabled is TRUE (the TypeScript caller checks
--         the same flag first; this is the second gate, not the only one);
--      b. VERIFIES every aggregate against the raw rows it claims: they exist, are
--         community rows of that airport and fact type, are expired, fall inside
--         the aggregate's window, number exactly `sample_count`, come from exactly
--         `distinct_observers` distinct observers, and that count is >= 10. No
--         observation may be claimed by two aggregates, and every claimed row
--         must be among the rows being deleted;
--      c. inserts the aggregates; then
--      d. deletes exactly the given observation ids (community, expired) and
--         RAISES if any of them was no longer there to delete — a concurrent fold
--         or an unexpired row — so the insert above rolls back with it.
--    So an aggregate exists only if its raw rows are gone, and raw rows are gone
--    only if their fold was written. A failed fold deletes nothing; a failed
--    delete writes nothing; two concurrent folds of the same rows commit once.
--    The cutoff is LEAST(caller's cutoff, now()): a caller cannot delete a row
--    that has not expired by naming a future instant.
--    SECURITY INVOKER: it runs with the caller's rights, and only service_role
--    may execute it.
--
-- 3. airport_timing_aggregate_enabled, seeded FALSE. ON: the hourly scheduler
--    (lib/layoverOperationalRetentionScheduler.ts) folds expired community
--    observations and deletes them, raw deleted at expiry with no grace (OQ-5
--    default; the L261 proposal recommends +48 h). DESTRUCTIVE (it deletes
--    airport_fact_observations rows) and it WRITES new data — turning it on is the
--    owner's press. OFF / absent / unreadable (the seed): nothing is read beyond
--    the flag, nothing is written, nothing is deleted.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT IT DOES NOT DO
-- ══════════════════════════════════════════════════════════════════════════════
-- * It feeds NOTHING. No buffer, deadline, rating, ranking or maturity rung reads
--   this table (pinned by src/test/airportTimingAggregate.test.ts). Whether it may
--   is an owner decision, untouched here.
-- * It states NO retention period for the aggregates. None is approved (OQ-5) and
--   none is invented: rows stay until a person deletes them, and this lane writes
--   no job that deletes them.
-- * It writes no row. Nothing is folded until the flag is ON.
--
-- PREREQUISITE: 2860 (airport_fact_observations), applied to production.
-- Rollback: db/rollback/2026-10-14-3790-airport-timing-aggregates-rollback.sql
-- (refuses while the flag is ON or while any aggregate exists: the raw readings an
-- aggregate summarises were deleted when it was written, so it cannot be re-derived).

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3790): public.feature_flags does not exist.';
  END IF;
  IF to_regclass('public.airport_fact_observations') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3790): public.airport_fact_observations does not exist (2860).';
  END IF;
END
$pre$;

CREATE TABLE IF NOT EXISTS public.airport_timing_aggregates (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  airport_ref        text        NOT NULL CHECK (length(airport_ref) BETWEEN 1 AND 64),
  fact_type          text        NOT NULL CHECK (fact_type IN ('checkpoint_timing_minutes', 'queue_report_minutes')),
  local_hour         smallint    NOT NULL CHECK (local_hour BETWEEN 0 AND 23),
  window_start       timestamptz NOT NULL,
  window_end         timestamptz NOT NULL,
  sample_count       integer     NOT NULL,
  distinct_observers integer     NOT NULL,
  p50_minutes        numeric     NOT NULL,
  p75_minutes        numeric     NOT NULL,
  p90_minutes        numeric     NOT NULL,
  truth_version      text        NOT NULL CHECK (length(truth_version) BETWEEN 1 AND 64),
  folded_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT airport_timing_aggregates_k_floor CHECK (distinct_observers >= 10),
  CONSTRAINT airport_timing_aggregates_samples_cover_observers CHECK (sample_count >= distinct_observers),
  CONSTRAINT airport_timing_aggregates_window_ordered CHECK (window_end > window_start),
  CONSTRAINT airport_timing_aggregates_window_hour_aligned CHECK (
    mod(extract(epoch FROM window_start)::bigint, 3600) = 0
    AND mod(extract(epoch FROM window_end)::bigint, 3600) = 0
  ),
  CONSTRAINT airport_timing_aggregates_percentiles_ordered CHECK (
    p50_minutes >= 0 AND p50_minutes <= p75_minutes AND p75_minutes <= p90_minutes
  )
);

COMMENT ON TABLE public.airport_timing_aggregates IS
  'census-layover L161: de-identified per-airport, per-fact, per-local-hour timing bands folded from expired community airport_fact_observations. No identifier column (exact column set asserted by 3790); distinct_observers >= 10 (OQ-5 default) by CHECK. Written only through airport_timing_fold_commit, which deletes the folded raw rows in the same transaction. Feeds no buffer, rating or ranking. No retention period approved (OQ-5). Service_role only.';

ALTER TABLE public.airport_timing_aggregates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.airport_timing_aggregates FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, DELETE ON public.airport_timing_aggregates TO service_role;

CREATE OR REPLACE FUNCTION public.airport_timing_fold_commit(
  p_aggregates      jsonb,
  p_evidence        jsonb,
  p_observation_ids uuid[],
  p_cutoff          timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
  v_cutoff   timestamptz;
  v_agg      jsonb;
  v_ids      uuid[];
  v_n        integer;
  v_d        integer;
  v_claimed  integer := 0;
  v_distinct integer;
  v_inserted integer := 0;
  v_deleted  integer := 0;
  i          integer;
BEGIN
  IF NOT COALESCE((SELECT f.enabled FROM public.feature_flags f WHERE f.flag = 'airport_timing_aggregate_enabled'), false) THEN
    RETURN jsonb_build_object('status', 'disabled', 'inserted', 0, 'deleted', 0);
  END IF;
  IF p_cutoff IS NULL OR p_observation_ids IS NULL OR p_aggregates IS NULL OR p_evidence IS NULL
     OR jsonb_typeof(p_aggregates) <> 'array' OR jsonb_typeof(p_evidence) <> 'array'
     OR jsonb_array_length(p_aggregates) <> jsonb_array_length(p_evidence) THEN
    RAISE EXCEPTION 'airport_timing_fold_commit: aggregates and evidence must be arrays of the same length, with ids and a cutoff'
      USING ERRCODE = '22023';
  END IF;
  v_cutoff := LEAST(p_cutoff, now());
  IF (SELECT count(DISTINCT x) FROM unnest(p_observation_ids) AS x) <> cardinality(p_observation_ids) THEN
    RAISE EXCEPTION 'airport_timing_fold_commit: an observation id is listed twice' USING ERRCODE = '22023';
  END IF;

  FOR i IN 0 .. jsonb_array_length(p_aggregates) - 1 LOOP
    v_agg := p_aggregates -> i;
    IF jsonb_typeof(p_evidence -> i) <> 'array' OR jsonb_array_length(p_evidence -> i) = 0 THEN
      RAISE EXCEPTION 'airport_timing_fold_commit: aggregate % names no observations', i USING ERRCODE = '22023';
    END IF;
    SELECT array_agg(DISTINCT e::uuid) INTO v_ids FROM jsonb_array_elements_text(p_evidence -> i) AS e;
    IF cardinality(v_ids) <> jsonb_array_length(p_evidence -> i) THEN
      RAISE EXCEPTION 'airport_timing_fold_commit: aggregate % names an observation twice', i USING ERRCODE = '22023';
    END IF;
    IF NOT (v_ids <@ p_observation_ids) THEN
      RAISE EXCEPTION 'airport_timing_fold_commit: aggregate % claims an observation that is not being deleted', i USING ERRCODE = '22023';
    END IF;
    SELECT count(*), count(DISTINCT o.observer_id) INTO v_n, v_d
      FROM public.airport_fact_observations o
     WHERE o.id = ANY (v_ids)
       AND o.observer_kind = 'community'
       AND o.airport_ref = (v_agg ->> 'airport_ref')
       AND o.fact_type = (v_agg ->> 'fact_type')
       AND o.expires_at <= v_cutoff
       AND o.observed_at >= (v_agg ->> 'window_start')::timestamptz
       AND o.observed_at < (v_agg ->> 'window_end')::timestamptz;
    IF v_n IS DISTINCT FROM cardinality(v_ids)
       OR v_n IS DISTINCT FROM (v_agg ->> 'sample_count')::integer
       OR v_d IS DISTINCT FROM (v_agg ->> 'distinct_observers')::integer THEN
      RAISE EXCEPTION 'airport_timing_fold_commit: aggregate % does not match the observations it claims (% matching row(s), % distinct observer(s))', i, v_n, v_d
        USING ERRCODE = '22023';
    END IF;
    IF v_d < 10 THEN
      RAISE EXCEPTION 'airport_timing_fold_commit: aggregate % has % distinct observer(s); the floor is 10 (OQ-5)', i, v_d
        USING ERRCODE = '22023';
    END IF;
    v_claimed := v_claimed + v_n;
  END LOOP;

  SELECT count(DISTINCT e) INTO v_distinct
    FROM jsonb_array_elements(p_evidence) AS band, jsonb_array_elements_text(band) AS e;
  IF COALESCE(v_distinct, 0) <> v_claimed THEN
    RAISE EXCEPTION 'airport_timing_fold_commit: an observation is claimed by two aggregates' USING ERRCODE = '22023';
  END IF;

  -- c. the fold, written first …
  INSERT INTO public.airport_timing_aggregates (
    airport_ref, fact_type, local_hour, window_start, window_end,
    sample_count, distinct_observers, p50_minutes, p75_minutes, p90_minutes, truth_version
  )
  SELECT r.airport_ref, r.fact_type, r.local_hour, r.window_start, r.window_end,
         r.sample_count, r.distinct_observers, r.p50_minutes, r.p75_minutes, r.p90_minutes, r.truth_version
    FROM jsonb_to_recordset(p_aggregates) AS r(
      airport_ref text, fact_type text, local_hour smallint, window_start timestamptz, window_end timestamptz,
      sample_count integer, distinct_observers integer, p50_minutes numeric, p75_minutes numeric, p90_minutes numeric,
      truth_version text
    );
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  -- d. … then exactly the raw rows it covers, all or nothing.
  IF cardinality(p_observation_ids) > 0 THEN
    WITH gone AS (
      DELETE FROM public.airport_fact_observations o
       WHERE o.id = ANY (p_observation_ids)
         AND o.observer_kind = 'community'
         AND o.expires_at <= v_cutoff
      RETURNING 1
    )
    SELECT count(*) INTO v_deleted FROM gone;
    IF v_deleted <> cardinality(p_observation_ids) THEN
      RAISE EXCEPTION 'airport_timing_fold_commit: % of % observation(s) were still due; nothing is committed (a concurrent fold, or a row not yet expired)', v_deleted, cardinality(p_observation_ids)
        USING ERRCODE = '40001';
    END IF;
  END IF;

  RETURN jsonb_build_object('status', 'committed', 'inserted', v_inserted, 'deleted', v_deleted);
END
$fn$;

REVOKE ALL ON FUNCTION public.airport_timing_fold_commit(jsonb, jsonb, uuid[], timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.airport_timing_fold_commit(jsonb, jsonb, uuid[], timestamptz) TO service_role;

COMMENT ON FUNCTION public.airport_timing_fold_commit(jsonb, jsonb, uuid[], timestamptz) IS
  'census-layover L161: writes verified de-identified timing aggregates (k >= 10 distinct observers, recounted from the raw rows) and deletes exactly the folded expired community observations, in one transaction. Writes nothing while airport_timing_aggregate_enabled is off. Service_role only.';

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'airport_timing_aggregate_enabled',
    false,
    'Layover L161 aggregate airport timing. ON: each hour, expired community airport_fact_observations are folded into airport_timing_aggregates (per airport, fact type and local hour; a band is written only with >= 10 distinct observers, OQ-5 default) and then deleted, in one transaction (airport_timing_fold_commit): raw deleted at expiry, no grace. Feeds no buffer, rating or ranking. No aggregate retention period is approved. DESTRUCTIVE and writes new data; enabling is an owner decision. REQUIRES 2860 and 3790. OFF / absent (the seed): nothing is read, written or deleted.'
  )
ON CONFLICT (flag) DO NOTHING;

COMMIT;

DO $post$
DECLARE
  cols TEXT[];
BEGIN
  IF to_regclass('public.airport_timing_aggregates') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3790): airport_timing_aggregates was not created.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'airport_timing_aggregates' AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3790): RLS is not enabled on airport_timing_aggregates.';
  END IF;
  -- The point of the table: nothing in it can name a person or a reading.
  SELECT array_agg(column_name::text ORDER BY column_name) INTO cols
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'airport_timing_aggregates';
  IF cols IS DISTINCT FROM ARRAY['airport_ref', 'distinct_observers', 'fact_type', 'folded_at', 'id', 'local_hour',
                                 'p50_minutes', 'p75_minutes', 'p90_minutes', 'sample_count', 'truth_version',
                                 'window_end', 'window_start']::TEXT[] THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3790): airport_timing_aggregates columns are %, not the identifier-free set.', cols;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.airport_timing_aggregates'::regclass
       AND conname = 'airport_timing_aggregates_k_floor'
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ~ 'distinct_observers >= 10'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3790): the distinct-observer floor CHECK (>= 10) is missing.';
  END IF;
  IF has_table_privilege('anon', 'public.airport_timing_aggregates', 'SELECT')
     OR has_table_privilege('anon', 'public.airport_timing_aggregates', 'INSERT')
     OR has_table_privilege('anon', 'public.airport_timing_aggregates', 'UPDATE')
     OR has_table_privilege('anon', 'public.airport_timing_aggregates', 'DELETE')
     OR has_table_privilege('authenticated', 'public.airport_timing_aggregates', 'SELECT')
     OR has_table_privilege('authenticated', 'public.airport_timing_aggregates', 'INSERT')
     OR has_table_privilege('authenticated', 'public.airport_timing_aggregates', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.airport_timing_aggregates', 'DELETE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3790): airport_timing_aggregates is reachable by anon/authenticated.';
  END IF;
  IF has_table_privilege('service_role', 'public.airport_timing_aggregates', 'UPDATE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3790): an aggregate is a record of a fold and must not be rewritten (service_role holds UPDATE).';
  END IF;
  IF to_regprocedure('public.airport_timing_fold_commit(jsonb, jsonb, uuid[], timestamptz)') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3790): airport_timing_fold_commit was not created.';
  END IF;
  IF has_function_privilege('anon', 'public.airport_timing_fold_commit(jsonb, jsonb, uuid[], timestamptz)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.airport_timing_fold_commit(jsonb, jsonb, uuid[], timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3790): airport_timing_fold_commit is executable by anon/authenticated.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = to_regprocedure('public.airport_timing_fold_commit(jsonb, jsonb, uuid[], timestamptz)')
       AND (p.prosecdef OR p.proacl IS NULL
            OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'))
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3790): airport_timing_fold_commit is SECURITY DEFINER or executable by PUBLIC.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'airport_timing_aggregate_enabled') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3790): airport_timing_aggregate_enabled has no feature_flags row.';
  END IF;
END
$post$;
