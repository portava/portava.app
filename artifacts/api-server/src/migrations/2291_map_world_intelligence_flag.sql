-- 2291_map_world_intelligence_flag.sql
-- Portava Map — §36 Phase 7 "World Intelligence": ONE capability flag, seeded OFF.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Map Phase 7 lane 2291.
--
-- Additive + idempotent. Safe to re-run. Seeds exactly one flag, and it has a
-- LIVE reader (check-flag-polarity's rule: "a flag arrives with the unit that
-- reads it"). `*_enabled` ⇒ CAPABILITY convention: read fail-closed through
-- isFlagEnabled, so an unreadable flag leaves all of Phase 7 OFF, never on.
--
-- NO TABLE, NO COLUMN, NO GRANT, NO POLICY. That is the whole point of the
-- shape Phase 7 was built in: every one of its four producers reads sources
-- that ALREADY EXIST and are ALREADY AGGREGATED by something else —
--
--   world_pulse     the §31 viewport aggregation's own output (activity zones
--                   that already cleared summarizeCell's k floor, crowd flows
--                   that already cleared §10's four gates) plus public venue
--                   and event density. It never reads a presence row.
--   traveler_flow   lib/routeHopSignal.readAcceptedPlanHops — accepted route
--                   plans, per-accepter consent from
--                   route_flow_contribution_consent (2224), coordinates
--                   quarantined into zone ids, group-keyed. Phase 7 injects a
--                   CITY resolver where §10 injects a zone resolver; the read
--                   path, the consent record and the lawful basis are the same
--                   ones 2224 established.
--   city_model      compass_city_models (20260730_compass_intelligence_graph),
--                   which is already a per-city aggregate.
--   personal_city   passport_stamps rows belonging to the VIEWER, scoped by
--                   session identity, never by a query parameter.
--
-- So there is no new personal-data store to create, no new RLS surface, and
-- nothing to add to rlsDispositions / deletionDispositions: Phase 7 introduces
-- no table. A migration that DID create one here would mean a producer had
-- invented a source rather than consuming a published one.
--
-- WHAT THE FLAG GATES — all four, together, or none. One flag rather than four
-- because they are one capability: World Pulse without the city model is a
-- concentration heat cell you cannot open, and the traveler-flow graph is the
-- movement half of the same world view. Four switches would invite the
-- half-enabled state where a viewer sees an aggregate they cannot interrogate.
--
-- RUNTIME EFFECT: NONE. With the flag absent or false, GET /api/map/projection
-- returns exactly what it returned before this migration: the four Phase 7
-- kinds are collected by nothing, `worldIntelligence` reports refusal
-- 'flag_off', and no Phase 7 read of any kind is issued (the flag is checked
-- BEFORE the first query, so a disabled layer costs zero round-trips).
-- src/test/mapWorldIntelligenceLayer.test.ts asserts the flag-off response is
-- byte-identical to the pre-Phase-7 one.

BEGIN;

-- ── Preconditions ────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.feature_flags does not exist.';
  END IF;
END $$;

-- ── Seed (CAPABILITY, OFF) ───────────────────────────────────────────────────
INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'map_world_intelligence_enabled',
    false,
    'Map spec §36 Phase 7 World Intelligence, as ONE switch: World Pulse (a world/continent-band concentration cell summarizing the §31 aggregation''s OWN already-k-gated output plus public venue/event density — never presence), the traveler-flow graph (city-to-city aggregate movement from consented accepted-plan hops, cohort published as a bucket and never as a number), the per-city aggregate profile (rhythm by time band from compass_city_models, each slice independently k-gated), and the viewer''s OWN city history summary (their passport_stamps rows only, owner-scoped by session identity). OFF (the seed): GET /api/map/projection collects none of the four kinds and issues no Phase 7 read at all. Every producer fails CLOSED on a read error — an unreadable source yields a refusal and no object, never an ungated one. Fail-closed (isFlagEnabled). Read by lib/mapProducers/worldIntelligence.ts (WORLD_INTELLIGENCE_FLAG) and routes/mapProjection.ts.'
  )
ON CONFLICT (flag) DO NOTHING;

-- ── Postconditions (present, OFF) ────────────────────────────────────────────
DO $$
DECLARE present int; on_count int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags
    WHERE flag = 'map_world_intelligence_enabled';
  IF present <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: expected map_world_intelligence_enabled present, found %', present;
  END IF;
  SELECT count(*) INTO on_count FROM public.feature_flags
    WHERE flag = 'map_world_intelligence_enabled' AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: map_world_intelligence_enabled seeded ON — Phase 7 must ship OFF';
  END IF;
END $$;

COMMIT;

-- REVERSAL (manual):
--   DELETE FROM public.feature_flags WHERE flag = 'map_world_intelligence_enabled';
-- The reversal removes a disabled capability flag; no served data changes, and
-- no table, grant or policy is touched by this migration in either direction.
