-- 3921_graph_behavior_observations.sql
-- The intelligence graph's behaviour family, read COMPLETE: one row per
-- (viewer, item, outcome) over every rank_events row (census-discovery §133,
-- DV-51).
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band; lane DISCOVERY,
-- 3920-3929). ORDER-INDEPENDENT AND IDEMPOTENT: it needs only public.rank_events
-- (baseline), CREATE OR REPLACE VIEW re-runs to the same definition, and it
-- writes no row. Rehearsed on the local PostgreSQL harness.
--
-- ── WHY ─────────────────────────────────────────────────────────────────────
-- compass/CompassGraphEngine.ts built `person —behavior:<outcome>→ place` from
-- `rank_events … .neq('outcome','impression').limit(5000)`: an UNORDERED sample
-- (and PostgREST answers at most its max-rows of it). Production holds 175,136
-- non-impression rows (2026-10-23), so the build saw a fixed fraction and newer
-- behaviour never reached the graph. The reconcile that decays and retires
-- those edges re-read the same raw rows per 100-pair chunk under a 10,000-row
-- cap; the 383 production behaviour edges needed 171,336, so every chunk was
-- incomplete, the family was undecided, and a stale intent edge never decayed
-- or left the graph. This view hands both readers what the edge actually is —
-- the count, the first and last observation, and the distinct UTC days — so
-- every pair is complete in one row however many raw rows it has.
--
-- ── SHAPE (mirrored by graphBehaviorObservationsOf in CompassGraphEngine.ts) ─
--   user_id       rank_events.user_id as text
--   item_id       rank_events.item_id
--   outcome       rank_events.outcome (every outcome; the build keeps its own
--                 .neq('outcome','impression'))
--   item_kind     the item_kind of the EARLIEST observation (served_at, then id)
--   observations  count(*)
--   first_at, last_at   min / max served_at (NULLs ignored)
--   days          the distinct UTC calendar days of served_at, ascending
--   obs_key       user_id || '|' || item_id || '|' || outcome — unique; the
--                 paging order
-- Rows with a NULL user_id, item_id or outcome are left out, as the build's own
-- loop skipped them.
--
-- ── POSTURE ─────────────────────────────────────────────────────────────────
-- security_invoker, SELECT for service_role only: the view names viewers, so no
-- client role may read it.
--
-- Rollback: db/rollback/2026-10-23-3921-graph-behavior-observations-rollback.sql

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.rank_events') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3921): public.rank_events does not exist.';
  END IF;
END $$;

CREATE OR REPLACE VIEW public.graph_behavior_observations
  WITH (security_invoker = true) AS
SELECT
  r.user_id::text                                                        AS user_id,
  r.item_id                                                              AS item_id,
  r.outcome                                                              AS outcome,
  (array_agg(r.item_kind ORDER BY r.served_at ASC NULLS LAST, r.id ASC))[1] AS item_kind,
  count(*)::bigint                                                       AS observations,
  min(r.served_at)                                                       AS first_at,
  max(r.served_at)                                                       AS last_at,
  COALESCE(array_agg(DISTINCT to_char(r.served_at AT TIME ZONE 'UTC', 'YYYY-MM-DD'))
             FILTER (WHERE r.served_at IS NOT NULL), ARRAY[]::text[])    AS days,
  r.user_id::text || '|' || r.item_id || '|' || r.outcome               AS obs_key
FROM public.rank_events r
WHERE r.user_id IS NOT NULL AND r.item_id IS NOT NULL AND r.outcome IS NOT NULL
GROUP BY r.user_id, r.item_id, r.outcome;

COMMENT ON VIEW public.graph_behavior_observations IS
  '3921 (census-discovery DV-51): one row per (user, item, outcome) over every rank_events row — count, first/last served_at, distinct UTC days — so the intelligence graph''s behaviour family is built and judged complete. service_role only.';

REVOKE ALL ON public.graph_behavior_observations FROM PUBLIC;
REVOKE ALL ON public.graph_behavior_observations FROM anon, authenticated;
GRANT SELECT ON public.graph_behavior_observations TO service_role;

COMMIT;

DO $post$
BEGIN
  IF to_regclass('public.graph_behavior_observations') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3921): the view is missing.';
  END IF;
  IF has_table_privilege('anon', 'public.graph_behavior_observations', 'SELECT')
     OR has_table_privilege('authenticated', 'public.graph_behavior_observations', 'SELECT') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3921): a client role may read graph_behavior_observations.';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.graph_behavior_observations', 'SELECT') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3921): service_role cannot read graph_behavior_observations.';
  END IF;
  IF (SELECT count(*) FROM public.graph_behavior_observations)
     <> (SELECT count(*) FROM (SELECT DISTINCT user_id, item_id, outcome FROM public.rank_events
                                 WHERE user_id IS NOT NULL AND item_id IS NOT NULL AND outcome IS NOT NULL) d) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3921): the view is not one row per (user, item, outcome).';
  END IF;
END $post$;
