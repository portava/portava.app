-- Rollback for 3497_discovery_trend_post_convergence_stored.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3497 DID: created public.discovery_trend_post_groups_v2(timestamptz)
-- and re-created public.rebuild_place_momentum_v2(timestamptz) with the
-- post-after-visit leg behind discovery_trend_post_convergence_enabled.
--
-- WHAT THIS ROLLBACK DOES: refuses while that flag is TRUE (the stored trend
-- would silently lose a leg the owner turned on). Otherwise it restores 3477's
-- rebuild_place_momentum_v2 VERBATIM (the text below is 3477's, byte for
-- byte), drops the helper, and deletes 3497's ledger row. No row is deleted:
-- place_momentum rows already written keep their values and their
-- feature_version names the arithmetic that wrote them; the next rebuild
-- writes 3477's.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'discovery_trend_post_convergence_enabled' AND enabled = TRUE) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3497): discovery_trend_post_convergence_enabled is TRUE. Turn it off deliberately first, then re-run this file.';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.rebuild_place_momentum_v2(p_now timestamptz DEFAULT now())
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public, pg_catalog
AS $fn$
DECLARE
  c_min_exposures CONSTANT integer := 30;  -- TREND_V2_MIN_EXPOSURES
  c_min_groups    CONSTANT integer := 3;   -- TREND_V2_MIN_GROUPS
  c_min_peers     CONSTANT integer := 3;   -- TREND_V2_MIN_PEERS
  c_model         CONSTANT text := 'discovery-trend-state-v2';       -- TREND_STATE_MODEL_VERSION_V2
  c_feature       CONSTANT text := 'discovery-exposure-activity-v3'; -- TREND_FEATURE_VERSION_V2
  c_surface       CONSTANT text := 'discovery';
  v_written integer;
BEGIN
  WITH w AS (SELECT * FROM public.discovery_trend_windows_v2(p_now, 'place')),
  cx AS (SELECT * FROM public.discovery_trend_place_context()),
  r AS (
    SELECT w.*, c.creator_id AS creator, c.cell_key AS ckey, c.city AS pcity, COALESCE(c.content_class, 'standard') AS cls,
           COALESCE(c.trail_ids, ARRAY[]::text[]) AS tids,
           CASE WHEN w.o_recent_exposures >= c_min_exposures THEN w.o_recent_activity / w.o_recent_exposures END AS r_recent,
           CASE WHEN w.o_mid_exposures    >= c_min_exposures THEN w.o_mid_activity    / w.o_mid_exposures    END AS r_mid,
           (w.o_recent_exposures >= c_min_exposures AND w.o_recent_groups >= c_min_groups) AS had_recent,
           (w.o_mid_exposures    >= c_min_exposures AND w.o_mid_groups    >= c_min_groups) AS had_mid,
           (w.o_prior_exposures  >= c_min_exposures AND w.o_prior_groups  >= c_min_groups) AS had_prior
      FROM w LEFT JOIN cx c ON c.place_key = lower(regexp_replace(w.o_key, '^db/', ''))
  ),
  own AS (
    SELECT r.*, CASE WHEN r.had_recent AND r.had_mid THEN r.r_recent / (r.r_mid * r.o_time_of_day_factor) END AS v FROM r
  ),
  -- The creator / Trail / location normalisers: the LARGEST of three peer
  -- medians, each over ≥ c_min_peers OTHER places that have a velocity.
  peer AS (
    SELECT o.*,
      CASE WHEN o.v IS NULL THEN 1::double precision ELSE COALESCE(GREATEST(
        (SELECT CASE WHEN count(*) >= c_min_peers THEN percentile_cont(0.5) WITHIN GROUP (ORDER BY q.v) END
           FROM own q WHERE q.v IS NOT NULL AND q.o_key <> o.o_key AND o.creator IS NOT NULL AND q.creator = o.creator),
        (SELECT CASE WHEN count(*) >= c_min_peers THEN percentile_cont(0.5) WITHIN GROUP (ORDER BY q.v) END
           FROM own q WHERE q.v IS NOT NULL AND q.o_key <> o.o_key AND cardinality(o.tids) > 0 AND q.tids && o.tids),
        (SELECT CASE WHEN count(*) >= c_min_peers THEN percentile_cont(0.5) WITHIN GROUP (ORDER BY q.v) END
           FROM own q WHERE q.v IS NOT NULL AND q.o_key <> o.o_key AND o.ckey IS NOT NULL AND q.ckey = o.ckey)
      ), 1::double precision) END AS pf
      FROM own o
  ),
  classified AS (
    SELECT p.*, p.v / p.pf AS vnorm,
           public.place_momentum_classify_v2(p.had_recent, p.had_mid, p.had_prior, p.v / p.pf) AS state
      FROM peer p
  ),
  final AS (
    SELECT c.*,
           public.place_momentum_driver_v2(c.state, c.o_recent_groups, c.o_recent_save_groups, c.o_recent_trip_groups) AS drv,
           public.place_momentum_lifecycle_v2(c.state, c.cls, c.had_prior, c.o_last_activity_at, p_now) AS life
      FROM classified c
  )
  INSERT INTO public.place_momentum (
    place_id, computed_at, recent_rate, mid_rate, prior_rate, total_weight,
    trend_state, reason, model_version, event_weights, window_ms, thresholds, source_table,
    recent_unique_travelers, window_unique_travelers, source_surface, feature_version,
    recent_exposures, mid_exposures, prior_exposures, recent_groups, mid_groups, prior_groups,
    velocity, time_of_day_factor, peer_factor, lifecycle_state, driver, cell_key, city
  )
  SELECT f.o_key, p_now,
         CASE WHEN f.o_recent_exposures > 0 THEN f.o_recent_activity / f.o_recent_exposures ELSE 0 END,
         CASE WHEN f.o_mid_exposures    > 0 THEN f.o_mid_activity    / f.o_mid_exposures    ELSE 0 END,
         CASE WHEN f.o_prior_exposures  > 0 THEN f.o_prior_activity  / f.o_prior_exposures  ELSE 0 END,
         f.o_recent_activity + f.o_mid_activity + f.o_prior_activity,
         f.state,
         public.place_momentum_reason_v2(f.state, f.drv),
         c_model,
         jsonb_build_object('impression', 0, 'save', 3, 'outcome', 2, 'group_cap', 3),
         jsonb_build_object('recent_ms', 48::bigint * 3600000, 'mid_ms', 168::bigint * 3600000, 'prior_ms', 720::bigint * 3600000),
         jsonb_build_object('min_exposures', c_min_exposures, 'min_groups', c_min_groups, 'min_peers', c_min_peers,
                            'growth_factor', 1.5, 'decline_factor', 0.6, 'sync_ms', 30000, 'launch_ms', 48::bigint * 3600000, 'band_hours', 6),
         'rank_events',
         f.o_recent_travelers, f.o_window_travelers, c_surface, c_feature,
         f.o_recent_exposures, f.o_mid_exposures, f.o_prior_exposures, f.o_recent_groups, f.o_mid_groups, f.o_prior_groups,
         f.vnorm, f.o_time_of_day_factor, f.pf, f.life, f.drv, f.ckey, f.pcity
    FROM final f
  ON CONFLICT (place_id, computed_at) DO UPDATE SET
    recent_rate = EXCLUDED.recent_rate, mid_rate = EXCLUDED.mid_rate, prior_rate = EXCLUDED.prior_rate,
    total_weight = EXCLUDED.total_weight, trend_state = EXCLUDED.trend_state, reason = EXCLUDED.reason,
    model_version = EXCLUDED.model_version, event_weights = EXCLUDED.event_weights, window_ms = EXCLUDED.window_ms,
    thresholds = EXCLUDED.thresholds, recent_unique_travelers = EXCLUDED.recent_unique_travelers,
    window_unique_travelers = EXCLUDED.window_unique_travelers, source_surface = EXCLUDED.source_surface,
    feature_version = EXCLUDED.feature_version, recent_exposures = EXCLUDED.recent_exposures,
    mid_exposures = EXCLUDED.mid_exposures, prior_exposures = EXCLUDED.prior_exposures,
    recent_groups = EXCLUDED.recent_groups, mid_groups = EXCLUDED.mid_groups, prior_groups = EXCLUDED.prior_groups,
    velocity = EXCLUDED.velocity, time_of_day_factor = EXCLUDED.time_of_day_factor, peer_factor = EXCLUDED.peer_factor,
    lifecycle_state = EXCLUDED.lifecycle_state, driver = EXCLUDED.driver, cell_key = EXCLUDED.cell_key, city = EXCLUDED.city;
  GET DIAGNOSTICS v_written = ROW_COUNT;

  -- Local Pulse (DV-29): the same model over each cell, no peer baseline.
  WITH w AS (SELECT * FROM public.discovery_trend_windows_v2(p_now, 'area')),
  cells AS (
    SELECT c.cell_key AS ck, min(c.cell_label COLLATE "C") AS lbl, min(c.city COLLATE "C") AS cty
      FROM public.discovery_trend_place_context() c WHERE c.cell_key IS NOT NULL GROUP BY c.cell_key
  ),
  r AS (
    SELECT w.*, cl.lbl, cl.cty,
           CASE WHEN w.o_recent_exposures >= c_min_exposures THEN w.o_recent_activity / w.o_recent_exposures END AS r_recent,
           CASE WHEN w.o_mid_exposures    >= c_min_exposures THEN w.o_mid_activity    / w.o_mid_exposures    END AS r_mid,
           (w.o_recent_exposures >= c_min_exposures AND w.o_recent_groups >= c_min_groups) AS had_recent,
           (w.o_mid_exposures    >= c_min_exposures AND w.o_mid_groups    >= c_min_groups) AS had_mid,
           (w.o_prior_exposures  >= c_min_exposures AND w.o_prior_groups  >= c_min_groups) AS had_prior
      FROM w LEFT JOIN cells cl ON cl.ck = w.o_key
  ),
  classified AS (
    SELECT r.*, CASE WHEN r.had_recent AND r.had_mid THEN r.r_recent / (r.r_mid * r.o_time_of_day_factor) END AS v FROM r
  ),
  final AS (
    SELECT c.*, public.place_momentum_classify_v2(c.had_recent, c.had_mid, c.had_prior, c.v) AS state FROM classified c
  )
  INSERT INTO public.area_momentum (
    cell_key, cell_label, city, computed_at, recent_rate, mid_rate, prior_rate, total_weight,
    recent_exposures, mid_exposures, prior_exposures, recent_groups, mid_groups, prior_groups,
    velocity, time_of_day_factor, trend_state, driver, recent_unique_travelers, window_unique_travelers,
    model_version, feature_version, window_ms, thresholds, source_table, source_surface
  )
  SELECT f.o_key, f.lbl, f.cty, p_now,
         CASE WHEN f.o_recent_exposures > 0 THEN f.o_recent_activity / f.o_recent_exposures ELSE 0 END,
         CASE WHEN f.o_mid_exposures    > 0 THEN f.o_mid_activity    / f.o_mid_exposures    ELSE 0 END,
         CASE WHEN f.o_prior_exposures  > 0 THEN f.o_prior_activity  / f.o_prior_exposures  ELSE 0 END,
         f.o_recent_activity + f.o_mid_activity + f.o_prior_activity,
         f.o_recent_exposures, f.o_mid_exposures, f.o_prior_exposures, f.o_recent_groups, f.o_mid_groups, f.o_prior_groups,
         f.v, f.o_time_of_day_factor, f.state,
         public.place_momentum_driver_v2(f.state, f.o_recent_groups, f.o_recent_save_groups, f.o_recent_trip_groups),
         f.o_recent_travelers, f.o_window_travelers, c_model, c_feature,
         jsonb_build_object('recent_ms', 48::bigint * 3600000, 'mid_ms', 168::bigint * 3600000, 'prior_ms', 720::bigint * 3600000),
         jsonb_build_object('min_exposures', c_min_exposures, 'min_groups', c_min_groups,
                            'growth_factor', 1.5, 'decline_factor', 0.6, 'sync_ms', 30000, 'launch_ms', 48::bigint * 3600000, 'band_hours', 6),
         'rank_events', c_surface
    FROM final f
  ON CONFLICT (cell_key, computed_at) DO UPDATE SET
    cell_label = EXCLUDED.cell_label, city = EXCLUDED.city, recent_rate = EXCLUDED.recent_rate, mid_rate = EXCLUDED.mid_rate,
    prior_rate = EXCLUDED.prior_rate, total_weight = EXCLUDED.total_weight, recent_exposures = EXCLUDED.recent_exposures,
    mid_exposures = EXCLUDED.mid_exposures, prior_exposures = EXCLUDED.prior_exposures, recent_groups = EXCLUDED.recent_groups,
    mid_groups = EXCLUDED.mid_groups, prior_groups = EXCLUDED.prior_groups, velocity = EXCLUDED.velocity,
    time_of_day_factor = EXCLUDED.time_of_day_factor, trend_state = EXCLUDED.trend_state, driver = EXCLUDED.driver,
    recent_unique_travelers = EXCLUDED.recent_unique_travelers, window_unique_travelers = EXCLUDED.window_unique_travelers,
    model_version = EXCLUDED.model_version, feature_version = EXCLUDED.feature_version, window_ms = EXCLUDED.window_ms,
    thresholds = EXCLUDED.thresholds, source_surface = EXCLUDED.source_surface;

  RETURN v_written;
END
$fn$;
REVOKE ALL ON FUNCTION public.rebuild_place_momentum_v2(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rebuild_place_momentum_v2(timestamptz) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_place_momentum_v2(timestamptz) TO service_role;
DROP FUNCTION IF EXISTS public.discovery_trend_post_groups_v2(timestamptz);

DO $$
BEGIN
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL THEN
    DELETE FROM public.schema_migration_ledger WHERE filename = '3497_discovery_trend_post_convergence_stored.sql';
  END IF;
END $$;

COMMIT;

DO $post$
BEGIN
  IF to_regprocedure('public.discovery_trend_post_groups_v2(timestamptz)') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3497 rollback): discovery_trend_post_groups_v2 still exists.';
  END IF;
  IF position('discovery_trend_post_convergence_enabled' IN pg_get_functiondef('public.rebuild_place_momentum_v2(timestamptz)'::regprocedure)) > 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3497 rollback): rebuild_place_momentum_v2 still reads the post leg.';
  END IF;
END $post$;
