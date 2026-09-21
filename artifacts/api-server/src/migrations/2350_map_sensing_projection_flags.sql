-- 2350_map_sensing_projection_flags.sql
--
-- Three control rows for the Sensing §7 "Required Tweaks: Map" upgrade, all
-- seeded FALSE. One row each; no DDL, no table, no column, no policy, no grant.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Map lane 2350.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE STATE THIS MIGRATION IS WRITTEN AGAINST — MEASURED, NOT INFERRED
-- ══════════════════════════════════════════════════════════════════════════════
-- Read 2026-09-07 from BOTH databases:
--
--   travel-buddy   ajrurzioarfkagpuxfnb   (production)
--   portava-ci     hwokxgbmezheskbzskfr   (the sanctioned CI project)
--
--                                          production        portava-ci
--   feature_flags.map_projection_enabled    NO ROW (→ false)  FALSE
--   feature_flags.map_crowd_flow_enabled    NO ROW (→ false)  FALSE
--   feature_flags.map_world_intelligence_enabled NO ROW      FALSE
--   public.protected_zones                  ABSENT            present
--   public.geo_zones rows                   0                 —
--   intel_state_snapshots rows              0                 —
--   intel_live_promoted_scopes rows         0                 —
--
-- So in production the Map Intelligence Gateway is dark on BOTH branches of
-- its own flag — the row does not exist (2201 is unapplied there), and if it
-- did and were flipped, `protected_zones` is absent, so the route would answer
-- the fail-closed empty envelope (routes/mapProjection.ts loadProtectedZones).
-- Nothing this migration seeds can change what a user sees there; nothing it
-- seeds should. Every behaviour it controls sits BEHIND map_projection_enabled
-- and is inert in its own right until an operator flips it.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE THREE FLAGS — one per behaviour, exactly as 2336 seeds one per behaviour
-- ══════════════════════════════════════════════════════════════════════════════
--
-- map_experience_state_enabled          (Sensing §7 SX-02, SX-07)
--   Read by routes/mapProjection.ts and passed into
--   lib/mapProjection.enrichWithLiveClaims → applyLiveClaims, which then folds
--   the SAME live claims it already reads into a Sensing §5.3 ExperienceState
--   on `payload.experienceState` and stamps §5.1 `truthClass` and §4.4
--   `coverage` on the object (lib/mapExperienceState). Also read by
--   routes/mapProjectionTemporal.ts, which stamps `truthClass: 'predicted'` on
--   every forecast object. Opens NO new read path.
--
-- map_world_moments_enabled             (Sensing §7 SX-03)
--   Read by routes/mapProjection.ts's Phase 7 arm. Over the world_pulse cells
--   that survived §24 it runs lib/mapProducers/worldMomentProducer, which
--   promotes a cell into a world-change projection (heating up, forming,
--   moving, clearing, unexpected activity, event spillover, traveler surge)
--   when the already-published aggregates inside it evidence one. Sits behind
--   map_world_intelligence_enabled as well: no pulses, no moments.
--
-- map_display_resolver_enabled          (Sensing §7 SX-08, SX-09)
--   Read by routes/mapProjection.ts between ranking and paging. Runs
--   lib/mapDisplayResolver: safety notices are never budgeted, every object at
--   or within ~100 m of a notice loses any opportunity promotion and carries
--   `payload.safetyConstraint.promotable = false`, and the §17 band, §30 mode
--   and §13 intent allocate a clutter budget across display classes. The only
--   one of the three that can REMOVE an object from a page, which is why it is
--   its own switch.
--
-- All three end in `_enabled` and are lowercase, so scripts/check-flag-polarity
-- classifies them CAPABILITY by convention: `true` means the capability is
-- available, and isFlagEnabled returning false on a read error or a missing row
-- is the safe default. None is a kill switch; none may be read through
-- isKillSwitchEngaged.
--
-- Idempotent; safe to re-run. Writes at most three rows. ON CONFLICT DO
-- NOTHING so a later operator decision about any of them survives a re-run.

BEGIN;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'map_experience_state_enabled',
    FALSE,
    'CAPABILITY. Sensing §7 SX-02/SX-07: lib/mapProjection.applyLiveClaims folds the live claims it already reads into a Sensing §5.3 ExperienceState (payload.experienceState) and stamps §5.1 truthClass + §4.4 coverage on place/event/gem/saved objects; routes/mapProjectionTemporal stamps truthClass=predicted on forecasts. Opens no new read path — the fold is over readLiveClaims output, which is empty in production while intel_live_promoted_scopes is empty. SEEDED FALSE.'
  ),
  (
    'map_world_moments_enabled',
    FALSE,
    'CAPABILITY. Sensing §7 SX-03: lib/mapProducers/worldMomentProducer promotes world_pulse cells that survived §24 into world-change projections (heating_up, forming, moving, clearing, unexpected_activity, event_spillover, traveler_surge) from already-published activity zones, crowd flows and traveler-flow edges. Requires map_world_intelligence_enabled to produce any pulse at all. SEEDED FALSE.'
  ),
  (
    'map_display_resolver_enabled',
    FALSE,
    'CAPABILITY. Sensing §7 SX-08/SX-09: lib/mapDisplayResolver runs between ranking and paging in GET /api/map/projection — safety notices never budgeted, objects at a noticed place stripped of opportunity promotion (payload.safetyConstraint.promotable=false), and a clutter budget allocated by §17 band, §30 mode (mode=) and §13 intent (intent=). The only switch of the three that can remove an object from a page. SEEDED FALSE.'
  )
ON CONFLICT (flag) DO NOTHING;

-- ── Postconditions (present, OFF) ────────────────────────────────────────────
DO $$
DECLARE present int; on_count int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags
    WHERE flag IN ('map_experience_state_enabled', 'map_world_moments_enabled', 'map_display_resolver_enabled');
  IF present <> 3 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: expected 3 map sensing projection flags present, found %', present;
  END IF;
  SELECT count(*) INTO on_count FROM public.feature_flags
    WHERE flag IN ('map_experience_state_enabled', 'map_world_moments_enabled', 'map_display_resolver_enabled')
      AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: a map sensing projection flag is seeded ON — every Sensing §7 map behaviour must ship OFF (found % on)', on_count;
  END IF;
END $$;

COMMIT;

-- REVERSAL: db/rollback/2026-09-07-2350-map-sensing-projection-flags-rollback.sql
-- Removes the three disabled rows (refusing if any has since been turned ON);
-- no served data changes, and no table, grant or policy is touched in either
-- direction.
