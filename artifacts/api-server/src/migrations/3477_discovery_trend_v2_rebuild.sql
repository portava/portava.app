-- 3477_discovery_trend_v2_rebuild.sql
-- Discovery trending v2 — the SQL twin of lib/discoveryTrendNormalised
-- (census-discovery §84, lane W10-R1: DC-06, DV-28, DV-29, DV-30, DV-32, DV-33,
-- DV-34). It REPLACES 3435's `rebuild_place_momentum`, as census §66.2 asked:
--
--   rebuild_place_momentum(p_now)
--     discovery_trend_normalised_enabled OFF, absent or unreadable (the seed):
--       3435's body, byte for byte below the one dispatch line — v1, the rows
--       3417/3435 wrote, the same values (src/test/db/discoveryTrendNormalisedParity
--       .db.test.ts N-OFF holds a flag-off run equal to 3435's own, column by column).
--     ON: rebuild_place_momentum_v2(p_now) — every place row the v2 model
--       computes, and every Local Pulse cell (area_momentum).
--
-- THE v2 ARITHMETIC is lib/discoveryTrendNormalised's header, restated nowhere
-- else: a served impression is EXPOSURE (the denominator), an outcome is
-- activity, activity is capped per independence cluster (Sensing's clustering:
-- units merge when different actors take the same action on the same item
-- within 30 s of each other), a window's rate is a reading only at ≥ 30
-- exposures and ≥ 3 clusters, and the velocity is normalised by time of day,
-- content age (launch window) and the creator / Trail / location peer medians.
-- Every constant below names the TypeScript symbol it must equal, and
-- src/test/discoveryTrendNormalised.test.ts parses them (N-SQL); the harness
-- suite executes this file and compares every stored row with the TypeScript
-- over the same rows (N1–N6).
--
-- APPLIED TO NO DATABASE by the lane that wrote it other than the local
-- PostgreSQL 16 harness. NOT applied to portava-ci (hwokxgbmezheskbzskfr).
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb). NOTHING SCHEDULES the
-- rebuild in any deployment until discovery_trend_rebuild_scheduler_enabled is
-- turned on (lib/discoveryTrendRebuildScheduler).
--
-- `10` §4: the v2 read is 3410's read (the Discovery surface, served in the
-- window, analytics excluded) on the same index, plus one pass over
-- discovery_places (and 2910's memberships where present). The independence
-- recursion runs only over actors that share a synchronised island, so its cost
-- is bounded by coordinated activity, not by traffic. No index is created.
--
-- Rollback: db/rollback/2026-09-28-3477-discovery-trend-v2-rebuild-rollback.sql
-- (restores 3435's function verbatim and drops the v2 functions; deletes no row).

BEGIN;

DO $pre$
DECLARE d text;
BEGIN
  IF to_regprocedure('public.rebuild_place_momentum(timestamptz)') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3477): rebuild_place_momentum must exist. Apply 2892, 3410, 3417 and 3435 first.';
  END IF;
  d := pg_get_functiondef('public.rebuild_place_momentum(timestamptz)'::regprocedure);
  IF position('c_feature    CONSTANT text := ''discovery-row-activity-v2''' IN d) = 0
     OR position('WHEN outcome = ''dismiss'' THEN 0' IN d) = 0 OR position('surface = c_surface' IN d) = 0 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3477): rebuild_place_momentum is not 3435''s. Apply 3435 first; this file keeps its body as the flag-off branch.';
  END IF;
  IF to_regprocedure('public.discovery_trend_place_context()') IS NULL OR to_regclass('public.area_momentum') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3477): 3476''s store is missing. Apply 3476 first.';
  END IF;
END
$pre$;

-- ── The classifier (lib/discoveryTrendNormalised.classifyTrendStateV2) ──────
CREATE OR REPLACE FUNCTION public.place_momentum_classify_v2(
  p_recent_reading boolean, p_had_mid boolean, p_had_prior boolean, p_velocity double precision)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_catalog
AS $fn$
DECLARE
  c_growth_factor  CONSTANT double precision := 1.5;  -- TREND_V2_GROWTH_FACTOR
  c_decline_factor CONSTANT double precision := 0.6;  -- TREND_V2_DECLINE_FACTOR
BEGIN
  IF p_recent_reading IS NOT TRUE THEN RETURN 'unknown'; END IF;
  IF p_had_mid IS NOT TRUE AND p_had_prior IS NOT TRUE THEN RETURN 'emerging'; END IF;
  IF p_had_prior IS TRUE AND p_had_mid IS NOT TRUE THEN RETURN 'rediscovered'; END IF;
  IF p_velocity IS NULL THEN RETURN 'unknown'; END IF;
  IF p_velocity > c_growth_factor THEN RETURN 'trending'; END IF;
  IF p_velocity < c_decline_factor THEN RETURN 'cooling'; END IF;
  RETURN 'established';
END
$fn$;

-- ── `03` §4 lifecycle (lib/discoveryTrendNormalised.lifecycleOf) ────────────
CREATE OR REPLACE FUNCTION public.place_momentum_lifecycle_v2(
  p_state text, p_class text, p_had_prior boolean, p_last_activity timestamptz, p_now timestamptz)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_catalog
AS $fn$
DECLARE
  c_h_ephemeral_ms CONSTANT bigint := 12::bigint   * 3600000;  -- CONTENT_HORIZON_MS.ephemeral
  c_h_standard_ms  CONSTANT bigint := 720::bigint  * 3600000;  -- CONTENT_HORIZON_MS.standard
  c_h_enduring_ms  CONSTANT bigint := 8760::bigint * 3600000;  -- CONTENT_HORIZON_MS.enduring
  v_h bigint := CASE p_class WHEN 'ephemeral' THEN c_h_ephemeral_ms WHEN 'enduring' THEN c_h_enduring_ms ELSE c_h_standard_ms END;
  v_lapsed boolean := p_last_activity IS NOT NULL
    AND (floor(extract(epoch FROM p_now) * 1000)::bigint - floor(extract(epoch FROM p_last_activity) * 1000)::bigint) > v_h;
BEGIN
  RETURN CASE p_state
    WHEN 'emerging'     THEN 'emerging'
    WHEN 'trending'     THEN 'growing'
    WHEN 'established'  THEN CASE WHEN COALESCE(p_class, 'standard') <> 'ephemeral' AND p_had_prior IS TRUE THEN 'evergreen' ELSE 'peak' END
    WHEN 'rediscovered' THEN 'rediscovered'
    WHEN 'cooling'      THEN CASE WHEN v_lapsed THEN 'inactive' ELSE 'cooling' END
    ELSE CASE WHEN v_lapsed THEN 'inactive' ELSE 'unknown' END
  END;
END
$fn$;

-- ── The driver (lib/discoveryTrendNormalised.driverOf) ──────────────────────
CREATE OR REPLACE FUNCTION public.place_momentum_driver_v2(p_state text, p_groups integer, p_save_groups integer, p_trip_groups integer)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_catalog
AS $fn$
  SELECT CASE
    WHEN p_state IN ('unknown', 'cooling') THEN NULL
    WHEN p_trip_groups * 2 > p_groups THEN 'trip_adds'
    WHEN p_save_groups * 2 > p_groups THEN 'saves'
    ELSE 'independent_groups'
  END
$fn$;

-- ── The stored sentence (lib/discoveryTrendState.explainTrendReading, no neighbourhood) ──
CREATE OR REPLACE FUNCTION public.place_momentum_reason_v2(p_state text, p_driver text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_catalog
AS $fn$
  SELECT CASE p_state
    WHEN 'emerging' THEN CASE p_driver
      WHEN 'trip_adds' THEN 'New around here, and being added to trips by several unrelated people.'
      WHEN 'saves'     THEN 'New around here, and being saved by several unrelated people.'
      ELSE 'Emerging across several independent groups of people.' END
    WHEN 'trending' THEN CASE p_driver
      WHEN 'trip_adds' THEN 'Frequently added to trips in the last couple of days.'
      WHEN 'saves'     THEN 'Saved more than usual in the last couple of days.'
      ELSE 'Picking up across independent groups in the last couple of days.' END
    WHEN 'established' THEN CASE p_driver
      WHEN 'trip_adds' THEN 'Consistently added to trips, not just this week.'
      WHEN 'saves'     THEN 'Consistently saved, not just this week.'
      ELSE 'Consistently busy here, not just this week.' END
    WHEN 'cooling' THEN 'Quieter than it has been recently.'
    WHEN 'rediscovered' THEN CASE p_driver
      WHEN 'trip_adds' THEN 'Being added to trips again after a quiet spell.'
      WHEN 'saves'     THEN 'Being saved again after a quiet spell.'
      ELSE 'Getting attention again after a quiet spell.' END
    ELSE NULL
  END
$fn$;

-- ── The windows (lib/discoveryTrendNormalised aggregate + clusterWindow + timeOfDayFactor) ──
CREATE OR REPLACE FUNCTION public.discovery_trend_windows_v2(p_now timestamptz, p_level text)
RETURNS TABLE (
  o_key text,
  o_recent_exposures integer, o_mid_exposures integer, o_prior_exposures integer,
  o_recent_activity double precision, o_mid_activity double precision, o_prior_activity double precision,
  o_recent_groups integer, o_mid_groups integer, o_prior_groups integer,
  o_recent_save_groups integer, o_recent_trip_groups integer,
  o_time_of_day_factor double precision,
  o_recent_travelers integer, o_window_travelers integer,
  o_last_activity_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_catalog
AS $fn$
DECLARE
  c_recent_ms  CONSTANT bigint := 48::bigint  * 3600000;  -- TREND_V2_RECENT_MS
  c_mid_ms     CONSTANT bigint := 168::bigint * 3600000;  -- TREND_V2_MID_MS
  c_prior_ms   CONSTANT bigint := 720::bigint * 3600000;  -- TREND_V2_PRIOR_MS
  c_w_save     CONSTANT double precision := 3;            -- TREND_V2_WEIGHTS.save
  c_w_outcome  CONSTANT double precision := 2;            -- TREND_V2_WEIGHTS.outcome
  c_group_cap  CONSTANT double precision := 3;            -- TREND_V2_GROUP_CAP
  c_sync_ms    CONSTANT bigint := 30000;                  -- TREND_V2_SYNC_MS
  c_launch_ms  CONSTANT bigint := 48::bigint  * 3600000;  -- TREND_V2_LAUNCH_MS
  c_band_hours CONSTANT integer := 6;                     -- TREND_V2_BAND_HOURS
  c_surface    CONSTANT text := 'discovery';
  v_recent_since timestamptz := p_now - make_interval(secs => c_recent_ms / 1000.0);
  v_mid_since    timestamptz := p_now - make_interval(secs => c_mid_ms    / 1000.0);
  v_prior_since  timestamptz := p_now - make_interval(secs => c_prior_ms  / 1000.0);
  v_launch       interval    := make_interval(secs => c_launch_ms / 1000.0);
BEGIN
  IF p_level IS NULL OR p_level NOT IN ('place', 'area') THEN
    RAISE EXCEPTION 'discovery_trend_windows_v2: p_level must be place or area, got %', p_level;
  END IF;
  RETURN QUERY
  WITH RECURSIVE
  ctx AS (SELECT c.place_key AS cpk, c.cell_key AS cck, c.created_at AS ccreated FROM public.discovery_trend_place_context() c),
  base AS (
    -- The loader's read: the Discovery surface, analytics excluded, a row
    -- admitted only when it was SERVED inside the window.
    SELECT r.item_id AS item, lower(r.user_id::text) AS actor, r.outcome AS oc, r.served_at AS sat, r.outcome_at AS oat,
           x.ccreated AS pcreated,
           CASE WHEN p_level = 'place' THEN r.item_id ELSE x.cck END AS k
      FROM public.rank_events r
      LEFT JOIN ctx x ON x.cpk = lower(regexp_replace(r.item_id, '^db/', ''))
     WHERE r.surface = c_surface AND r.outcome <> 'analytics'
       AND r.item_id IS NOT NULL AND r.served_at IS NOT NULL
       AND r.served_at >= v_prior_since
  ),
  keys AS (SELECT DISTINCT b.k FROM base b WHERE b.k IS NOT NULL),
  -- The exposure arm: every served row at served_at; a baseline window never
  -- counts the launch window (content age).
  expo AS (
    SELECT b.k, b.sat AS at,
           CASE WHEN b.sat >= v_recent_since THEN 'recent' WHEN b.sat >= v_mid_since THEN 'mid' ELSE 'prior' END AS win
      FROM base b
     WHERE b.k IS NOT NULL AND b.sat <= p_now AND b.sat >= v_prior_since
       AND NOT (b.sat < v_recent_since AND b.pcreated IS NOT NULL AND b.sat >= b.pcreated AND b.sat < b.pcreated + v_launch)
  ),
  -- The outcome arm: a positive outcome at outcome_at, with an actor.
  act_all AS (
    SELECT b.k, b.item, b.actor, b.oc, b.oat AS at, b.pcreated,
           CASE WHEN b.oc = 'save' THEN c_w_save ELSE c_w_outcome END AS w,
           CASE WHEN b.oat >= v_recent_since THEN 'recent' WHEN b.oat >= v_mid_since THEN 'mid' ELSE 'prior' END AS win
      FROM base b
     WHERE b.k IS NOT NULL AND b.oc NOT IN ('impression', 'dismiss')
       AND b.oat IS NOT NULL AND b.oat <= p_now AND b.oat >= v_prior_since
       AND b.actor IS NOT NULL
  ),
  last_act AS (SELECT a.k, max(a.at) AS last_at FROM act_all a GROUP BY a.k),
  act AS (
    SELECT a.* FROM act_all a
     WHERE NOT (a.win <> 'recent' AND a.pcreated IS NOT NULL AND a.at >= a.pcreated AND a.at < a.pcreated + v_launch)
  ),
  -- Sensing's synchronised-behaviour detector (lib/intelIndependence): within
  -- one (key, window, item, outcome), events sorted by time chain into one
  -- island while each gap is ≤ 30 s; every actor on an island is one unit.
  act_ms AS (SELECT a.*, floor(extract(epoch FROM a.at) * 1000)::bigint AS at_ms FROM act a),
  isl0 AS (
    SELECT m.*, lag(m.at_ms) OVER (PARTITION BY m.k, m.win, m.item, m.oc ORDER BY m.at_ms, m.actor) AS prev_ms FROM act_ms m
  ),
  isl AS (
    SELECT i.*, sum(CASE WHEN i.prev_ms IS NULL OR i.at_ms - i.prev_ms > c_sync_ms THEN 1 ELSE 0 END)
                  OVER (PARTITION BY i.k, i.win, i.item, i.oc ORDER BY i.at_ms, i.actor ROWS UNBOUNDED PRECEDING) AS island
      FROM isl0 i
  ),
  mem AS (SELECT DISTINCT s.k, s.win, s.actor, s.item || '|' || s.oc || '|' || s.island::text AS isl_id FROM isl s),
  multi AS (SELECT m.k, m.win, m.isl_id FROM mem m GROUP BY m.k, m.win, m.isl_id HAVING count(*) > 1),
  mmem AS (SELECT m.k, m.win, m.actor, m.isl_id FROM mem m JOIN multi u ON u.k = m.k AND u.win = m.win AND u.isl_id = m.isl_id),
  -- Units sharing an island are one cluster: connected components over actors.
  reach (k, win, a, b) AS (
    SELECT DISTINCT m.k, m.win, m.actor, m.actor FROM mmem m
    UNION
    SELECT r.k, r.win, r.a, m2.actor
      FROM reach r
      JOIN mmem m1 ON m1.k = r.k AND m1.win = r.win AND m1.actor = r.b
      JOIN mmem m2 ON m2.k = m1.k AND m2.win = m1.win AND m2.isl_id = m1.isl_id
  ),
  comp AS (SELECT r.k, r.win, r.a AS actor, min(r.b COLLATE "C") AS cl FROM reach r GROUP BY r.k, r.win, r.a),
  actor_act AS (
    SELECT a.k, a.win, a.actor, sum(a.w) AS aw, bool_or(a.oc = 'save') AS saved, bool_or(a.oc = 'trip_add') AS tripped
      FROM act a GROUP BY a.k, a.win, a.actor
  ),
  clus AS (
    SELECT aa.k, aa.win, COALESCE(c.cl, aa.actor) AS cl, sum(aa.aw) AS cw, bool_or(aa.saved) AS s, bool_or(aa.tripped) AS t
      FROM actor_act aa LEFT JOIN comp c ON c.k = aa.k AND c.win = aa.win AND c.actor = aa.actor
     GROUP BY aa.k, aa.win, COALESCE(c.cl, aa.actor)
  ),
  -- One cluster contributes at most one save's weight (Sensing §11 in Discovery's units).
  wagg AS (
    SELECT c.k, c.win, sum(least(c.cw, c_group_cap)) AS activity, count(*)::integer AS groups,
           count(*) FILTER (WHERE c.s)::integer AS save_groups, count(*) FILTER (WHERE c.t)::integer AS trip_groups
      FROM clus c GROUP BY c.k, c.win
  ),
  eagg AS (SELECT e.k, e.win, count(*)::integer AS n FROM expo e GROUP BY e.k, e.win),
  -- Time of day: four six-hour UTC bands, recent against mid.
  bandrow AS (
    SELECT u.k, u.band, sum(u.er) AS er, sum(u.em) AS em, sum(u.am) AS am FROM (
      SELECT e.k, floor(extract(hour FROM e.at AT TIME ZONE 'UTC') / c_band_hours)::integer AS band,
             (e.win = 'recent')::integer::double precision AS er, (e.win = 'mid')::integer::double precision AS em, 0::double precision AS am
        FROM expo e WHERE e.win IN ('recent', 'mid')
      UNION ALL
      SELECT a.k, floor(extract(hour FROM a.at AT TIME ZONE 'UTC') / c_band_hours)::integer, 0, 0, a.w
        FROM act a WHERE a.win = 'mid'
    ) u GROUP BY u.k, u.band
  ),
  todk AS (SELECT b.k, sum(b.er) AS er_t, sum(b.em) AS em_t, sum(b.am) AS am_t FROM bandrow b GROUP BY b.k),
  tod AS (
    SELECT t.k,
           CASE WHEN t.er_t <= 0 OR t.em_t <= 0 OR NOT (t.am_t / t.em_t > 0) THEN 1::double precision
                ELSE COALESCE(
                  NULLIF((SELECT sum((b.er / t.er_t) * CASE WHEN b.em > 0 THEN b.am / b.em ELSE t.am_t / t.em_t END)
                            FROM bandrow b WHERE b.k = t.k), 0) / (t.am_t / t.em_t),
                  1::double precision)
           END AS f
      FROM todk t
  ),
  -- The travellers 3410 counts, exactly: every served row and every outcome
  -- (dismiss included), distinct user per window. Read for disclosure, never
  -- to classify.
  trav AS (
    SELECT ev.k,
           count(DISTINCT ev.actor) FILTER (WHERE ev.at >= v_recent_since)::integer AS rt,
           count(DISTINCT ev.actor)::integer AS wt
      FROM (
        SELECT b.k, b.actor, b.sat AS at FROM base b WHERE b.k IS NOT NULL
        UNION ALL
        SELECT b.k, b.actor, b.oat FROM base b WHERE b.k IS NOT NULL AND b.oc <> 'impression' AND b.oat IS NOT NULL
      ) ev
     WHERE ev.at <= p_now AND ev.at >= v_prior_since
     GROUP BY ev.k
  )
  SELECT ks.k,
         COALESCE((SELECT e.n FROM eagg e WHERE e.k = ks.k AND e.win = 'recent'), 0),
         COALESCE((SELECT e.n FROM eagg e WHERE e.k = ks.k AND e.win = 'mid'), 0),
         COALESCE((SELECT e.n FROM eagg e WHERE e.k = ks.k AND e.win = 'prior'), 0),
         COALESCE((SELECT w.activity FROM wagg w WHERE w.k = ks.k AND w.win = 'recent'), 0)::double precision,
         COALESCE((SELECT w.activity FROM wagg w WHERE w.k = ks.k AND w.win = 'mid'), 0)::double precision,
         COALESCE((SELECT w.activity FROM wagg w WHERE w.k = ks.k AND w.win = 'prior'), 0)::double precision,
         COALESCE((SELECT w.groups FROM wagg w WHERE w.k = ks.k AND w.win = 'recent'), 0),
         COALESCE((SELECT w.groups FROM wagg w WHERE w.k = ks.k AND w.win = 'mid'), 0),
         COALESCE((SELECT w.groups FROM wagg w WHERE w.k = ks.k AND w.win = 'prior'), 0),
         COALESCE((SELECT w.save_groups FROM wagg w WHERE w.k = ks.k AND w.win = 'recent'), 0),
         COALESCE((SELECT w.trip_groups FROM wagg w WHERE w.k = ks.k AND w.win = 'recent'), 0),
         COALESCE((SELECT t.f FROM tod t WHERE t.k = ks.k), 1::double precision),
         COALESCE((SELECT v.rt FROM trav v WHERE v.k = ks.k), 0),
         COALESCE((SELECT v.wt FROM trav v WHERE v.k = ks.k), 0),
         (SELECT l.last_at FROM last_act l WHERE l.k = ks.k)
    FROM keys ks;
END
$fn$;

-- ── The v2 rebuild ──────────────────────────────────────────────────────────
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

-- ── The dispatcher: 3435's body, byte for byte, behind one line ─────────────
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
  -- 3435 (census-discovery §68, DC-17): what ONE row contributes — analytics
  -- excluded, impression 1, save 3, dismiss 0, other outcome 2. Mirrors
  -- lib/discoveryTrendState TREND_FEATURE_VERSION and lib/discoveryLocalMomentum
  -- LOCAL_MOMENTUM_FEATURE_VERSION; pinned equal by src/test/discoveryDerivedProvenance.test.ts.
  c_feature    CONSTANT text := 'discovery-row-activity-v2';
  -- The corpus lib/discoveryLocalMomentum.loadLocalMomentum reads.
  c_surface    CONSTANT text := 'discovery';

  v_mid_windows   double precision := (c_mid_ms   - c_recent_ms)::double precision / c_recent_ms;
  v_prior_windows double precision := (c_prior_ms - c_mid_ms)::double precision   / c_recent_ms;

  v_recent_since timestamptz := p_now - make_interval(secs => c_recent_ms / 1000.0);
  v_mid_since    timestamptz := p_now - make_interval(secs => c_mid_ms    / 1000.0);
  v_prior_since  timestamptz := p_now - make_interval(secs => c_prior_ms  / 1000.0);
  v_written integer;
BEGIN
  -- 3477 (census-discovery §84): the v2 model when its flag is ON; otherwise 3435's body, byte for byte.
  IF COALESCE((SELECT f.enabled FROM public.feature_flags f WHERE f.flag = 'discovery_trend_normalised_enabled'), false) THEN RETURN public.rebuild_place_momentum_v2(p_now); END IF;
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
    recent_unique_travelers, window_unique_travelers, source_surface, feature_version
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
         c.recent_travelers, c.window_travelers, c_surface, c_feature
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
    source_surface          = EXCLUDED.source_surface,
    feature_version         = EXCLUDED.feature_version;

  GET DIAGNOSTICS v_written = ROW_COUNT;
  RETURN v_written;
END
$fn$;

COMMENT ON FUNCTION public.rebuild_place_momentum(timestamptz) IS
  '`10` §10 rebuildability, as an executable (2892; corpus and explanation repaired by 3410). '
  'Recomputes public.place_momentum for p_now over the rows lib/discoveryLocalMomentum '
  'reads: surface ''discovery'', analytics excluded, served inside the 30-day window, an '
  'outcome counted at outcome_at. Stores lib/discoveryTrendState''s own explanation text '
  '(NULL for unknown) and the unique travellers behind each row. Idempotent for a given '
  'p_now. SECURITY INVOKER, service_role only. NOTHING SCHEDULES THIS.'
  ' 3417 (census-discovery DV-25): an outcome of dismiss weighs 0 — the row''s '
  'impression still counts at served_at, the dismissal adds nothing.'
  ' 3435 (DC-17): every row records its feature_version.'
  ' 3477 (§84): with discovery_trend_normalised_enabled TRUE it runs rebuild_place_momentum_v2 instead.';

REVOKE ALL ON FUNCTION public.rebuild_place_momentum(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rebuild_place_momentum(timestamptz) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_place_momentum(timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.rebuild_place_momentum_v2(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rebuild_place_momentum_v2(timestamptz) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_place_momentum_v2(timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.discovery_trend_windows_v2(timestamptz, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.discovery_trend_windows_v2(timestamptz, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.discovery_trend_windows_v2(timestamptz, text) TO service_role;
REVOKE ALL ON FUNCTION public.place_momentum_classify_v2(boolean, boolean, boolean, double precision) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.place_momentum_classify_v2(boolean, boolean, boolean, double precision) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.place_momentum_classify_v2(boolean, boolean, boolean, double precision) TO service_role;
REVOKE ALL ON FUNCTION public.place_momentum_lifecycle_v2(text, text, boolean, timestamptz, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.place_momentum_lifecycle_v2(text, text, boolean, timestamptz, timestamptz) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.place_momentum_lifecycle_v2(text, text, boolean, timestamptz, timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.place_momentum_driver_v2(text, integer, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.place_momentum_driver_v2(text, integer, integer, integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.place_momentum_driver_v2(text, integer, integer, integer) TO service_role;
REVOKE ALL ON FUNCTION public.place_momentum_reason_v2(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.place_momentum_reason_v2(text, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.place_momentum_reason_v2(text, text) TO service_role;

COMMENT ON FUNCTION public.rebuild_place_momentum_v2(timestamptz) IS
  '3477 (census-discovery §84): the v2 trend rebuild — exposure-normalised, independence-capped, six 03 §7 normalisers, 03 §4 lifecycle, the driver of each claim; writes place_momentum (model discovery-trend-state-v2) and area_momentum (Local Pulse). Called by rebuild_place_momentum when discovery_trend_normalised_enabled is TRUE. SECURITY INVOKER, service_role only.';

COMMIT;

-- ── Postconditions (read-only: what persisted) ──────────────────────────────
DO $post$
DECLARE d text := pg_get_functiondef('public.rebuild_place_momentum(timestamptz)'::regprocedure);
BEGIN
  IF position('rebuild_place_momentum_v2(p_now)' IN d) = 0 OR position('discovery_trend_normalised_enabled' IN d) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3477): rebuild_place_momentum does not dispatch on the flag.';
  END IF;
  IF position('c_feature    CONSTANT text := ''discovery-row-activity-v2''' IN d) = 0
     OR position('WHEN outcome = ''dismiss'' THEN 0' IN d) = 0
     OR position('surface = c_surface' IN d) = 0 OR position('served_at >= v_prior_since' IN d) = 0
     OR position('feature_version         = EXCLUDED.feature_version' IN d) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3477): the flag-off branch lost 3435''s body.';
  END IF;
  IF (SELECT bool_or(prosecdef) FROM pg_proc WHERE proname IN ('rebuild_place_momentum', 'rebuild_place_momentum_v2', 'discovery_trend_windows_v2')
        AND pronamespace = 'public'::regnamespace) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3477): a trend rebuild function is SECURITY DEFINER (10 §6).';
  END IF;
  IF has_function_privilege('anon', 'public.rebuild_place_momentum_v2(timestamptz)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.rebuild_place_momentum_v2(timestamptz)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.discovery_trend_windows_v2(timestamptz, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.discovery_trend_windows_v2(timestamptz, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3477): a client role may execute a v2 trend function.';
  END IF;
END
$post$;
