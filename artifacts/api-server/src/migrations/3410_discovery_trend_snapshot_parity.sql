-- 3410_discovery_trend_snapshot_parity.sql
-- Discovery trending and ecosystem lane (census-discovery §58: DC-07, DC-21,
-- DV-33). Repairs what 2892's persisted trend snapshot says, records the unique
-- travellers behind it, and seeds the flag for the read-only trend API.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band; trending lane
-- 3410-3414). APPLIED TO NO SHARED DATABASE by the lane that wrote it: applied,
-- rolled back and re-applied on the local PostgreSQL 16 harness only. NOT
-- applied to portava-ci, NOT applied to production. Depends on 2892.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY — 2892's snapshot is not the reading the product computes
-- ══════════════════════════════════════════════════════════════════════════════
-- 2892 says rebuild_place_momentum "mirrors lib/discoveryTrendState
-- .computeTrendStates". The classifier does. The CORPUS and the EXPLANATION do
-- not, and a stored state that the product would not compute is a false record:
--
--   1. Surface. The TypeScript reading is computed over the rows
--      lib/discoveryLocalMomentum.loadLocalMomentum reads: `surface =
--      'discovery'`. 2892 reads every surface. A `living_page` place view, a
--      pulse or events impression of the same id all count in the snapshot and
--      in nothing the product computes. Same place, same instant, different
--      state.
--   2. Window. The loader admits a row only when `served_at` is inside the
--      30-day window (`.gte("served_at", since)`), and then counts its outcome
--      at `outcome_at`. 2892 also counts an outcome whose impression was served
--      before the window. Mirrored here so the two agree; whether the LOADER
--      should read those outcomes is recorded as a residual in census §58, not
--      changed, because it moves the held flag-2289 scalar and QP-09's plan.
--   3. Explanation. 2892 stores its own sentences ("Activity is accelerating
--      against the past week.") and a sentence for `unknown`. The product's
--      sentences are lib/discoveryTrendState.explainTrendState, and `unknown`
--      has none on purpose: a state that is not a claim must not produce text
--      that reads like one. Two vocabularies for one state is `03` §11 answered
--      twice. The TypeScript text is stored; `unknown` stores NULL.
--
-- WHAT IS ADDED
--   * `recent_unique_travelers`, `window_unique_travelers` — `03` §9 names
--     "unique travelers" as a place-momentum input. They are STORED, not used:
--     the classifier is unchanged and reads none of them. The trend API
--     (routes/discoveryTrending.ts) uses them as its disclosure floor, so a
--     state built from one person's saves is never published as "emerging".
--   * `source_surface` — the corpus the row was computed over. A row written by
--     2892's function carries NULL and is therefore distinguishable from a row
--     computed over the product's corpus; the API reads only 'discovery' rows.
--   * `discovery_trending_api_enabled`, seeded FALSE. The API's gate.
--
-- WHAT IS NOT CHANGED
--   * place_momentum_classify (2892) — the parity suite pins it to the
--     TypeScript classifier and it was already equal.
--   * Weights, windows, thresholds, model_version — byte-identical constants.
--   * Nothing schedules the rebuild, as in 2892. Cadence and retention are an
--     owner question (census §58); inventing either here would be a product
--     number.
--   * No ranking path reads place_momentum. Serving order is untouched.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- `10` §4 — cardinality, index rationale, EXPLAIN
-- ══════════════════════════════════════════════════════════════════════════════
-- No index is created. Three nullable columns on a table that ships empty.
-- The API's two reads use 2892's indexes: the newest run through
-- place_momentum_computed_idx (computed_at DESC LIMIT 1), and the rows of that
-- run for a page of item ids through place_momentum_place_computed_idx
-- (place_id = ANY, computed_at = x). docs/discovery/query-paths.md QP-22.
-- The rebuild's scan narrows from all of rank_events to the Discovery surface,
-- which rank_events_discovery_served_at (3391) serves.
--
-- SECURITY: unchanged from 2892. SECURITY INVOKER, pinned search_path,
-- EXECUTE for service_role only; the table stays service_role only.
--
-- Rollback: db/rollback/2026-09-27-3410-discovery-trend-snapshot-parity-rollback.sql

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3410): public.feature_flags does not exist.';
  END IF;
  IF to_regclass('public.place_momentum') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3410): public.place_momentum does not exist. Apply 2892 first.';
  END IF;
  PERFORM 1 FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'place_momentum' AND column_name = 'trend_state';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3410): public.place_momentum has no trend_state; it is not 2892''s table.';
  END IF;
  PERFORM 1 FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'rank_events' AND column_name = 'surface';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3410): rank_events.surface is missing; the snapshot corpus is scoped by it.';
  END IF;
END $pre$;

ALTER TABLE public.place_momentum
  ADD COLUMN IF NOT EXISTS recent_unique_travelers integer CHECK (recent_unique_travelers IS NULL OR recent_unique_travelers >= 0),
  ADD COLUMN IF NOT EXISTS window_unique_travelers integer CHECK (window_unique_travelers IS NULL OR window_unique_travelers >= 0),
  ADD COLUMN IF NOT EXISTS source_surface text;

COMMENT ON COLUMN public.place_momentum.recent_unique_travelers IS
  '3410: distinct rank_events.user_id behind the events in the recent (48 h) window. `03` §9 "unique travelers". Stored, NOT read by the classifier. The trend API''s disclosure floor. NULL on a row written before 3410.';
COMMENT ON COLUMN public.place_momentum.window_unique_travelers IS
  '3410: distinct rank_events.user_id behind every event in the 30-day window. NULL on a row written before 3410.';
COMMENT ON COLUMN public.place_momentum.source_surface IS
  '3410: the rank_events surface the row was computed over. ''discovery'' is the corpus lib/discoveryLocalMomentum reads. NULL = written by 2892''s function over every surface; not the product''s reading.';

CREATE OR REPLACE FUNCTION public.rebuild_place_momentum(p_now timestamptz DEFAULT now())
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public, pg_catalog
AS $fn$
DECLARE
  -- MIRRORED CONSTANTS. Each names the TypeScript symbol it must equal.
  c_recent_ms  CONSTANT bigint := 48::bigint  * 3600000;  -- TREND_RECENT_MS
  c_mid_ms     CONSTANT bigint := 168::bigint * 3600000;  -- TREND_MID_MS  (7d)
  c_prior_ms   CONSTANT bigint := 720::bigint * 3600000;  -- TREND_PRIOR_MS (30d)
  c_w_impression CONSTANT double precision := 1;  -- TREND_EVENT_WEIGHTS.impression
  c_w_save       CONSTANT double precision := 3;  -- TREND_EVENT_WEIGHTS.save
  c_w_outcome    CONSTANT double precision := 2;  -- TREND_EVENT_WEIGHTS.outcome
  c_model      CONSTANT text := 'discovery-trend-state-v1';
  -- The corpus lib/discoveryLocalMomentum.loadLocalMomentum reads.
  c_surface    CONSTANT text := 'discovery';

  v_mid_windows   double precision := (c_mid_ms   - c_recent_ms)::double precision / c_recent_ms;
  v_prior_windows double precision := (c_prior_ms - c_mid_ms)::double precision   / c_recent_ms;

  v_recent_since timestamptz := p_now - make_interval(secs => c_recent_ms / 1000.0);
  v_mid_since    timestamptz := p_now - make_interval(secs => c_mid_ms    / 1000.0);
  v_prior_since  timestamptz := p_now - make_interval(secs => c_prior_ms  / 1000.0);
  v_written integer;
BEGIN
  WITH base AS (
    -- The loader's read: the Discovery surface, analytics excluded, and a row
    -- admitted only when it was SERVED inside the window.
    SELECT item_id, user_id, outcome, served_at, outcome_at
      FROM public.rank_events
     WHERE surface = c_surface
       AND outcome <> 'analytics'
       AND item_id IS NOT NULL AND served_at IS NOT NULL
       AND served_at >= v_prior_since
  ),
  events AS (
    -- Every row is an impression at served_at …
    SELECT item_id AS place_id, user_id, served_at AS at, c_w_impression AS w FROM base
    UNION ALL
    -- … and, if it converted, an outcome at outcome_at.
    SELECT item_id, user_id, outcome_at,
           CASE WHEN outcome = 'save' THEN c_w_save ELSE c_w_outcome END
      FROM base
     WHERE outcome <> 'impression' AND outcome_at IS NOT NULL
  ),
  bucketed AS (
    SELECT place_id,
           SUM(w) FILTER (WHERE at >= v_recent_since)                         AS recent_w,
           SUM(w) FILTER (WHERE at <  v_recent_since AND at >= v_mid_since)   AS mid_w,
           SUM(w) FILTER (WHERE at <  v_mid_since    AND at >= v_prior_since) AS prior_w,
           count(DISTINCT user_id) FILTER (WHERE at >= v_recent_since)        AS recent_travelers,
           count(DISTINCT user_id)                                            AS window_travelers
      FROM events
     WHERE at <= p_now AND at >= v_prior_since
     GROUP BY place_id
  ),
  rated AS (
    SELECT place_id,
           COALESCE(recent_w, 0)::double precision AS recent_rate,
           CASE WHEN v_mid_windows   > 0 THEN COALESCE(mid_w,   0) / v_mid_windows   ELSE 0 END AS mid_rate,
           CASE WHEN v_prior_windows > 0 THEN COALESCE(prior_w, 0) / v_prior_windows ELSE 0 END AS prior_rate,
           (COALESCE(recent_w,0) + COALESCE(mid_w,0) + COALESCE(prior_w,0))::double precision AS total_weight,
           recent_travelers::integer AS recent_travelers,
           window_travelers::integer AS window_travelers
      FROM bucketed
  ),
  classified AS (
    SELECT r.*, public.place_momentum_classify(r.recent_rate, r.mid_rate, r.prior_rate, r.total_weight) AS state
      FROM rated r
  )
  INSERT INTO public.place_momentum (
    place_id, computed_at, recent_rate, mid_rate, prior_rate, total_weight,
    trend_state, reason, model_version, event_weights, window_ms, thresholds, source_table,
    recent_unique_travelers, window_unique_travelers, source_surface
  )
  SELECT c.place_id,
         p_now,
         c.recent_rate, c.mid_rate, c.prior_rate, c.total_weight,
         c.state,
         -- lib/discoveryTrendState TREND_EXPLANATION, verbatim. `unknown` has no
         -- sentence: NULL, never text that reads like a claim.
         CASE c.state
           WHEN 'emerging'     THEN 'New around here, and starting to get attention.'
           WHEN 'trending'     THEN 'Picking up locally in the last couple of days.'
           WHEN 'established'  THEN 'Consistently busy here, not just this week.'
           WHEN 'cooling'      THEN 'Quieter than it has been recently.'
           WHEN 'rediscovered' THEN 'Getting attention again after a quiet spell.'
           ELSE NULL
         END,
         c_model,
         jsonb_build_object('impression', c_w_impression, 'save', c_w_save, 'outcome', c_w_outcome),
         jsonb_build_object('recent_ms', c_recent_ms, 'mid_ms', c_mid_ms, 'prior_ms', c_prior_ms),
         jsonb_build_object('min_rate', 3, 'growth_factor', 1.5, 'decline_factor', 0.6),
         'rank_events',
         c.recent_travelers, c.window_travelers, c_surface
    FROM classified c
  ON CONFLICT (place_id, computed_at) DO UPDATE SET
    recent_rate             = EXCLUDED.recent_rate,
    mid_rate                = EXCLUDED.mid_rate,
    prior_rate              = EXCLUDED.prior_rate,
    total_weight            = EXCLUDED.total_weight,
    trend_state             = EXCLUDED.trend_state,
    reason                  = EXCLUDED.reason,
    model_version           = EXCLUDED.model_version,
    event_weights           = EXCLUDED.event_weights,
    window_ms               = EXCLUDED.window_ms,
    thresholds              = EXCLUDED.thresholds,
    recent_unique_travelers = EXCLUDED.recent_unique_travelers,
    window_unique_travelers = EXCLUDED.window_unique_travelers,
    source_surface          = EXCLUDED.source_surface;

  GET DIAGNOSTICS v_written = ROW_COUNT;
  RETURN v_written;
END
$fn$;

REVOKE ALL ON FUNCTION public.rebuild_place_momentum(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rebuild_place_momentum(timestamptz) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_place_momentum(timestamptz) TO service_role;

COMMENT ON FUNCTION public.rebuild_place_momentum(timestamptz) IS
  '`10` §10 rebuildability, as an executable (2892; corpus and explanation repaired by 3410). '
  'Recomputes public.place_momentum for p_now over the rows lib/discoveryLocalMomentum '
  'reads: surface ''discovery'', analytics excluded, served inside the 30-day window, an '
  'outcome counted at outcome_at. Stores lib/discoveryTrendState''s own explanation text '
  '(NULL for unknown) and the unique travellers behind each row. Idempotent for a given '
  'p_now. SECURITY INVOKER, service_role only. NOTHING SCHEDULES THIS.';

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'discovery_trending_api_enabled',
    false,
    'Discovery trend API (census-discovery §58, DC-21 / DV-33): GET /v1/discovery/trending/explanations/:recommendationId. ON: a signed-in viewer may read, for the items of a recommendation served to THEM, the trend state and plain-language reason already stored in place_momentum by rebuild_place_momentum, with no rate, weight or score, withheld below the unique-traveller floor and when the snapshot is stale. OFF / absent / unreadable (the seed): the route answers 404 feature_disabled and reads nothing. Publishing trend states is a disclosure decision: turning it on is an owner decision.'
  )
ON CONFLICT (flag) DO NOTHING;

COMMIT;

-- ── Postconditions ──────────────────────────────────────────────────────────
DO $post$
DECLARE n int; src text;
BEGIN
  SELECT count(*) INTO n FROM public.feature_flags WHERE flag = 'discovery_trending_api_enabled';
  IF n <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3410): expected discovery_trending_api_enabled present, found %', n;
  END IF;
  SELECT count(*) INTO n FROM public.feature_flags WHERE flag = 'discovery_trending_api_enabled' AND enabled = TRUE;
  IF n <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3410): discovery_trending_api_enabled is ON. Publishing trend states is an owner decision and this must ship OFF.';
  END IF;

  FOREACH src IN ARRAY ARRAY['recent_unique_travelers','window_unique_travelers','source_surface'] LOOP
    PERFORM 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'place_momentum' AND column_name = src;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3410): place_momentum.% was not added.', src;
    END IF;
  END LOOP;

  SELECT p.prosrc INTO src FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'rebuild_place_momentum';
  IF src IS NULL OR position('surface = c_surface' IN src) = 0 OR position('served_at >= v_prior_since' IN src) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3410): rebuild_place_momentum does not scope its corpus to the Discovery surface and window.';
  END IF;

  IF has_function_privilege('anon', 'public.rebuild_place_momentum(timestamptz)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.rebuild_place_momentum(timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3410): a client role can execute rebuild_place_momentum.';
  END IF;
END $post$;
