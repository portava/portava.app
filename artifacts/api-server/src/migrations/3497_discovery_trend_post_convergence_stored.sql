-- 3497_discovery_trend_post_convergence_stored.sql
-- The stored twin of "visitors post afterward" (census-discovery DV-34, §95.9,
-- lane W11-X3; register D-W11X3-2, D-W11X3-5). It re-creates 3477's
-- `rebuild_place_momentum_v2` so the rows the trend API serves carry the same
-- post-after-visit leg the in-process classifier carries
-- (lib/discoveryTrendPostConvergence + lib/discoveryTrendNormalised
-- `withPostConvergence`), and adds its one helper:
--
--   discovery_trend_post_groups_v2(p_now) → (place key, window, clusters added)
--     A traveller qualifies for a place key and a window when they wrote a
--     `memories` row with state = 'published' AND visibility = 'public' at that
--     place inside the window, strictly AFTER their own earliest positive
--     Discovery outcome there (any outcome but impression, analytics, dismiss).
--     A window counts only with >= 2 distinct qualifying authors (the first
--     k-floor), and then only its authors who are NOT already one of the
--     window's activity actors (3477's `act`, launch window excluded), again
--     only when >= 2 of them remain (the second k-floor). Those new authors
--     are clustered as Sensing clusters them (each at their earliest post in
--     the window; neighbours <= 30 s apart are one cluster), and the cluster
--     count is what the window gains. Only that COUNT leaves the function: no
--     author id is returned or stored.
--
--   rebuild_place_momentum_v2(p_now)
--     3477's body, with three changes and no others (the rollback restores
--     3477's text verbatim; src/test/db/discoveryTrendPostConvergenceStored
--     .db.test.ts S0 holds the flag-OFF rows equal to 3477's own):
--       1. v_post := `discovery_trend_post_convergence_enabled` (3496) AND a
--          `memories` table exists. OFF, absent or unreadable: false.
--       2. The place windows' recent/mid/prior group counts gain the helper's
--          counts; with v_post false the helper is gated by a pseudo-constant
--          qual and never runs, so no Memory is read.
--       3. With v_post true, feature_version is
--          'discovery-exposure-activity-v3+post-after-visit-v1'
--          (lib/discoveryTrendState TREND_FEATURE_VERSION_V2_POST) and
--          `thresholds` gains post_min_authors = 2. OFF: 3477's values.
--     Local Pulse (area_momentum) is unchanged: the in-process leg is a
--     place-level leg, and so is this one.
--
-- WHY A NEW FILE, NOT AN EDIT OF 3477. 3477 is not in the 40(+1)-file set §87
-- certified for portava-ci (docs/ops/discovery-portava-ci-apply-plan.md §1 runs
-- 3338 … 3441), and it is applied to no shared database, so editing it would
-- be allowed. It is lane W10-R1's file with its own harness proof and
-- rollback; a forward file keeps that proof intact, keeps 3477's rollback true,
-- and lets this leg be rolled back on its own (D-W11X3-5).
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band; lane W11-X3,
-- 3495-3499). NOT applied to portava-ci (hwokxgbmezheskbzskfr). NOT applied to
-- travel-buddy (ajrurzioarfkagpuxfnb). Rehearsed on the local PostgreSQL 16
-- harness only. No table, column or index is created.
--
-- `10` §4: the helper reads 3477's rank_events window once more and
-- `memories` by (state, visibility, created_at) — only on a run with the flag
-- ON. At the seed nothing new is read.
--
-- Rollback: db/rollback/2026-09-28-3497-discovery-trend-post-convergence-stored-rollback.sql

BEGIN;

DO $pre$
DECLARE d text;
BEGIN
  IF to_regprocedure('public.rebuild_place_momentum_v2(timestamptz)') IS NULL
     OR to_regprocedure('public.discovery_trend_windows_v2(timestamptz, text)') IS NULL
     OR to_regprocedure('public.discovery_trend_place_context()') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3497): 3476/3477''s v2 functions are missing. Apply 3475, 3476 and 3477 first.';
  END IF;
  d := pg_get_functiondef('public.rebuild_place_momentum_v2(timestamptz)'::regprocedure);
  IF position('c_feature       CONSTANT text := ''discovery-exposure-activity-v3''' IN d) = 0 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3497): rebuild_place_momentum_v2 is not 3477''s (or 3497''s). This file replaces exactly that body.';
  END IF;
END
$pre$;

-- ── The post-after-visit leg (lib/discoveryTrendPostConvergence.postAfterVisitAuthors + withPostConvergence) ──
CREATE OR REPLACE FUNCTION public.discovery_trend_post_groups_v2(p_now timestamptz)
RETURNS TABLE (o_key text, o_win text, o_added integer)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_catalog
AS $fn$
DECLARE
  c_recent_ms   CONSTANT bigint := 48::bigint  * 3600000;  -- TREND_V2_RECENT_MS
  c_mid_ms      CONSTANT bigint := 168::bigint * 3600000;  -- TREND_V2_MID_MS
  c_prior_ms    CONSTANT bigint := 720::bigint * 3600000;  -- TREND_V2_PRIOR_MS
  c_sync_ms     CONSTANT bigint := 30000;                  -- TREND_V2_SYNC_MS
  c_launch_ms   CONSTANT bigint := 48::bigint  * 3600000;  -- TREND_V2_LAUNCH_MS
  c_min_authors CONSTANT integer := 2;                     -- POST_CONVERGENCE_MIN_AUTHORS
  c_surface     CONSTANT text := 'discovery';
  v_now_ms       bigint      := floor(extract(epoch FROM p_now) * 1000)::bigint;
  v_recent_since timestamptz := p_now - make_interval(secs => c_recent_ms / 1000.0);
  v_mid_since    timestamptz := p_now - make_interval(secs => c_mid_ms    / 1000.0);
  v_prior_since  timestamptz := p_now - make_interval(secs => c_prior_ms  / 1000.0);
  v_launch       interval    := make_interval(secs => c_launch_ms / 1000.0);
BEGIN
  RETURN QUERY
  WITH
  ctx AS (SELECT c.place_key AS cpk, c.created_at AS ccreated FROM public.discovery_trend_place_context() c),
  -- 3477's place-level read, exactly.
  base AS (
    SELECT r.item_id AS k, lower(r.user_id::text) AS actor, r.outcome AS oc, r.outcome_at AS oat, x.ccreated AS pcreated
      FROM public.rank_events r
      LEFT JOIN ctx x ON x.cpk = lower(regexp_replace(r.item_id, '^db/', ''))
     WHERE r.surface = c_surface AND r.outcome <> 'analytics'
       AND r.item_id IS NOT NULL AND r.served_at IS NOT NULL
       AND r.served_at >= v_prior_since
  ),
  -- The window's activity actors: 3477's `act` (positive outcome, in range, launch window excluded).
  act AS (
    SELECT DISTINCT b.k,
           CASE WHEN b.oat >= v_recent_since THEN 'recent' WHEN b.oat >= v_mid_since THEN 'mid' ELSE 'prior' END AS win,
           b.actor
      FROM base b
     WHERE b.oc NOT IN ('impression', 'dismiss') AND b.oat IS NOT NULL AND b.oat <= p_now AND b.oat >= v_prior_since
       AND b.actor IS NOT NULL
       AND NOT (b.oat < v_recent_since AND b.pcreated IS NOT NULL AND b.oat >= b.pcreated AND b.oat < b.pcreated + v_launch)
  ),
  -- Each traveller's earliest positive outcome per key: the visit a post must follow.
  visit AS (
    SELECT b.k, lower(regexp_replace(b.k, '^db/', '')) AS place, b.actor,
           min(floor(extract(epoch FROM b.oat) * 1000)::bigint) AS visit_ms
      FROM base b
     WHERE b.oc NOT IN ('impression', 'dismiss') AND b.actor IS NOT NULL AND b.oat IS NOT NULL
       AND floor(extract(epoch FROM b.oat) * 1000)::bigint <= v_now_ms
     GROUP BY b.k, lower(regexp_replace(b.k, '^db/', '')), b.actor
  ),
  -- PUBLISHED and PUBLIC only: the one rung whose audience is the world (compass isPublicWorldMemory).
  post AS (
    -- place_id matched verbatim against the lower-case key, as the loader's `.in("place_id", keys)` matches it.
    SELECT lower(m.owner_id::text) AS author, m.place_id AS place, m.created_at AS at,
           floor(extract(epoch FROM m.created_at) * 1000)::bigint AS at_ms
      FROM public.memories m
     WHERE m.state = 'published' AND m.visibility = 'public'
       AND m.owner_id IS NOT NULL AND m.place_id IS NOT NULL AND m.place_id <> ''
       AND m.created_at <= p_now AND m.created_at >= v_prior_since
  ),
  qual AS (
    SELECT v.k, CASE WHEN p.at >= v_recent_since THEN 'recent' WHEN p.at >= v_mid_since THEN 'mid' ELSE 'prior' END AS win,
           p.author, min(p.at_ms) AS first_ms
      FROM post p JOIN visit v ON v.place = p.place AND v.actor = p.author AND p.at_ms > v.visit_ms
     GROUP BY 1, 2, 3
  ),
  floor1 AS (SELECT q.k, q.win FROM qual q GROUP BY q.k, q.win HAVING count(*) >= c_min_authors),
  fresh AS (
    SELECT q.k, q.win, q.author, q.first_ms
      FROM qual q JOIN floor1 f ON f.k = q.k AND f.win = q.win
     WHERE NOT EXISTS (SELECT 1 FROM act a WHERE a.k = q.k AND a.win = q.win AND a.actor = q.author)
  ),
  floor2 AS (SELECT f.k, f.win FROM fresh f GROUP BY f.k, f.win HAVING count(*) >= c_min_authors),
  -- Sensing's synchronised-behaviour rule over one value (key|post): sorted by
  -- time, neighbours <= 30 s apart are one cluster; every author here is distinct.
  isl AS (
    SELECT f.k, f.win, f.first_ms,
           lag(f.first_ms) OVER (PARTITION BY f.k, f.win ORDER BY f.first_ms, f.author COLLATE "C") AS prev_ms
      FROM fresh f JOIN floor2 g ON g.k = f.k AND g.win = f.win
  )
  SELECT i.k, i.win, (count(*) FILTER (WHERE i.prev_ms IS NULL OR i.first_ms - i.prev_ms > c_sync_ms))::integer
    FROM isl i
   GROUP BY i.k, i.win;
END
$fn$;

-- ── The v2 rebuild, re-created: 3477's body plus the three changes named above ──
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
  c_feature_post  CONSTANT text := 'discovery-exposure-activity-v3+post-after-visit-v1'; -- TREND_FEATURE_VERSION_V2_POST
  c_post_min_authors CONSTANT integer := 2;  -- POST_CONVERGENCE_MIN_AUTHORS
  -- 3497: the post-after-visit leg, only with its flag ON (3496, seeded FALSE)
  -- and a memories table to read. OFF, absent or unreadable: false, and the
  -- rows below are 3477's, value for value.
  v_post boolean := COALESCE((SELECT f.enabled FROM public.feature_flags f WHERE f.flag = 'discovery_trend_post_convergence_enabled'), false)
                    AND to_regclass('public.memories') IS NOT NULL;
  c_surface       CONSTANT text := 'discovery';
  v_written integer;
BEGIN
  WITH w0 AS (SELECT * FROM public.discovery_trend_windows_v2(p_now, 'place')),
  -- 3497: a pseudo-constant qual, so with v_post false the Function Scan never runs.
  pg AS (SELECT g.o_key, g.o_win, g.o_added FROM public.discovery_trend_post_groups_v2(p_now) g WHERE v_post),
  -- The window's group count G gains the post leg's clusters (withPostConvergence); nothing else moves.
  w AS (
    SELECT w0.o_key, w0.o_recent_exposures, w0.o_mid_exposures, w0.o_prior_exposures,
           w0.o_recent_activity, w0.o_mid_activity, w0.o_prior_activity,
           w0.o_recent_groups + COALESCE((SELECT sum(pg.o_added) FROM pg WHERE pg.o_key = w0.o_key AND pg.o_win = 'recent'), 0)::integer AS o_recent_groups,
           w0.o_mid_groups    + COALESCE((SELECT sum(pg.o_added) FROM pg WHERE pg.o_key = w0.o_key AND pg.o_win = 'mid'), 0)::integer    AS o_mid_groups,
           w0.o_prior_groups  + COALESCE((SELECT sum(pg.o_added) FROM pg WHERE pg.o_key = w0.o_key AND pg.o_win = 'prior'), 0)::integer  AS o_prior_groups,
           w0.o_recent_save_groups, w0.o_recent_trip_groups, w0.o_time_of_day_factor,
           w0.o_recent_travelers, w0.o_window_travelers, w0.o_last_activity_at
      FROM w0
  ),
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
                            'growth_factor', 1.5, 'decline_factor', 0.6, 'sync_ms', 30000, 'launch_ms', 48::bigint * 3600000, 'band_hours', 6)
           || CASE WHEN v_post THEN jsonb_build_object('post_min_authors', c_post_min_authors) ELSE '{}'::jsonb END,
         'rank_events',
         f.o_recent_travelers, f.o_window_travelers, c_surface, CASE WHEN v_post THEN c_feature_post ELSE c_feature END,
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

REVOKE ALL ON FUNCTION public.discovery_trend_post_groups_v2(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.discovery_trend_post_groups_v2(timestamptz) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.discovery_trend_post_groups_v2(timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.rebuild_place_momentum_v2(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rebuild_place_momentum_v2(timestamptz) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_place_momentum_v2(timestamptz) TO service_role;
COMMENT ON FUNCTION public.discovery_trend_post_groups_v2(timestamptz) IS
  '3497 (census-discovery DV-34, §95.9): per place key and window, the independence clusters of travellers who published a PUBLIC Memory there after their own positive Discovery outcome and are not already the window''s activity actors — k-floored at 2 distinct authors, twice. Returns counts only. Called only by rebuild_place_momentum_v2 while discovery_trend_post_convergence_enabled (3496, FALSE) is ON.';

COMMIT;

-- ── Postconditions (read-only) ──────────────────────────────────────────────
DO $post$
DECLARE d text; v_role text;
BEGIN
  IF to_regprocedure('public.discovery_trend_post_groups_v2(timestamptz)') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3497): discovery_trend_post_groups_v2 is absent.';
  END IF;
  d := pg_get_functiondef('public.rebuild_place_momentum_v2(timestamptz)'::regprocedure);
  IF position('discovery_trend_post_groups_v2(p_now) g WHERE v_post' IN d) = 0
     OR position('discovery_trend_post_convergence_enabled' IN d) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3497): rebuild_place_momentum_v2 does not carry the gated post leg.';
  END IF;
  IF (SELECT prosecdef FROM pg_proc WHERE oid = 'public.discovery_trend_post_groups_v2(timestamptz)'::regprocedure)
     OR (SELECT prosecdef FROM pg_proc WHERE oid = 'public.rebuild_place_momentum_v2(timestamptz)'::regprocedure) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3497): both functions must be SECURITY INVOKER.';
  END IF;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF has_function_privilege(v_role, 'public.discovery_trend_post_groups_v2(timestamptz)', 'EXECUTE')
       OR has_function_privilege(v_role, 'public.rebuild_place_momentum_v2(timestamptz)', 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3497): % may execute a v2 trend function.', v_role;
    END IF;
  END LOOP;
END
$post$;
