-- 3391_discovery_stop_condition_measurements.sql
-- Discovery database and rollout lane (census-discovery DV-82, §54): the
-- MEASUREMENTS behind four of `12`'s seven stop conditions, read by
-- lib/discoveryStopMeasurements.ts and judged by lib/discoveryStopConditions.ts.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band; Discovery database
-- and rollout lane 3390-3394). APPLIED TO NO SHARED DATABASE by the lane that
-- wrote it: applied, rolled back and re-applied on the local PostgreSQL 16
-- harness only. NOT applied to portava-ci, NOT applied to production.
-- Depends on 3390 (the RLS posture it measures is 3390's).
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT — one index, one read-only function
-- ══════════════════════════════════════════════════════════════════════════════
-- `12` "Stop conditions": "Stop rollout if: event rejection rises,
-- recommendation logging gaps appear, creator concentration spikes,
-- reports/hides increase materially, cache bypass reappears, RLS leaks occur,
-- attribution double-counts." Two are measured in-process from the serve-log
-- writer (lib/discoveryStopConditions.ts). One (cache bypass) is measured
-- in-process on the serve path. The other four live in the database, and this
-- function reads them in ONE round trip:
--
--   creator_concentration     Herfindahl index of Discovery EXPOSURES across
--                             creators in the window: rank_events impressions
--                             (surface 'discovery') whose item is a `db/<uuid>`
--                             discovery_places row, joined to
--                             discovery_places.submitted_by — the same author
--                             join the shadow writer does (lib/discoveryShadow
--                             resolvePageAuthors). Coverage travels with it: an
--                             OSM place has no author, and "unresolved" is never
--                             counted as a creator.
--   reports_hides             dismiss outcomes (2297) whose outcome_at falls in
--                             the window, per exposure served in the window; and
--                             discovery_place_reports / trail_reports created in
--                             it, per exposure.
--   attribution_double_count  groups of CURRENT (not superseded) recorded
--                             attributions sharing value event, beneficiary,
--                             creator type and subject — two live rows crediting
--                             one person twice for one outcome. 2920's
--                             ca_idempotency_key_once makes a same-key replay
--                             impossible; this counts the double count that key
--                             cannot see (two keys, one outcome). Absent table
--                             ⇒ `input_absent`, never 0.
--   rls_leak                  deviations of the live catalogue from 3390's
--                             declared posture on the sixteen Discovery tables:
--                             RLS off, a client privilege beyond the posture, a
--                             missing restrictive deny, a kept client policy
--                             whose predicate changed, an extra permissive
--                             client policy on a kept path, or a client holding
--                             TRUNCATE / REFERENCES / TRIGGER.
--
-- THE FUNCTION DECIDES NOTHING. It returns counts. No threshold is in this file
-- and none is in the reader: `12` gives none, the owner has ruled none, and
-- lib/discoveryStopConditions.ts reports each of these four as `unruled` with
-- its measured value until one is ruled.
--
-- SECURITY INVOKER, service_role EXECUTE only, search_path pinned (`10` §6).
-- It reads behaviour and the catalogue; lending either to a client is exactly
-- what it must not do.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- `10` §4 — cardinality, index rationale, EXPLAIN (docs/discovery/query-paths.md)
-- ══════════════════════════════════════════════════════════════════════════════
-- Called at most once per resolver refresh (30 s) per API instance, and only
-- while DISCOVERY_ENGINE_MODE is non-legacy (production: legacy, so never).
--   * rank_events_discovery_served_at (served_at) WHERE surface = 'discovery' —
--     the window scan over Discovery exposures. Without it the window is a
--     sequential scan of ALL of rank_events (234,224 rows in production on
--     2026-09-27, of which 13 are 'discovery'); with it, a range scan over the
--     Discovery rows only. Partial, so no other surface's insert pays for it.
--     Built without CONCURRENTLY (a migration runs in a transaction): a SHARE
--     lock on rank_events for the build, which on production is a scan of
--     ~234k rows while no surface has written since 2026-08-27.
--   * dismiss outcomes read through the existing partial index
--     rank_events_discovery_dismissed (2995); reports tables are small and
--     scanned; creator_attributions through ca_value_event_idx (2920).
-- EXPLAIN on the harness at the synthetic cardinality in
-- docs/discovery/query-paths.md §5 — a harness plan, not a production plan.
--
-- Rollback: db/rollback/2026-09-27-3391-discovery-stop-condition-measurements-rollback.sql

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.rank_events') IS NULL OR to_regclass('public.discovery_places') IS NULL
     OR to_regclass('public.discovery_place_reports') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3391): rank_events, discovery_places and discovery_place_reports must exist.';
  END IF;
  PERFORM 1 FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'rank_events' AND column_name = 'outcome_at';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3391): rank_events.outcome_at is missing; a dismiss is timed by it.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'discovery_place_photos_deny_select_clients') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3391): 3390 is not applied; the RLS posture this function measures is 3390''s.';
  END IF;
END $pre$;

CREATE INDEX IF NOT EXISTS rank_events_discovery_served_at
  ON public.rank_events (served_at)
  WHERE surface = 'discovery';

COMMENT ON INDEX public.rank_events_discovery_served_at IS
  '3391 (census-discovery DV-82, DC-15): the window scan over Discovery exposures that discovery_stop_measurements() and every per-window Discovery report makes. Partial on surface = ''discovery'' so no other surface''s writes pay for it. docs/discovery/query-paths.md.';

CREATE OR REPLACE FUNCTION public.discovery_stop_measurements(p_since timestamptz, p_until timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_catalog
AS $fn$
DECLARE
  v_exposures      bigint;
  v_hides          bigint;
  v_place_reports  bigint;
  v_trail_reports  bigint;
  v_resolved       bigint;
  v_creators       bigint;
  v_hhi            double precision;
  v_top            double precision;
  v_dup_groups     bigint;
  v_dup_rows       bigint;
  v_attr_rows      bigint;
  v_attr           jsonb;
  v_devs           text[] := ARRAY[]::text[];
  t                record;
  v_op             text;
  v_role           text;
  v_kept           record;
  v_cmd            "char";
BEGIN
  IF p_since IS NULL OR p_until IS NULL OR p_until <= p_since THEN
    RAISE EXCEPTION 'discovery_stop_measurements: the window must be a non-empty [since, until)'
      USING ERRCODE = '22023';
  END IF;

  -- ── reports_hides ──────────────────────────────────────────────────────────
  SELECT count(*) INTO v_exposures FROM public.rank_events
   WHERE surface = 'discovery' AND served_at >= p_since AND served_at < p_until
     AND outcome <> 'analytics';
  SELECT count(*) INTO v_hides FROM public.rank_events
   WHERE surface = 'discovery' AND outcome = 'dismiss'
     AND outcome_at >= p_since AND outcome_at < p_until;
  SELECT count(*) INTO v_place_reports FROM public.discovery_place_reports
   WHERE created_at >= p_since AND created_at < p_until;
  IF to_regclass('public.trail_reports') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.trail_reports WHERE created_at >= $1 AND created_at < $2'
      INTO v_trail_reports USING p_since, p_until;
  END IF;

  -- ── creator_concentration ──────────────────────────────────────────────────
  WITH served AS (
    SELECT item_id FROM public.rank_events
     WHERE surface = 'discovery' AND served_at >= p_since AND served_at < p_until
       AND outcome <> 'analytics'
  ), authored AS (
    SELECT dp.submitted_by
      FROM served s
      JOIN public.discovery_places dp
        ON s.item_id ~* '^db/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       AND dp.id = (substring(s.item_id FROM 4))::uuid
     WHERE dp.submitted_by IS NOT NULL
  ), per AS (
    SELECT submitted_by, count(*)::double precision AS c FROM authored GROUP BY submitted_by
  )
  SELECT coalesce(sum(c), 0)::bigint, count(*)::bigint,
         CASE WHEN sum(c) > 0 THEN sum((c / tot) ^ 2) END,
         CASE WHEN sum(c) > 0 THEN max(c / tot) END
    INTO v_resolved, v_creators, v_hhi, v_top
    FROM per CROSS JOIN (SELECT sum(c) AS tot FROM per) z;

  -- ── attribution_double_count ───────────────────────────────────────────────
  IF to_regclass('public.creator_attributions') IS NULL THEN
    v_attr := jsonb_build_object('state', 'input_absent');
  ELSE
    EXECUTE $q$
      WITH cur AS (
        SELECT a.* FROM public.creator_attributions a
         WHERE a.attribution_basis = 'recorded_value_event'
           AND NOT EXISTS (SELECT 1 FROM public.creator_attributions s WHERE s.supersedes_id = a.id)
      ), g AS (
        SELECT count(*) AS n, max(computed_at) AS newest
          FROM cur
         GROUP BY value_event, value_event_id, beneficiary_user_id, creator_type, subject_kind, subject_id
        HAVING count(*) > 1
      )
      SELECT (SELECT count(*) FROM g WHERE newest >= $1 AND newest < $2),
             (SELECT coalesce(sum(n - 1), 0) FROM g WHERE newest >= $1 AND newest < $2),
             (SELECT count(*) FROM public.creator_attributions WHERE computed_at >= $1 AND computed_at < $2)
    $q$ INTO v_dup_groups, v_dup_rows, v_attr_rows USING p_since, p_until;
    v_attr := jsonb_build_object('state', 'measured', 'duplicate_groups', v_dup_groups,
                                 'extra_rows', v_dup_rows, 'attributions_in_window', v_attr_rows);
  END IF;

  -- ── rls_leak: the live catalogue against 3390's declared posture ───────────
  FOR t IN
    SELECT x.tbl FROM unnest(ARRAY[
      'discovery_places','discovery_place_saves','discovery_place_reports','discovery_cache',
      'discovery_geocode_cache','discovery_shadow_serves','discovery_place_photos','place_momentum',
      'trails','content_trails','trail_edges','trail_follows','trail_reports',
      'trail_health_snapshots','recommendations','rank_events']) AS x(tbl)
     WHERE to_regclass('public.' || x.tbl) IS NOT NULL
  LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.' || t.tbl)) THEN
      v_devs := v_devs || format('%s: rls_disabled', t.tbl);
    END IF;
    FOREACH v_op IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE'] LOOP
      v_cmd := CASE v_op WHEN 'SELECT' THEN 'r' WHEN 'INSERT' THEN 'a' WHEN 'UPDATE' THEN 'w' ELSE 'd' END;
      FOREACH v_role IN ARRAY ARRAY['anon','authenticated'] LOOP
        SELECT k.* INTO v_kept FROM (VALUES
          ('discovery_places',        'SELECT', 'anon',          'discovery_places_public_read', '(status = ''active''::text)', NULL),
          ('discovery_places',        'SELECT', 'authenticated', 'discovery_places_public_read', '(status = ''active''::text)', NULL),
          ('discovery_place_saves',   'SELECT', 'authenticated', 'Users read own saves',          '(auth.uid() = user_id)', NULL),
          ('discovery_place_saves',   'INSERT', 'authenticated', 'Users insert own saves',        NULL, '(auth.uid() = user_id)'),
          ('discovery_place_reports', 'SELECT', 'authenticated', 'auth_select_own_report',        '(reporter_id = auth.uid())', NULL),
          ('discovery_place_reports', 'INSERT', 'authenticated', 'auth_insert_own_report',        NULL, '(reporter_id = auth.uid())'),
          ('trails',                  'SELECT', 'authenticated', 'trails_public_select',          '(lifecycle_status <> ''archived''::text)', NULL),
          ('content_trails',          'SELECT', 'authenticated', 'content_trails_public_select',  'true', NULL),
          ('trail_edges',             'SELECT', 'authenticated', 'trail_edges_public_select',     'true', NULL),
          ('trail_follows',           'SELECT', 'authenticated', 'trail_follows_own_select',      '(user_id = auth.uid())', NULL),
          ('rank_events',             'SELECT', 'authenticated', 'users_read_own_rank_events',    '(auth.uid() = user_id)', NULL)
        ) AS k(tbl, op, role, polname, qual, wcheck)
         WHERE k.tbl = t.tbl AND k.op = v_op AND k.role = v_role;

        IF FOUND THEN
          -- A kept path: its policy must still say what it said.
          IF NOT EXISTS (SELECT 1 FROM pg_policy p
                          WHERE p.polrelid = to_regclass('public.' || t.tbl) AND p.polname = v_kept.polname
                            AND p.polpermissive
                            AND pg_get_expr(p.polqual, p.polrelid) IS NOT DISTINCT FROM v_kept.qual
                            AND pg_get_expr(p.polwithcheck, p.polrelid) IS NOT DISTINCT FROM v_kept.wcheck) THEN
            v_devs := v_devs || format('%s %s %s: kept_policy_changed_or_missing (%s)', t.tbl, v_op, v_role, v_kept.polname);
          END IF;
          -- …and nothing else may widen it for this role.
          IF EXISTS (SELECT 1 FROM pg_policy p
                      WHERE p.polrelid = to_regclass('public.' || t.tbl) AND p.polpermissive
                        AND p.polcmd IN ('*', v_cmd) AND p.polname <> v_kept.polname
                        AND (0 = ANY (p.polroles) OR (SELECT oid FROM pg_roles WHERE rolname = v_role) = ANY (p.polroles))) THEN
            v_devs := v_devs || format('%s %s %s: extra_permissive_policy', t.tbl, v_op, v_role);
          END IF;
        ELSE
          IF has_table_privilege(v_role, 'public.' || t.tbl, v_op) THEN
            v_devs := v_devs || format('%s %s %s: privilege_beyond_posture', t.tbl, v_op, v_role);
          END IF;
          IF NOT EXISTS (SELECT 1 FROM pg_policy p
                          WHERE p.polrelid = to_regclass('public.' || t.tbl) AND NOT p.polpermissive
                            AND p.polcmd = v_cmd
                            AND (SELECT oid FROM pg_roles WHERE rolname = v_role) = ANY (p.polroles)) THEN
            v_devs := v_devs || format('%s %s %s: restrictive_deny_missing', t.tbl, v_op, v_role);
          END IF;
        END IF;
      END LOOP;
    END LOOP;
    FOREACH v_op IN ARRAY ARRAY['TRUNCATE','REFERENCES','TRIGGER'] LOOP
      FOREACH v_role IN ARRAY ARRAY['anon','authenticated'] LOOP
        IF has_table_privilege(v_role, 'public.' || t.tbl, v_op) THEN
          v_devs := v_devs || format('%s %s %s: non_rls_privilege', t.tbl, v_op, v_role);
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object(
    'window', jsonb_build_object('since', p_since, 'until', p_until),
    'reports_hides', jsonb_build_object(
      'state', 'measured',
      'exposures', v_exposures, 'hides', v_hides,
      'place_reports', v_place_reports, 'trail_reports', v_trail_reports),
    'creator_concentration', jsonb_build_object(
      'state', 'measured',
      'exposures', v_exposures, 'resolved', v_resolved, 'creators', v_creators,
      'hhi', v_hhi, 'top_creator_share', v_top),
    'attribution_double_count', v_attr,
    'rls_leak', jsonb_build_object(
      'state', 'measured',
      'deviations', coalesce(array_length(v_devs, 1), 0),
      'detail', to_jsonb(v_devs[1:50]))
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.discovery_stop_measurements(timestamptz, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.discovery_stop_measurements(timestamptz, timestamptz) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.discovery_stop_measurements(timestamptz, timestamptz) TO service_role;

COMMENT ON FUNCTION public.discovery_stop_measurements(timestamptz, timestamptz) IS
  '3391 (census-discovery DV-82): the database half of `12`''s stop conditions — creator concentration of Discovery exposures, reports/hides per exposure, live double-counted attributions, and RLS posture deviations from 3390 — over [p_since, p_until). Returns counts only; it applies no threshold. Read by lib/discoveryStopMeasurements.ts. SECURITY INVOKER, service_role only.';

DO $post$
DECLARE r jsonb;
BEGIN
  IF to_regclass('public.rank_events_discovery_served_at') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3391): rank_events_discovery_served_at was not created.';
  END IF;
  IF has_function_privilege('anon', 'public.discovery_stop_measurements(timestamptz, timestamptz)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.discovery_stop_measurements(timestamptz, timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3391): a client role can execute discovery_stop_measurements.';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.discovery_stop_measurements(timestamptz, timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3391): service_role cannot execute discovery_stop_measurements.';
  END IF;
  -- It must run, and on a database where 3390 holds it must find the posture intact.
  r := public.discovery_stop_measurements(now() - interval '10 minutes', now());
  IF (r #>> '{rls_leak,deviations}')::int <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3391): the RLS posture already deviates from 3390: %', r #> '{rls_leak,detail}';
  END IF;
END $post$;

COMMIT;
