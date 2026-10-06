-- 3501_discovery_recommendations_retention.sql
-- census-discovery §120 — the owner's 30-day TESTING retention for Discovery's
-- per-request serve log (`public.recommendations`, 3376 + 3491), delivered with
-- the logging rather than after it.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band). Needs 3376. Applied
-- by the lane that wrote it to the local PostgreSQL 16 harness only
-- (scripts/local-db); portava-ci (hwokxgbmezheskbzskfr) receives it through
-- CI's own apply on the merge to main. NOT hand-applied to the testing database
-- (ajrurzioarfkagpuxfnb, "production" in this repository's docs): it is applied
-- there in chain order after 3376, by the lane that applies that chain.
--
-- ── THE DECISION (owner, 2026-09-30, verbatim in census-discovery §120) ───────
-- 3376 is approved for the testing database WITH discovery_serve_log_enabled
-- ON, and with a 30-day testing retention for these recommendation logs:
-- "Implement and schedule cleanup using the appropriate record timestamp …
-- Deliver logging and cleanup together rather than leaving records to
-- accumulate indefinitely or disabling the feature … This decision covers
-- recommendation logs in testing only. It does not set retention for financial
-- records or other data."
--
-- So this file is the schema half of that cleanup, and it is scoped to exactly
-- ONE table. It sets no retention for rank_events, creator_attributions,
-- creator_earning_entries or anything else, and the 30 days is labelled a
-- TESTING retention period wherever it is stored. A real production launch
-- needs its own retention decision (3376's "exact retention must be decided
-- with privacy/legal review" still stands for that).
--
-- ── WHAT ────────────────────────────────────────────────────────────────────
--   1. recommendations_created_at — an index on the retention clock.
--   2. discovery_serve_log_retention_enabled — a feature_flags row, seeded
--      TRUE, whose metadata.keep_days = 30 IS the configurable retention value
--      (the house shape: 3475's discovery_trend_snapshot_retention_enabled).
--   3. discovery_recommendations_retention_cutoff() — the one place the
--      horizon is computed: now() - keep_days. Read by the purge and by the
--      per-request reports (lib/discoveryTraceRead.ts), so the two cannot
--      disagree about where the retained record begins.
--   4. purge_expired_discovery_recommendations(p_batch_size) — deletes at most
--      p_batch_size expired rows and says whether more remain. SECURITY
--      DEFINER: see "WHY DEFINER". Called hourly by
--      lib/discoveryServeLogRetentionScheduler.ts (pg_cron is not installed in
--      the testing database, measured 2026-09-30; the API scheduler is the
--      repository's pattern — 2960, 2789, 2998).
--
-- ── THE RETENTION CLOCK IS created_at, NOT served_at ────────────────────────
-- Both are "when this serve happened" to within milliseconds on every real row:
-- the writer mints served_at from the API's clock and inserts in the same
-- request. They differ in WHO sets them, and that decides it:
--   * created_at is assigned by the DATABASE (DEFAULT now()). The one writer's
--     door, record_discovery_serve_request, does not name it, and service_role
--     holds no UPDATE, so no caller can set or move it. A row's retention is
--     therefore exactly "30 days from when the database began holding it",
--     which is what a retention period measures.
--   * served_at is a VALUE the API supplies in p_row (a caller may pass its own
--     servedAt; census DC-22). A skewed or future served_at would exempt a row
--     from a served_at sweep indefinitely, and a far-past one would delete a row
--     the moment it landed. The harness suites write served_at in 2024 and 2031
--     for exactly that reason: it is a field, not a clock.
-- The reports window on served_at; since served_at <= created_at on every row
-- the writer produces (it is minted before the insert), a horizon on
-- created_at never removes a row whose served_at is inside the horizon.
-- 3376's recommendations_served_at index stays: it serves those reports.
--
-- THE BOUNDARY: a row is expired when created_at < now() - keep_days. A row
-- exactly keep_days old is kept. now() is the transaction's start, not
-- clock_timestamp(): a long transaction can only make the cutoff EARLIER, i.e.
-- delete less, never more.
--
-- ── WHAT HAPPENS TO WHAT REFERS TO AN EXPIRED ROW ───────────────────────────
-- Measured, not assumed (every migration and src/ reference to
-- `recommendations` / `serveId` / `recommendation_id`, 2026-09-30):
--   * NO FOREIGN KEY references public.recommendations. The purge re-checks this
--     on every call and REFUSES if one appears, so a later FK — with whatever
--     ON DELETE it chooses — forces this rule to be revisited instead of being
--     silently cascaded into or tripped over.
--   * rank_events rows of a signed-in serve name their request in
--     features->>'serveId' (a JSON value, not a key any constraint enforces).
--     They are NOT deleted and NOT rewritten: rank_events is not serve-log data
--     under this rule — the same row carries the OUTCOME (the outcome route moves
--     impression -> tap/save on that row), 3420's receipts, dwell rows, and is
--     what creator attribution binds to. Nulling serveId would rewrite history
--     and destroy the grouping the trace report still uses (serveId +
--     servedCount on the exposure are their own denominator). So the reference
--     is kept verbatim and simply resolves to "no request row" past the horizon,
--     which the one reader that resolves it now reports as UNOBSERVED rather
--     than as a missing row (lib/discoveryTraceRead.ts).
--   * creator_attributions.recommendation_id (3386) names a rank_events
--     EXPOSURE id (2891's per-item token, recommendationIdFor), never a
--     recommendations.id (serveIdFor, per request). Its trigger checks
--     rank_events; lib/creatorServedRecommendation.ts binds against rank_events.
--     The purge's only DELETE names public.recommendations, and no FK or trigger
--     leads from it to rank_events, creator_attributions or
--     creator_earning_entries, so no attribution, outcome, receipt or earning
--     row is reachable from this purge at all. That is how the financial link
--     is protected: by scope, re-asserted at runtime (the FK refusal above) and
--     in the harness suite (src/test/db/discoveryServeLogRetention.db.test.ts),
--     which counts every one of those tables before and after a purge.
--   * The account-erasure cascade (user_id ON DELETE CASCADE) is untouched.
--
-- ── WHY DEFINER ─────────────────────────────────────────────────────────────
-- 3376 made the table append-only for service_role (SELECT + INSERT, never
-- UPDATE or DELETE) and its postcondition asserts it; certification re-runs that
-- postcondition. Granting DELETE would break it and would let any service-role
-- code path delete any row. Instead the ONLY delete service_role can cause is
-- this function's: expired rows, a bounded batch at a time, behind the flag.
-- search_path is pinned to '' (every name is schema-qualified), EXECUTE is
-- revoked from PUBLIC, anon and authenticated explicitly (Supabase's default
-- privileges grant the last two at CREATE, and REVOKE FROM PUBLIC does not
-- reach a role-specific grant — docs/migrations.md), and granted to
-- service_role alone. It takes no timestamp argument on purpose: a p_now would
-- let a caller move the horizon forward and delete recent rows.
--
-- ── `10` §4 — cardinality, index, EXPLAIN ───────────────────────────────────
-- recommendations_created_at: one entry per row (the table's cardinality: one
-- row per served request while discovery_serve_log_enabled is on). Its one path
-- is the purge's `WHERE created_at < $cutoff ORDER BY created_at LIMIT n` and
-- the "more remain?" probe, both leading-edge range scans. EXPLAIN (harness,
-- 2026-09-30, enable_seqscan=off): Bitmap Index Scan on
-- recommendations_created_at, Index Cond: (created_at < (now() - '30 days')) —
-- usable by its stated predicate; on a harness table the plan says nothing
-- about production cost.
--
-- Rollback: db/rollback/2026-09-30-3501-discovery-recommendations-retention-rollback.sql
-- (drops both functions, the index and the flag row, and deletes this file's
-- ledger row; REFUSES while discovery_serve_log_enabled is ON, because that
-- would leave the logging running with no retention — the state the owner
-- ruled out).

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.recommendations') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3501): public.recommendations does not exist; apply 3376 first.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'recommendations'
                    AND column_name = 'created_at' AND data_type = 'timestamp with time zone'
                    AND is_nullable = 'NO') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3501): recommendations.created_at is not the NOT NULL timestamptz 3376 created; this file''s retention clock is that column.';
  END IF;
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3501): public.feature_flags does not exist.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
              WHERE contype = 'f' AND confrelid = 'public.recommendations'::regclass) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3501): a foreign key references public.recommendations; this file reasons that none does. Decide what an expired row means for it first.';
  END IF;
END $pre$;

-- ── 1. The retention clock's index ──────────────────────────────────────────
CREATE INDEX IF NOT EXISTS recommendations_created_at
  ON public.recommendations (created_at);
COMMENT ON INDEX public.recommendations_created_at IS
  '3501 (census-discovery §120): the retention clock. Serves purge_expired_discovery_recommendations'' range scan on created_at.';

-- ── 2. The configurable value ───────────────────────────────────────────────
-- ON CONFLICT DO NOTHING: a re-run never overwrites a keep_days somebody changed.
INSERT INTO public.feature_flags (flag, enabled, description, metadata) VALUES (
  'discovery_serve_log_retention_enabled',
  TRUE,
  'Discovery serve log (census-discovery §120, 3501): TESTING retention for public.recommendations ONLY. ON: lib/discoveryServeLogRetentionScheduler.ts calls purge_expired_discovery_recommendations hourly, deleting rows whose created_at is older than metadata.keep_days (30 — the owner''s testing retention period, 2026-09-30). Not a retention policy for rank_events, creator attribution, financial records or any other data. OFF: nothing is purged and the scheduler reports the job as failing, because the owner ruled out logging without cleanup.',
  '{"keep_days": 30, "retention_scope": "testing", "applies_to": "public.recommendations", "clock": "created_at", "decided": "owner 2026-09-30 (census-discovery §120)", "not_a_policy_for": "rank_events, creator_attributions, creator_earning_entries, financial records, any other table"}'::jsonb
)
ON CONFLICT (flag) DO NOTHING;

-- ── 3. The horizon, computed once ───────────────────────────────────────────
-- NULL when the row is absent (no retention configured: nothing is ever purged,
-- so the whole record is present). Computed from keep_days whether or not the
-- flag is ON, because a switched-off purge may already have removed rows older
-- than it: a reader must treat anything before it as possibly purged.
CREATE OR REPLACE FUNCTION public.discovery_recommendations_retention_cutoff()
RETURNS timestamptz
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_meta jsonb;
  v_keep numeric;
BEGIN
  SELECT f.metadata INTO v_meta FROM public.feature_flags f
   WHERE f.flag = 'discovery_serve_log_retention_enabled';
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF v_meta IS NULL OR jsonb_typeof(v_meta -> 'keep_days') IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'discovery_serve_log_retention_enabled.metadata.keep_days is not a number; the retention period is never guessed';
  END IF;
  v_keep := (v_meta ->> 'keep_days')::numeric;
  IF v_keep <> trunc(v_keep) OR v_keep < 1 OR v_keep > 3650 THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = format('discovery_serve_log_retention_enabled.metadata.keep_days must be a whole number of days in 1..3650, found %s', v_keep);
  END IF;
  RETURN now() - make_interval(days => v_keep::integer);
END
$fn$;

REVOKE ALL ON FUNCTION public.discovery_recommendations_retention_cutoff() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.discovery_recommendations_retention_cutoff() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.discovery_recommendations_retention_cutoff() TO service_role;
COMMENT ON FUNCTION public.discovery_recommendations_retention_cutoff() IS
  '3501 (census-discovery §120): now() - keep_days of discovery_serve_log_retention_enabled (the owner''s 30-day TESTING retention for public.recommendations). A row with created_at before this may have been purged; at or after it, it is kept. NULL when no retention is configured. Raises on an invalid keep_days.';

-- ── 4. The purge ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.purge_expired_discovery_recommendations(p_batch_size integer)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_enabled boolean;
  v_cutoff  timestamptz;
  v_deleted bigint;
  v_more    boolean;
BEGIN
  IF p_batch_size IS NULL OR p_batch_size < 1 OR p_batch_size > 10000 THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = format('purge_expired_discovery_recommendations: p_batch_size must be 1..10000, got %s', p_batch_size);
  END IF;
  -- The dependent-row rule rests on there being no FK into this table.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
              WHERE contype = 'f' AND confrelid = 'public.recommendations'::regclass) THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'purge_expired_discovery_recommendations: a foreign key now references public.recommendations; 3501''s dependent-row rule assumed none. Nothing was deleted.';
  END IF;

  SELECT f.enabled INTO v_enabled FROM public.feature_flags f
   WHERE f.flag = 'discovery_serve_log_retention_enabled';
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002',
      MESSAGE = 'purge_expired_discovery_recommendations: discovery_serve_log_retention_enabled is absent; the retention period is never guessed. Nothing was deleted.';
  END IF;
  v_cutoff := public.discovery_recommendations_retention_cutoff();   -- raises on a bad keep_days
  IF v_enabled IS NOT TRUE THEN
    RETURN jsonb_build_object('status', 'disabled', 'deleted', 0, 'more', NULL,
                              'cutoff', v_cutoff, 'batch_size', p_batch_size);
  END IF;

  WITH doomed AS (
    SELECT r.id FROM public.recommendations r
     WHERE r.created_at < v_cutoff
     ORDER BY r.created_at
     LIMIT p_batch_size
       FOR UPDATE SKIP LOCKED
  ), gone AS (
    DELETE FROM public.recommendations r USING doomed d
     WHERE r.id = d.id
    RETURNING 1
  )
  SELECT count(*) INTO v_deleted FROM gone;

  v_more := EXISTS (SELECT 1 FROM public.recommendations r WHERE r.created_at < v_cutoff);

  RETURN jsonb_build_object('status', 'purged', 'deleted', v_deleted, 'more', v_more,
                            'cutoff', v_cutoff, 'batch_size', p_batch_size);
END
$fn$;

REVOKE ALL ON FUNCTION public.purge_expired_discovery_recommendations(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.purge_expired_discovery_recommendations(integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_expired_discovery_recommendations(integer) TO service_role;
COMMENT ON FUNCTION public.purge_expired_discovery_recommendations(integer) IS
  '3501 (census-discovery §120): the owner''s 30-day TESTING retention for public.recommendations. Deletes at most p_batch_size rows with created_at < discovery_recommendations_retention_cutoff(), oldest first, and answers {status, deleted, more, cutoff, batch_size}; status disabled deletes nothing. Touches no other table. SECURITY DEFINER because service_role holds no DELETE on the append-only table; service_role EXECUTE only. Called by lib/discoveryServeLogRetentionScheduler.ts.';

-- ── Behavioural postconditions, INSIDE the applying transaction ────────────
-- These write (probes rolled back by their own exception blocks), so they run
-- before COMMIT — 3376's rule.
DO $probe$
DECLARE
  v_res   jsonb;
  v_old   text := 'AAAAAAAAAAAAAAAAAA3501';
  v_edge  text := 'BBBBBBBBBBBBBBBBBB3501';
  v_new   text := 'CCCCCCCCCCCCCCCCCC3501';
BEGIN
  BEGIN
    -- Run against the seeded 30 days whatever this database's row says.
    UPDATE public.feature_flags
       SET enabled = TRUE, metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{keep_days}', '30')
     WHERE flag = 'discovery_serve_log_retention_enabled';
    -- Whatever this database already holds past the horizon goes first (bounded;
    -- rolled back with the block), so the batch-of-one call below meets only v_old.
    FOR i IN 1..1000 LOOP
      v_res := public.purge_expired_discovery_recommendations(10000);
      EXIT WHEN NOT (v_res ->> 'more')::boolean;
    END LOOP;
    INSERT INTO public.recommendations (id, user_id, viewer_class, session_id, surface, serve_point, model_version, served_count, served_at, created_at) VALUES
      (v_old,  NULL, 'anonymous', gen_random_uuid(), 'discovery', 1, 'probe', 0, now(), now() - interval '30 days' - interval '1 second'),
      (v_edge, NULL, 'anonymous', gen_random_uuid(), 'discovery', 1, 'probe', 0, now(), now() - interval '30 days'),
      (v_new,  NULL, 'anonymous', gen_random_uuid(), 'discovery', 1, 'probe', 0, now(), now());
    v_res := public.purge_expired_discovery_recommendations(1);
    IF v_res ->> 'status' <> 'purged' OR (v_res ->> 'deleted')::int <> 1 OR (v_res ->> 'more')::boolean THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3501): one expired probe row and a batch of 1 should answer deleted 1, more false; got %', v_res;
    END IF;
    IF EXISTS (SELECT 1 FROM public.recommendations WHERE id = v_old) THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3501): a row older than 30 days survived the purge.';
    END IF;
    IF (SELECT count(*) FROM public.recommendations WHERE id IN (v_edge, v_new)) <> 2 THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3501): a row exactly 30 days old, or a new row, was purged.';
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'P3501', MESSAGE = 'probe done';
  EXCEPTION
    WHEN SQLSTATE 'P3501' THEN NULL;   -- rolled back with the block: flag row and probes as they were
  END;
END $probe$;

COMMIT;

-- ── Postconditions (separate: they assert what persisted) ──────────────────
DO $post$
DECLARE
  v_meta jsonb;
BEGIN
  IF to_regclass('public.recommendations_created_at') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3501): recommendations_created_at was not created.';
  END IF;
  SELECT metadata INTO v_meta FROM public.feature_flags WHERE flag = 'discovery_serve_log_retention_enabled';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3501): discovery_serve_log_retention_enabled is absent.';
  END IF;
  IF v_meta ->> 'retention_scope' IS DISTINCT FROM 'testing' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3501): the retention row is not labelled a testing retention period.';
  END IF;
  -- The value is valid (the cutoff raises otherwise) — its SIZE is the owner's to change.
  PERFORM public.discovery_recommendations_retention_cutoff();

  IF to_regprocedure('public.purge_expired_discovery_recommendations(integer)') IS NULL
     OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.purge_expired_discovery_recommendations(integer)'::regprocedure) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3501): the purge is missing or not SECURITY DEFINER.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = 'public.purge_expired_discovery_recommendations(integer)'::regprocedure
                    AND proconfig @> ARRAY['search_path=""']) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3501): the purge''s search_path is not pinned.';
  END IF;
  IF has_function_privilege('anon', 'public.purge_expired_discovery_recommendations(integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.purge_expired_discovery_recommendations(integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.discovery_recommendations_retention_cutoff()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.discovery_recommendations_retention_cutoff()', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3501): a client role may EXECUTE a retention function.';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.purge_expired_discovery_recommendations(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3501): service_role may not EXECUTE the purge.';
  END IF;
  -- 3376's append-only posture is unchanged: the purge is the only delete path.
  IF has_table_privilege('service_role', 'public.recommendations', 'DELETE')
     OR has_table_privilege('service_role', 'public.recommendations', 'UPDATE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3501): service_role holds DELETE or UPDATE on recommendations.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.recommendations
              WHERE id IN ('AAAAAAAAAAAAAAAAAA3501', 'BBBBBBBBBBBBBBBBBB3501', 'CCCCCCCCCCCCCCCCCC3501')) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3501): a probe row persisted.';
  END IF;
END $post$;
