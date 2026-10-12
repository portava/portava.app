-- 3726_discovery_trend_post_latest_correction.sql
-- Owner ruling OD-1012-PRIV-3 (2026-10-12), second half (W-HM-PRIV-2): "Exclude
-- disputed locations from aggregates until reconciliation reliably honors the
-- latest user correction; do not permanently disregard a valid later correction."
-- census-highlights-memories H49 (a negative constraint is durable until the
-- owner's later word) on the trend count.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band; lane hm-priv,
-- 3725-3729). NOT applied to portava-ci. NOT applied to production. Replaces ONE
-- function body: 3725's discovery_trend_post_groups_v2, with 3725's corrections
-- clause ("the owner EVER rejected the stored place") replaced by the latest-
-- correction clause, and nothing else changed. No table, column, index, flag or
-- row. The function is called only by rebuild_place_momentum_v2 while
-- discovery_trend_post_convergence_enabled (3496, seeded FALSE) is ON.
--
-- WHAT "RECONCILED" MEANS HERE. A change of place is PATCH /memories/:id, which
-- records the owner's assert (plus a rejection of each replaced value, in the
-- same insert, so the same created_at) BEFORE it writes the Memory row. The
-- Memory row carrying the asserted reference is therefore the completion signal:
-- an assert the row does not carry yet is disputed. `memories.updated_at` is not
-- one (it is stamped before the correction is recorded).
--
-- The TypeScript loader's twin is services/memory/memoryReaderGuard.ts
-- storedPlaceVerdict (lib/discoveryTrendPostConvergence.ts reads
-- canonical_location_id for it); src/test/memoryReaderGuard.test.ts pins both.
--
-- CHAIN ORDER. Requires 3725 applied (the precondition reads 3725's clause in
-- the live body), so a replay is 3497 -> 3725 -> 3726, never 3726 alone.
--
-- Rollback: db/rollback/2026-10-12-3726-discovery-trend-post-latest-correction-rollback.sql
-- (restores 3725's body byte for byte: the permanent-rejection rule).

BEGIN;

DO $pre$
BEGIN
  IF to_regprocedure('public.discovery_trend_post_groups_v2(timestamptz)') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3726): discovery_trend_post_groups_v2 is missing. Apply 3497 and 3725 first.';
  END IF;
  IF to_regclass('public.memory_resurfacing_preferences') IS NULL OR to_regclass('public.memory_corrections') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3726): memory_resurfacing_preferences (3671) and memory_corrections (3673) must exist first.';
  END IF;
  IF position('FROM public.memory_resurfacing_preferences rp' IN pg_get_functiondef('public.discovery_trend_post_groups_v2(timestamptz)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3726): discovery_trend_post_groups_v2 does not carry 3725''s owner-controls clause. Apply 3725 first.';
  END IF;
END
$pre$;

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
$fn$;

REVOKE ALL ON FUNCTION public.discovery_trend_post_groups_v2(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.discovery_trend_post_groups_v2(timestamptz) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.discovery_trend_post_groups_v2(timestamptz) TO service_role;
COMMENT ON FUNCTION public.discovery_trend_post_groups_v2(timestamptz) IS
  '3497 + 3725 + 3726 (census-discovery DV-34 §95.9; census-highlights-memories A1, W-HM-PRIV-2): per place key and window, the independence clusters of travellers who published a PUBLIC Memory there after their own positive Discovery outcome and are not already the window''s activity actors — k-floored at 2 distinct authors, twice — excluding a Memory whose owner set KEEP_PRIVATE_FOREVER or RETAIN_BUT_DO_NOT_PERSONALIZE, and one whose stored place its owner''s LATEST correction disputes (a later rejection, or an assertion the row does not carry yet). Returns counts only. Called only by rebuild_place_momentum_v2 while discovery_trend_post_convergence_enabled (3496, FALSE) is ON.';

COMMIT;

-- ── Postconditions (read-only, recomputed from the catalog) ────────────────
DO $post$
DECLARE d text; v_role text;
BEGIN
  d := pg_get_functiondef('public.discovery_trend_post_groups_v2(timestamptz)'::regprocedure);
  IF position('FROM public.memory_resurfacing_preferences rp' IN d) = 0
     OR position('''KEEP_PRIVATE_FOREVER'', ''RETAIN_BUT_DO_NOT_PERSONALIZE''' IN d) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3726): discovery_trend_post_groups_v2 lost 3725''s owner-controls exclusion.';
  END IF;
  IF position('mc.kind = ''reject'' AND mc.place_id = m.place_id' IN d) > 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3726): discovery_trend_post_groups_v2 still disregards a Memory whose place was EVER rejected.';
  END IF;
  IF position('AND (lx.created_at, lx.id) > (la.created_at, la.id)' IN d) = 0
     OR position('la.canonical_location_id IS NOT DISTINCT FROM m.canonical_location_id' IN d) = 0
     OR position('AND (rj.created_at > la.created_at' IN d) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3726): discovery_trend_post_groups_v2 does not carry the latest-correction clause.';
  END IF;
  IF (SELECT prosecdef FROM pg_proc WHERE oid = 'public.discovery_trend_post_groups_v2(timestamptz)'::regprocedure) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3726): discovery_trend_post_groups_v2 must be SECURITY INVOKER.';
  END IF;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF has_function_privilege(v_role, 'public.discovery_trend_post_groups_v2(timestamptz)', 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3726): % may execute discovery_trend_post_groups_v2.', v_role;
    END IF;
  END LOOP;
END
$post$;
