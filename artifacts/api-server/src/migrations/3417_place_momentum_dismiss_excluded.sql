-- 3417_place_momentum_dismiss_excluded.sql
-- Discovery momentum (census-discovery DV-25, §61): a DISMISS is not interest.
-- `public.rebuild_place_momentum` (2892) weighed every non-save outcome at
-- TREND_EVENT_WEIGHTS.outcome (2), `dismiss` included, so a place people
-- dismissed GAINED momentum. This file replaces the function with 2892's body
-- byte for byte except ONE line: the outcome weight is
--   CASE WHEN outcome = 'save' THEN c_w_save WHEN outcome = 'dismiss' THEN 0 ELSE c_w_outcome END
-- A dismissed row still counts its impression at served_at, exactly as an
-- unconverted impression does: the place WAS shown. Zero is EXCLUSION, not a
-- negative weight; no new term, weight or threshold is introduced.
--
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
-- Rehearsed on the local PostgreSQL 16 harness only (scripts/local-db/up.sh).
--
-- THE SAME EXCLUSION IN TYPESCRIPT, and the one place it is NOT yet:
--   lib/discoveryLocalMomentum.weightFor   dismiss → 0 (this lane, §61)
--   services/trails/TrailService.exposureCountsFrom  dismiss is not a §9 positive (§61)
--   lib/discoveryTrendState.weightFor      2892's TypeScript mirror (computeTrendStates).
--                                          Lane P8's file: the same one-line exclusion is
--                                          ROUTED to the integrator as a hunk (§61.13), and
--                                          until it lands this function and computeTrendStates
--                                          disagree on rows with a dismiss outcome.
--
-- `model_version`, `event_weights` and the rest of the stored evidence are left
-- exactly as 2892 writes them, as the integrator asked ("matching 2892's
-- structure exactly otherwise"). A row written after this file therefore does
-- not say that dismisses were excluded; that is recorded as a DC-17 lineage
-- note in §61, not fixed here.
--
-- `10` §4: the function reads the same rows through the same plan; one more
-- CASE arm changes no access path.
--
-- Rollback: db/rollback/2026-09-27-3417-place-momentum-dismiss-excluded-rollback.sql
-- (restores 2892's body verbatim; deletes no row).

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.place_momentum') IS NULL
     OR to_regprocedure('public.rebuild_place_momentum(timestamptz)') IS NULL
     OR to_regprocedure('public.place_momentum_classify(double precision,double precision,double precision,double precision)') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3417): 2892''s place_momentum, rebuild_place_momentum and place_momentum_classify must exist. Apply 2892_place_momentum.sql first.';
  END IF;
END
$pre$;

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
           CASE WHEN outcome = 'save' THEN c_w_save WHEN outcome = 'dismiss' THEN 0 ELSE c_w_outcome END
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
GRANT EXECUTE ON FUNCTION public.rebuild_place_momentum(timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.rebuild_place_momentum(timestamptz) FROM anon, authenticated;

COMMENT ON FUNCTION public.rebuild_place_momentum(timestamptz) IS
  '`10` §10 rebuildability, as an executable. Recomputes public.place_momentum '
  'for the instant p_now from public.rank_events alone, and is idempotent for a '
  'given p_now (ON CONFLICT DO UPDATE on (place_id, computed_at)). Returns the '
  'number of rows written. Mirrors lib/discoveryTrendState.computeTrendStates: '
  'analytics rows excluded, an outcome counted at outcome_at rather than at '
  'served_at, mid and prior weights normalised to a 48-hour rate. SECURITY '
  'INVOKER with a pinned search_path per `10` §6 — it reads raw behaviour and '
  'must not lend that read to its caller. NOTHING SCHEDULES THIS as of '
  'migration 2892.'
  ' 3417 (census-discovery DV-25): an outcome of dismiss weighs 0 — the row''s '
  'impression still counts at served_at, the dismissal adds nothing.';

COMMIT;

-- ── Postconditions (read-only: what persisted) ──────────────────────────────
DO $post$
DECLARE d text := pg_get_functiondef('public.rebuild_place_momentum(timestamptz)'::regprocedure);
BEGIN
  IF position('WHEN outcome = ''dismiss'' THEN 0' IN d) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3417): rebuild_place_momentum does not exclude dismiss outcomes.';
  END IF;
  IF (SELECT prosecdef FROM pg_proc WHERE oid = 'public.rebuild_place_momentum(timestamptz)'::regprocedure) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3417): rebuild_place_momentum must stay SECURITY INVOKER (10 §6).';
  END IF;
  IF has_function_privilege('anon', 'public.rebuild_place_momentum(timestamptz)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.rebuild_place_momentum(timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3417): a client role may execute rebuild_place_momentum.';
  END IF;
END
$post$;
