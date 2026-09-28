-- Rollback for 3435_place_momentum_feature_version.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3435 DID
-- =============
-- Added public.place_momentum.feature_version and replaced
-- public.rebuild_place_momentum(timestamptz) with 3417's body plus the write of it.
--
-- WHAT THIS ROLLBACK DOES
-- =======================
-- Restores 3417's function body verbatim (copied from
-- 3417_place_momentum_dismiss_excluded.sql), drops the column, and deletes 3435's
-- schema_migration_ledger row. No row is deleted. What it gives up: a stored row
-- no longer says what one event contributed to it (census-discovery DC-17, §68;
-- src/test/db/placeMomentumFeatureVersion.db.test.ts goes red).

BEGIN;

DO $$
BEGIN
  IF to_regprocedure('public.rebuild_place_momentum(timestamptz)') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3435 rollback): rebuild_place_momentum does not exist.';
  END IF;
END $$;

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
           CASE WHEN outcome = 'save' THEN c_w_save WHEN outcome = 'dismiss' THEN 0 ELSE c_w_outcome END
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
  'p_now. SECURITY INVOKER, service_role only. NOTHING SCHEDULES THIS.'
  ' 3417 (census-discovery DV-25): an outcome of dismiss weighs 0 — the row''s '
  'impression still counts at served_at, the dismissal adds nothing.';

ALTER TABLE public.place_momentum DROP COLUMN IF EXISTS feature_version;

DO $$
BEGIN
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL THEN
    DELETE FROM public.schema_migration_ledger
     WHERE filename = '3435_place_momentum_feature_version.sql';
  END IF;
END $$;

COMMIT;

-- ── Postconditions ──────────────────────────────────────────────────────────
DO $post$
DECLARE d text := pg_get_functiondef('public.rebuild_place_momentum(timestamptz)'::regprocedure);
BEGIN
  IF position('feature_version' IN d) > 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3435 rollback): the function still writes feature_version.';
  END IF;
  IF position('WHEN outcome = ''dismiss'' THEN 0' IN d) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3435 rollback): the restored body is not 3417''s.';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'place_momentum' AND column_name = 'feature_version') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3435 rollback): place_momentum.feature_version still exists.';
  END IF;
END $post$;
