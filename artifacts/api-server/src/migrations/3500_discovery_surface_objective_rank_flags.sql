-- 3500_discovery_surface_objective_rank_flags.sql
-- DV-09's last three surfaces rank on their own `01` §9 objective
-- (census-discovery §93, lane W11-X1): THREE capability flags, all seeded OFF.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band; lane W11-X1 owns
-- 3500-3504). APPLIED TO NO DATABASE by the lane that wrote it other than the
-- local PostgreSQL 16 harness.
--
-- Additive + idempotent. Safe to re-run. `*_enabled` ⇒ CAPABILITY convention:
-- read fail-closed through lib/featureFlags.isFlagEnabled (absent, FALSE and
-- unreadable all read OFF).
--
-- ── WHAT THEY GATE (lib/discoverySurfaceObjectiveRank.ts) ───────────────────
-- Each ranks its surface through portavaRank on that surface's objective
-- (lib/discoveryRankObjectives SURFACE_OBJECTIVES), and ONLY when 3450's
-- discovery_surface_objectives_enabled is ALSO on (D-W11X1-3): the objective
-- itself, with the owner's metadata overrides, stays 3450's.
--
--   discovery_trail_objective_rank_enabled         (DV-09 Trail — `02` §8)
--     ON (+3450): GET /v1/discovery/trails/:id/modules serves a fifth
--          spotlight, `personalized_picks`, ranked for the viewer on the
--          Trail objective. OFF / absent / unreadable (the seed): no module,
--          and the page is byte-identical to the tree before 3500.
--
--   discovery_trending_objective_rank_enabled      (DV-09 Trending — `03`)
--     ON (+3450): GET /v1/discovery/trending/places orders the places INSIDE
--          each claimed state by the Trending objective; the state order
--          stays first. OFF: the decided order (D-W10-R1-13), byte for byte.
--
--   discovery_trip_planning_objective_rank_enabled (DV-09 Trip Planning)
--     ON (+3450): GET /trips/:tripId/nearby-places orders the trip's places
--          by the Trip Planning objective (trip fit, route fit, saves). OFF:
--          rating order, byte for byte.
--
-- ── RUNTIME EFFECT OF SEEDING: NONE, AND THAT IS CHECKED ───────────────────
-- Seeded FALSE; the postcondition refuses a seed that finds any ON. Turning one
-- on in production is the owner's (register W11-X1, D-W11X1-A1).
--
-- Rollback: db/rollback/2026-09-28-3500-discovery-surface-objective-rank-flags-rollback.sql
-- (deletes the three rows while they are still FALSE, and this file's ledger row).

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3500): public.feature_flags does not exist.';
  END IF;
END $$;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'discovery_trail_objective_rank_enabled',
    false,
    'DV-09 Trail objective (census-discovery §93; 01 §9, 02 §8). ON together with discovery_surface_objectives_enabled: the Trail page serves a personalized_picks spotlight ranked for the viewer on the Trail objective (membership confidence as Trail relevance, freshness per content type, contributor and place diversity). OFF / absent / unreadable (the seed): no such module; the page is unchanged. Ranking machinery: turning it on in production is an owner decision.'
  ),
  (
    'discovery_trending_objective_rank_enabled',
    false,
    'DV-09 Trending objective (census-discovery §93; 01 §9). ON together with discovery_surface_objectives_enabled: GET /v1/discovery/trending/places orders places inside each claimed state by the Trending objective (freshness, normalised velocity under the owner cap, verified, saves de-emphasised). OFF / absent / unreadable (the seed): the decided state-then-velocity order, unchanged. Ranking machinery: turning it on in production is an owner decision.'
  ),
  (
    'discovery_trip_planning_objective_rank_enabled',
    false,
    'DV-09 Trip Planning objective (census-discovery §93; 01 §9). ON together with discovery_surface_objectives_enabled: GET /trips/:tripId/nearby-places orders the trip''s places by the Trip Planning objective (trip fit, route fit, saves, category affinity). OFF / absent / unreadable (the seed): rating order, unchanged. Ranking machinery: turning it on in production is an owner decision.'
  )
ON CONFLICT (flag) DO NOTHING;

COMMIT;

-- ── Postconditions (separate transaction: they assert what persisted) ───────
DO $post$
DECLARE present int; on_count int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags
    WHERE flag IN ('discovery_trail_objective_rank_enabled', 'discovery_trending_objective_rank_enabled', 'discovery_trip_planning_objective_rank_enabled');
  IF present <> 3 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3500): expected the three surface objective flags present, found %', present;
  END IF;

  SELECT count(*) INTO on_count FROM public.feature_flags
    WHERE flag IN ('discovery_trail_objective_rank_enabled', 'discovery_trending_objective_rank_enabled', 'discovery_trip_planning_objective_rank_enabled') AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3500): a surface objective flag is ON — each reorders what a surface serves, enabling one is an owner decision, and they must ship OFF';
  END IF;
END $post$;
