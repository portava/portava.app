-- Rollback for 3725_discovery_trend_post_owner_controls.sql: restores 3497's
-- discovery_trend_post_groups_v2 body byte for byte (the owner-controls
-- exclusion is removed; the stored count then again counts Memories their owners
-- kept out of personalization). Grants restated as 3497 states them.
BEGIN;

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

REVOKE ALL ON FUNCTION public.discovery_trend_post_groups_v2(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.discovery_trend_post_groups_v2(timestamptz) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.discovery_trend_post_groups_v2(timestamptz) TO service_role;

COMMIT;
