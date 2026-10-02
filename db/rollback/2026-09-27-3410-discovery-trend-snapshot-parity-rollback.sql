-- Rollback for 3410_discovery_trend_snapshot_parity.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
-- Rehearsed on the local PostgreSQL 16 harness: apply → rollback → re-apply.
--
-- WHAT 3410 DID
-- =============
--   * ADD COLUMN recent_unique_travelers, window_unique_travelers, source_surface
--     to public.place_momentum (nullable, derived).
--   * CREATE OR REPLACE public.rebuild_place_momentum(timestamptz): the corpus
--     scoped to surface 'discovery' and to rows served inside the window, the
--     explanation text made lib/discoveryTrendState's, the travellers counted.
--   * INSERT ONE ROW into public.feature_flags:
--       ('discovery_trending_api_enabled', false, '<description>')
--
-- WHAT THIS ROLLBACK DOES
-- =======================
-- Restores 2892's function body VERBATIM (copied from
-- 2892_place_momentum.sql:423-525, including its all-surfaces corpus), drops the
-- three columns, and deletes the flag row — ONLY while the flag is FALSE. If it
-- reads TRUE the owner has turned the trend API on; deleting the row would
-- silently turn it off with no record that the decision was reversed, so the
-- rollback raises instead and the operator decides.
--
-- Nothing irrecoverable is lost: every dropped value is derived from
-- rank_events and is recomputed by a rebuild. Rows written by 3410's function
-- stay in place_momentum with 3410's explanation text; re-running the restored
-- rebuild at the same p_now overwrites them.

BEGIN;

DO $$
DECLARE on_count int;
BEGIN
  SELECT count(*) INTO on_count FROM public.feature_flags
    WHERE flag = 'discovery_trending_api_enabled' AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION
      'ROLLBACK REFUSED (3410): discovery_trending_api_enabled is TRUE. The owner has turned the trend API on since 3410 was applied; deleting the row would silently turn it off. Turn it off deliberately first, then re-run this file.';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.rebuild_place_momentum(p_now timestamptz DEFAULT now())
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER          -- `10` §6: NOT definer. It reads raw behaviour.
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

  -- Window normalisers, in 48-hour units, so the three rates are comparable.
  -- midWindows / priorWindows in computeTrendStates.
  v_mid_windows   double precision := (c_mid_ms   - c_recent_ms)::double precision / c_recent_ms;
  v_prior_windows double precision := (c_prior_ms - c_mid_ms)::double precision   / c_recent_ms;

  v_recent_since timestamptz := p_now - make_interval(secs => c_recent_ms / 1000.0);
  v_mid_since    timestamptz := p_now - make_interval(secs => c_mid_ms    / 1000.0);
  v_prior_since  timestamptz := p_now - make_interval(secs => c_prior_ms  / 1000.0);
  v_written integer;
BEGIN
  WITH events AS (
    -- Every NON-ANALYTICS row is an impression at served_at. outcome='analytics'
    -- rows are ranker bookkeeping, not activity, and are excluded exactly as
    -- computeTrendStates excludes them — counting them would let the ranker's
    -- own writes make a place look popular.
    SELECT item_id AS place_id, served_at AS at, c_w_impression AS w
      FROM public.rank_events
     WHERE outcome <> 'analytics' AND item_id IS NOT NULL AND served_at IS NOT NULL
    UNION ALL
    -- An outcome counts AT ITS OWN TIME, not at the time of the impression that
    -- preceded it. A save made today on an item served three weeks ago is
    -- today's evidence.
    SELECT item_id, outcome_at,
           CASE WHEN outcome = 'save' THEN c_w_save ELSE c_w_outcome END
      FROM public.rank_events
     WHERE outcome <> 'analytics' AND outcome <> 'impression'
       AND item_id IS NOT NULL AND outcome_at IS NOT NULL
  ),
  bucketed AS (
    SELECT place_id,
           -- Rows outside [prior_since, now] are dropped, matching the
           -- TypeScript bucket()'s `at > nowMs || at < priorSince` guard.
           SUM(w) FILTER (WHERE at >= v_recent_since)                       AS recent_w,
           SUM(w) FILTER (WHERE at <  v_recent_since AND at >= v_mid_since) AS mid_w,
           SUM(w) FILTER (WHERE at <  v_mid_since    AND at >= v_prior_since) AS prior_w
      FROM events
     WHERE at <= p_now AND at >= v_prior_since
     GROUP BY place_id
  ),
  rated AS (
    SELECT place_id,
           COALESCE(recent_w, 0)::double precision AS recent_rate,
           CASE WHEN v_mid_windows   > 0 THEN COALESCE(mid_w,   0) / v_mid_windows   ELSE 0 END AS mid_rate,
           CASE WHEN v_prior_windows > 0 THEN COALESCE(prior_w, 0) / v_prior_windows ELSE 0 END AS prior_rate,
           (COALESCE(recent_w,0) + COALESCE(mid_w,0) + COALESCE(prior_w,0))::double precision AS total_weight
      FROM bucketed
  )
  INSERT INTO public.place_momentum (
    place_id, computed_at, recent_rate, mid_rate, prior_rate, total_weight,
    trend_state, reason, model_version, event_weights, window_ms, thresholds, source_table
  )
  SELECT r.place_id,
         p_now,
         r.recent_rate, r.mid_rate, r.prior_rate, r.total_weight,
         public.place_momentum_classify(r.recent_rate, r.mid_rate, r.prior_rate, r.total_weight),
         -- `03` §11 explanation. Fixed text per state, naming nothing.
         CASE public.place_momentum_classify(r.recent_rate, r.mid_rate, r.prior_rate, r.total_weight)
           WHEN 'emerging'     THEN 'Newly active, with no earlier history to compare against.'
           WHEN 'trending'     THEN 'Activity is accelerating against the past week.'
           WHEN 'rediscovered' THEN 'Active again after a quiet week.'
           WHEN 'cooling'      THEN 'Activity has fallen against the past week.'
           WHEN 'established'  THEN 'Sustained activity, neither accelerating nor falling.'
           ELSE                     'Not enough recent activity to say anything.'
         END,
         c_model,
         jsonb_build_object('impression', c_w_impression, 'save', c_w_save, 'outcome', c_w_outcome),
         jsonb_build_object('recent_ms', c_recent_ms, 'mid_ms', c_mid_ms, 'prior_ms', c_prior_ms),
         jsonb_build_object('min_rate', 3, 'growth_factor', 1.5, 'decline_factor', 0.6),
         'rank_events'
    FROM rated r
  ON CONFLICT (place_id, computed_at) DO UPDATE SET
    recent_rate   = EXCLUDED.recent_rate,
    mid_rate      = EXCLUDED.mid_rate,
    prior_rate    = EXCLUDED.prior_rate,
    total_weight  = EXCLUDED.total_weight,
    trend_state   = EXCLUDED.trend_state,
    reason        = EXCLUDED.reason,
    model_version = EXCLUDED.model_version,
    event_weights = EXCLUDED.event_weights,
    window_ms     = EXCLUDED.window_ms,
    thresholds    = EXCLUDED.thresholds;

  GET DIAGNOSTICS v_written = ROW_COUNT;
  RETURN v_written;
END
$fn$;

REVOKE ALL ON FUNCTION public.rebuild_place_momentum(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rebuild_place_momentum(timestamptz) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_place_momentum(timestamptz) TO service_role;

ALTER TABLE public.place_momentum
  DROP COLUMN IF EXISTS recent_unique_travelers,
  DROP COLUMN IF EXISTS window_unique_travelers,
  DROP COLUMN IF EXISTS source_surface;

-- Only the row 3410 wrote (W10-F, census-discovery §87). 3410 inserts ON
-- CONFLICT (flag) DO NOTHING, so a row that existed before it kept its own
-- description. A row whose description is not 3410's seed text byte for
-- byte (the md5 below) was not written by 3410, and is kept.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags
              WHERE flag = 'discovery_trending_api_enabled' AND md5(coalesce(description, '')) <> 'd3f444520ff28c7ceb67779618f0c9b9') THEN
    RAISE NOTICE '3410 rollback: discovery_trending_api_enabled was not written by 3410 (its description is not 3410''s seed), so it is kept.';
  ELSE
    DELETE FROM public.feature_flags
      WHERE flag = 'discovery_trending_api_enabled' AND enabled = FALSE;
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL THEN
    DELETE FROM public.schema_migration_ledger
     WHERE filename = '3410_discovery_trend_snapshot_parity.sql';
  END IF;
END $$;

COMMIT;

-- ── Postconditions ──────────────────────────────────────────────────────────
DO $post$
DECLARE src text;
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'discovery_trending_api_enabled'
                AND md5(coalesce(description, '')) = 'd3f444520ff28c7ceb67779618f0c9b9') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3410 rollback): discovery_trending_api_enabled is still present.';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'place_momentum'
                AND column_name IN ('recent_unique_travelers','window_unique_travelers','source_surface')) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3410 rollback): a 3410 column is still on place_momentum.';
  END IF;
  SELECT p.prosrc INTO src FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'rebuild_place_momentum';
  IF src IS NULL OR position('c_surface' IN src) > 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3410 rollback): rebuild_place_momentum is not 2892''s body.';
  END IF;
END $post$;
