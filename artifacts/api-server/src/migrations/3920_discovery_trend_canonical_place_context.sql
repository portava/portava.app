-- 3920_discovery_trend_canonical_place_context.sql
-- The v2 trend producer, keyed to the places Discovery actually serves
-- (census-discovery §133: DV-28, DV-29, DV-33, DC-06, DC-21), behind
-- discovery_trend_canonical_place_context_enabled, seeded FALSE here.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band; lane DISCOVERY,
-- 3920-3929). NEW OBJECTS ONLY. ORDER-INDEPENDENT AND IDEMPOTENT: every
-- statement is CREATE OR REPLACE of a function no other migration defines, one
-- flag INSERT with ON CONFLICT DO NOTHING, and REVOKE/GRANT. It changes no
-- existing function, table or row. Rehearsed on the local PostgreSQL harness in
-- both orders: replayed fresh in byte order (before 3988) and applied on top of
-- the full chain (after 3988, as on portava-ci and production), each twice.
--
-- ── THE DEFECT ──────────────────────────────────────────────────────────────
-- discovery_trend_place_context() (3476, patched by 3988) reads
-- public.discovery_places only. Every place Discovery serves is a public.places
-- row (`db/<places.id>`, lib/discoveryCandidates/materialize.ts), and in
-- production 0 of the 180 served places join the context (read 2026-10-23), so
-- the newest stored run has cell_key and city NULL on every row, peer_factor
-- 1.000, every lifecycle `unknown`, and no area_momentum row.
--
-- ── WHY NEW FUNCTIONS, NOT A PATCH ──────────────────────────────────────────
-- 3988 hash-pins the five trend functions (before/after sha256) and refuses any
-- other definition. 3920 sorts BEFORE 3988, so on a fresh replay a patched
-- original would make 3988 refuse; applied after 3988 it would break the pins.
-- So this file leaves all five untouched and adds:
--   discovery_trend_place_context_canonical()   the context over discovery_places
--       UNION the active, unmerged public.places rows that no discovery_places row
--       shadows (the materialiser's precedence: a uuid found in discovery_places
--       is that row), with 3988's protected-position filter over both, cell labels
--       chosen across both, and D-66's `review_state = 'approved'` Trail filter
--       that loadTrendContext already applies (when trails.review_state exists).
--       A canonical place has no submitter column: creator_id is NULL for it, so it
--       has no creator peer baseline (stated, not inferred).
--   discovery_trend_windows_v2_canonical, discovery_trend_post_groups_v2_canonical,
--   rebuild_place_momentum_v2_canonical         the three 3988-reviewed bodies,
--       byte for byte, with exactly four textual substitutions (the context and the
--       three function names). The block after them PROVES that against the
--       installed originals whenever those carry 3988's reviewed "after" hash.
--   rebuild_place_momentum_canonical(p_now)     the dispatcher: the flag OFF, absent
--       or unreadable → public.rebuild_place_momentum(p_now), exactly today's run;
--       ON with discovery_trend_normalised_enabled → the canonical v2 run; ON
--       without it → today's v1 run (v1 reads no place context).
-- Feature and model versions are unchanged: the per-row contribution is the
-- same; what changes is which places have context. lib/discoveryLocalMomentum's
-- in-process reading reads the same rows under the same flag
-- (lib/discoveryTrendCanonicalContext.ts), so the stored run stays equal to it.
--
-- ── RUNTIME EFFECT OF APPLYING: NONE ────────────────────────────────────────
-- The flag ships FALSE. lib/discoveryTrendRebuildScheduler.ts calls
-- rebuild_place_momentum_canonical only while it reads TRUE, and the dispatcher
-- re-reads it. Turning it on is a rollout decision; the rows it then writes are
-- ordinary place_momentum / area_momentum rows, under the same retention
-- (Q11(b), D-W10-R1-12) as every run.
--
-- Rollback: db/rollback/2026-10-23-3920-discovery-trend-canonical-place-context-rollback.sql

BEGIN;

DO $pre$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(t, ', ') INTO missing
    FROM unnest(ARRAY['public.feature_flags', 'public.discovery_places', 'public.places', 'public.protected_zones',
                      'public.rank_events', 'public.place_momentum', 'public.area_momentum']) t
   WHERE to_regclass(t) IS NULL;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3920): missing %', missing;
  END IF;
  SELECT string_agg(f, ', ') INTO missing
    FROM unnest(ARRAY['public.discovery_trend_place_context()', 'public.discovery_trend_windows_v2(timestamptz,text)',
                      'public.discovery_trend_post_groups_v2(timestamptz)', 'public.rebuild_place_momentum(timestamptz)',
                      'public.rebuild_place_momentum_v2(timestamptz)', 'public.place_momentum_classify_v2(boolean,boolean,boolean,double precision)']) f
   WHERE to_regprocedure(f) IS NULL;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3920): missing % (3476/3477 first)', missing;
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.discovery_trend_place_context_canonical()
 RETURNS TABLE(place_key text, creator_id text, cell_key text, cell_label text, city text, created_at timestamp with time zone, content_class text, trail_ids text[])
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  -- D-66 (3977): a Trail under review is its creator's alone, as loadTrendContext reads it.
  v_review text := CASE
    WHEN EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'trails' AND column_name = 'review_state')
      THEN $r$ AND t.review_state = 'approved'$r$
    ELSE ''
  END;
  v_members text := CASE
    WHEN to_regclass('public.content_trails') IS NOT NULL AND to_regclass('public.trails') IS NOT NULL THEN
      $m$SELECT lower(ct.source_id::text) AS pkey,
                array_agg(DISTINCT lower(ct.trail_id::text) ORDER BY lower(ct.trail_id::text)) AS tids
           FROM public.content_trails ct JOIN public.trails t ON t.id = ct.trail_id
          WHERE ct.source_type = 'place' AND t.lifecycle_status <> 'archived'$m$ || v_review || $m$
          GROUP BY lower(ct.source_id::text)$m$
    ELSE $m$SELECT NULL::text AS pkey, NULL::text[] AS tids WHERE false$m$
  END;
BEGIN
  -- 3476's context, over both place tables. lib/discoveryTrendNormalised
  -- EPHEMERAL_TYPES / ENDURING_TYPES / TREND_V2_CELL_DEG (0.02).
  RETURN QUERY EXECUTE format($q$
  WITH u AS (
    SELECT lower(dp.id::text) AS pkey,
           lower(dp.submitted_by::text) AS creator,
           NULLIF(lower(btrim(COALESCE(dp.city, ''), ' ')), '') AS pcity,
           NULLIF(btrim(COALESCE(dp.neighborhood, ''), ' '), '') AS hood,
           dp.lat, dp.lng, dp.created_at AS pcreated,
           lower(btrim(COALESCE(dp.category, ''), ' '))   AS cat,
           lower(btrim(COALESCE(dp.place_type, ''), ' ')) AS typ
      FROM public.discovery_places dp
    UNION ALL
    -- lib/discoveryTrendCanonicalContext canonicalContextPlaceRow: no submitter;
    -- primary_category is the category; no place_type.
    SELECT lower(pl.id::text), NULL::text,
           NULLIF(lower(btrim(COALESCE(pl.city, ''), ' ')), ''),
           NULLIF(btrim(COALESCE(pl.neighborhood, ''), ' '), ''),
           pl.latitude, pl.longitude, pl.created_at,
           lower(btrim(COALESCE(pl.primary_category, ''), ' ')),
           ''::text
      FROM public.places pl
     WHERE pl.status = 'active' AND pl.merged_into_place_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.discovery_places d WHERE d.id = pl.id)
  ), p AS (
    SELECT u.* FROM u
     WHERE NOT EXISTS (SELECT 1 FROM public.protected_zones z WHERE z.active)
        OR public.discovery_trend_position_is_clear(u.lat, u.lng)
  ), keyed AS (
    SELECT p.*,
           CASE WHEN p.hood IS NOT NULL AND p.pcity IS NOT NULL THEN 'n:' || p.pcity || ':' || lower(p.hood)
                WHEN p.lat IS NOT NULL AND p.lng IS NOT NULL
                  THEN 'g:' || floor(p.lat / 0.02::double precision)::bigint::text || ':' || floor(p.lng / 0.02::double precision)::bigint::text
           END AS ckey
      FROM p
  ), members AS (%s)
  SELECT k.pkey, k.creator, k.ckey,
         CASE WHEN k.ckey LIKE 'n:%%' THEN min(k.hood COLLATE "C") OVER (PARTITION BY k.ckey) END,
         k.pcity, k.pcreated,
         CASE WHEN k.cat = ANY (ARRAY['event','events','festival','concert','performance','party']) THEN 'ephemeral'
              WHEN k.cat = ANY (ARRAY['temple','church','cathedral','mosque','shrine','monument','palace','castle','fort','ruins',
                                      'landmark','museum','heritage site','historic district','attraction','beach','park','garden','viewpoint']) THEN 'enduring'
              WHEN k.typ = ANY (ARRAY['event','events','festival','concert','performance','party']) THEN 'ephemeral'
              WHEN k.typ = ANY (ARRAY['temple','church','cathedral','mosque','shrine','monument','palace','castle','fort','ruins',
                                      'landmark','museum','heritage site','historic district','attraction','beach','park','garden','viewpoint']) THEN 'enduring'
              ELSE 'standard' END,
         COALESCE(mm.tids, ARRAY[]::text[])
    FROM keyed k LEFT JOIN members mm ON mm.pkey = k.pkey
  $q$, v_members);
END
$function$;

-- ── The three 3988-reviewed bodies, four substitutions, nothing else ────────
CREATE OR REPLACE FUNCTION public.discovery_trend_windows_v2_canonical(p_now timestamp with time zone, p_level text)
 RETURNS TABLE(o_key text, o_recent_exposures integer, o_mid_exposures integer, o_prior_exposures integer, o_recent_activity double precision, o_mid_activity double precision, o_prior_activity double precision, o_recent_groups integer, o_mid_groups integer, o_prior_groups integer, o_recent_save_groups integer, o_recent_trip_groups integer, o_time_of_day_factor double precision, o_recent_travelers integer, o_window_travelers integer, o_last_activity_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_catalog'
AS $function$
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
  ctx AS (SELECT c.place_key AS cpk, c.cell_key AS cck, c.created_at AS ccreated FROM public.discovery_trend_place_context_canonical() c),
  base AS (
    -- The loader's read: the Discovery surface, analytics excluded, a row
    -- admitted only when it was SERVED inside the window.
    SELECT r.item_id AS item, lower(r.user_id::text) AS actor, r.outcome AS oc, r.served_at AS sat, r.outcome_at AS oat,
           x.ccreated AS pcreated,
           CASE WHEN p_level = 'place' THEN r.item_id ELSE x.cck END AS k
      FROM public.rank_events r
      LEFT JOIN ctx x ON x.cpk = lower(regexp_replace(r.item_id, '^db/', ''))
     WHERE (x.cpk IS NOT NULL OR NOT EXISTS (SELECT 1 FROM public.protected_zones z WHERE z.active))
       AND r.surface = c_surface AND r.outcome <> 'analytics'
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
$function$;

CREATE OR REPLACE FUNCTION public.discovery_trend_post_groups_v2_canonical(p_now timestamp with time zone)
 RETURNS TABLE(o_key text, o_win text, o_added integer)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_catalog'
AS $function$
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
  ctx AS (SELECT c.place_key AS cpk, c.created_at AS ccreated FROM public.discovery_trend_place_context_canonical() c),
  -- 3477's place-level read, exactly.
  base AS (
    SELECT r.item_id AS k, lower(r.user_id::text) AS actor, r.outcome AS oc, r.outcome_at AS oat, x.ccreated AS pcreated
      FROM public.rank_events r
      LEFT JOIN ctx x ON x.cpk = lower(regexp_replace(r.item_id, '^db/', ''))
     WHERE (x.cpk IS NOT NULL OR NOT EXISTS (SELECT 1 FROM public.protected_zones z WHERE z.active))
       AND r.surface = c_surface AND r.outcome <> 'analytics'
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
       -- 3725 (RECON-W A1; census H49 H92 H188 H210): public is the audience, not
       -- consent to every use. Not counted: a Memory whose owner set a control that
       -- suppresses personalization or public projection (3671) —
       -- services/memory/memoryReaderGuard.ts aggregateMemoryRows, the loader's twin.
       AND NOT EXISTS (SELECT 1 FROM public.memory_resurfacing_preferences rp
                        WHERE rp.memory_id = m.id AND rp.owner_id = m.owner_id
                          AND rp.control IN ('KEEP_PRIVATE_FOREVER', 'RETAIN_BUT_DO_NOT_PERSONALIZE'))
       -- 3726 (owner ruling OD-1012-PRIV-3, W-HM-PRIV-2): the owner's LATEST place
       -- correction (3673) decides — memoryReaderGuard.ts storedPlaceVerdict, clause
       -- for clause. Counted: a Memory with no correction, or one whose latest
       -- correction is the owner's assert (H-15: the latest assert by instant, then
       -- id), with no rejection at a later instant, none at the same instant naming
       -- its values, and the stored reference reconciled to it (place_id equal,
       -- canonical_location_id equal or both null). Anything else is disputed.
       AND (NOT EXISTS (SELECT 1 FROM public.memory_corrections mc
                         WHERE mc.memory_id = m.id AND mc.owner_id = m.owner_id AND mc.field = 'place')
            OR EXISTS (SELECT 1 FROM public.memory_corrections la
                        WHERE la.memory_id = m.id AND la.owner_id = m.owner_id AND la.field = 'place' AND la.kind = 'assert'
                          AND la.place_id = m.place_id
                          AND la.canonical_location_id IS NOT DISTINCT FROM m.canonical_location_id
                          AND NOT EXISTS (SELECT 1 FROM public.memory_corrections lx
                                           WHERE lx.memory_id = m.id AND lx.owner_id = m.owner_id AND lx.field = 'place' AND lx.kind = 'assert'
                                             AND (lx.created_at, lx.id) > (la.created_at, la.id))
                          AND NOT EXISTS (SELECT 1 FROM public.memory_corrections rj
                                           WHERE rj.memory_id = m.id AND rj.owner_id = m.owner_id AND rj.field = 'place' AND rj.kind = 'reject'
                                             AND (rj.created_at > la.created_at
                                                  OR (rj.created_at = la.created_at
                                                      AND (rj.place_id = la.place_id OR rj.canonical_location_id = la.canonical_location_id))))))
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
$function$;

CREATE OR REPLACE FUNCTION public.rebuild_place_momentum_v2_canonical(p_now timestamp with time zone DEFAULT now())
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  c_min_exposures CONSTANT integer := 30;  -- TREND_V2_MIN_EXPOSURES
  c_min_groups    CONSTANT integer := 3;   -- TREND_V2_MIN_GROUPS
  c_min_peers     CONSTANT integer := 3;   -- TREND_V2_MIN_PEERS
  c_model         CONSTANT text := 'discovery-trend-state-v2';       -- TREND_STATE_MODEL_VERSION_V2
  c_feature       CONSTANT text := CASE WHEN EXISTS (SELECT 1 FROM public.protected_zones z WHERE z.active) THEN 'discovery-exposure-activity-v3+protected-contributions-v1' ELSE 'discovery-exposure-activity-v3' END; -- TREND_FEATURE_VERSION_V2
  c_feature_post  CONSTANT text := CASE WHEN EXISTS (SELECT 1 FROM public.protected_zones z WHERE z.active) THEN 'discovery-exposure-activity-v3+post-after-visit-v1+protected-contributions-v1' ELSE 'discovery-exposure-activity-v3+post-after-visit-v1' END; -- TREND_FEATURE_VERSION_V2_POST
  c_post_min_authors CONSTANT integer := 2;  -- POST_CONVERGENCE_MIN_AUTHORS
  -- 3497: the post-after-visit leg, only with its flag ON (3496, seeded FALSE)
  -- and a memories table to read. OFF, absent or unreadable: false, and the
  -- rows below are 3477's, value for value.
  v_post boolean := COALESCE((SELECT f.enabled FROM public.feature_flags f WHERE f.flag = 'discovery_trend_post_convergence_enabled'), false)
                    AND to_regclass('public.memories') IS NOT NULL;
  c_surface       CONSTANT text := 'discovery';
  v_written integer;
BEGIN
  WITH w0 AS (SELECT * FROM public.discovery_trend_windows_v2_canonical(p_now, 'place')),
  -- 3497: a pseudo-constant qual, so with v_post false the Function Scan never runs.
  pg AS (SELECT g.o_key, g.o_win, g.o_added FROM public.discovery_trend_post_groups_v2_canonical(p_now) g WHERE v_post),
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
  cx AS (SELECT * FROM public.discovery_trend_place_context_canonical()),
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
  WITH w AS (SELECT * FROM public.discovery_trend_windows_v2_canonical(p_now, 'area')),
  cells AS (
    SELECT c.cell_key AS ck, min(c.cell_label COLLATE "C") AS lbl, min(c.city COLLATE "C") AS cty
      FROM public.discovery_trend_place_context_canonical() c WHERE c.cell_key IS NOT NULL GROUP BY c.cell_key
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
$function$;

CREATE OR REPLACE FUNCTION public.rebuild_place_momentum_canonical(p_now timestamp with time zone DEFAULT now())
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  -- OFF, absent or unreadable: exactly the run the scheduler stores today.
  IF COALESCE((SELECT f.enabled FROM public.feature_flags f WHERE f.flag = 'discovery_trend_canonical_place_context_enabled'), false) IS NOT TRUE THEN
    RETURN public.rebuild_place_momentum(p_now);
  END IF;
  IF COALESCE((SELECT f.enabled FROM public.feature_flags f WHERE f.flag = 'discovery_trend_normalised_enabled'), false) THEN
    RETURN public.rebuild_place_momentum_v2_canonical(p_now);
  END IF;
  RETURN public.rebuild_place_momentum(p_now);
END
$function$;

REVOKE ALL ON FUNCTION public.discovery_trend_place_context_canonical() FROM PUBLIC, anon, authenticated; REVOKE ALL ON FUNCTION public.discovery_trend_windows_v2_canonical(timestamptz,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.discovery_trend_post_groups_v2_canonical(timestamptz) FROM PUBLIC, anon, authenticated; REVOKE ALL ON FUNCTION public.rebuild_place_momentum_v2_canonical(timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rebuild_place_momentum_canonical(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.discovery_trend_place_context_canonical(), public.discovery_trend_windows_v2_canonical(timestamptz,text),
  public.discovery_trend_post_groups_v2_canonical(timestamptz), public.rebuild_place_momentum_v2_canonical(timestamptz),
  public.rebuild_place_momentum_canonical(timestamptz) TO service_role;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'discovery_trend_canonical_place_context_enabled',
    false,
    'The v2 trend producer and the in-process trend reading key the places Discovery serves (public.places), not discovery_places alone. census-discovery DV-28/29/33, DC-06, DC-21, §133; migration 3920. OFF (the seed), absent or unreadable: rebuild_place_momentum runs exactly as before and loadTrendContext reads discovery_places only. A rollout decision; the runs it writes are ordinary place_momentum / area_momentum rows under the same retention.'
  )
ON CONFLICT (flag) DO NOTHING;

-- ── Postconditions, and the copies proven against the reviewed originals ────
DO $post$
DECLARE
  pair record;
  original_def text;
  expected_def text;
  copy_def text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'discovery_trend_canonical_place_context_enabled') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3920): discovery_trend_canonical_place_context_enabled is absent.';
  END IF;
  FOR pair IN SELECT * FROM (VALUES
    ('public.discovery_trend_windows_v2(timestamptz,text)', 'public.discovery_trend_windows_v2_canonical(timestamptz,text)',
     '8967523ccd3435c626d25ca95a3ea406b16c5be898ab5ea8bfca66f9b469b9f5'),
    ('public.discovery_trend_post_groups_v2(timestamptz)', 'public.discovery_trend_post_groups_v2_canonical(timestamptz)',
     '93859dcf6650f82b15de316602fe13d8af34e764e8decffbb460d153047277a6'),
    ('public.rebuild_place_momentum_v2(timestamptz)', 'public.rebuild_place_momentum_v2_canonical(timestamptz)',
     '9bc554e497cbc8c37aedd3fa227a3e41261ee80bc78848970798e22ac51cc7cf')
  ) AS pairs(original, copy, reviewed_after) LOOP
    copy_def := pg_get_functiondef(to_regprocedure(pair.copy));
    IF position('public.discovery_trend_place_context()' IN copy_def) > 0
       OR position('public.discovery_trend_place_context_canonical()' IN copy_def) = 0 THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3920): % does not read the canonical context only', pair.copy;
    END IF;
    IF position('(SELECT 1 FROM public.protected_zones z WHERE z.active)' IN copy_def) = 0 THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3920): % lacks 3988''s protected-contribution filter', pair.copy;
    END IF;
    original_def := pg_get_functiondef(to_regprocedure(pair.original));
    -- Before 3988 (a fresh replay in byte order) the originals still carry their
    -- pre-3988 bodies; the copies already carry 3988's, and 3988 then brings the
    -- originals to the hash compared here. The harness suite (C5) re-proves it there.
    IF encode(sha256(convert_to(original_def, 'UTF8')), 'hex') = pair.reviewed_after THEN
      expected_def := replace(replace(replace(replace(original_def,
        'public.discovery_trend_place_context()', 'public.discovery_trend_place_context_canonical()'),
        'public.discovery_trend_windows_v2(', 'public.discovery_trend_windows_v2_canonical('),
        'public.discovery_trend_post_groups_v2(', 'public.discovery_trend_post_groups_v2_canonical('),
        'public.rebuild_place_momentum_v2(', 'public.rebuild_place_momentum_v2_canonical(');
      IF copy_def IS DISTINCT FROM expected_def THEN
        RAISE EXCEPTION 'POSTCONDITION FAILED (3920): % is not % with the four substitutions', pair.copy, pair.original;
      END IF;
    ELSE
      RAISE NOTICE '3920: % is not at 3988''s reviewed definition yet; the copy is checked against it after 3988', pair.original;
    END IF;
  END LOOP;
  IF has_function_privilege('anon', 'public.rebuild_place_momentum_canonical(timestamptz)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.rebuild_place_momentum_canonical(timestamptz)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.discovery_trend_place_context_canonical()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.discovery_trend_place_context_canonical()', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3920): a client role can execute the canonical trend producer';
  END IF;
END
$post$;

COMMIT;
