-- Migration 2218: feature flag for Map spec §10 Crowd Flow
--
-- NO TABLES, NO COLUMNS, NO DATA MODEL. Crowd flow aggregates are DERIVED at
-- read time from signals that already exist (lib/crowdFlowProducer +
-- lib/mapAggregation.deriveCrowdFlow), exactly as lib/trailFollowup derives its
-- movement aggregates with "no table of its own". A flow is recomputable from
-- surviving observations, so storing one would only create a second copy of
-- personal data to retain, purge and erase — the opposite of what §10 wants.
--
-- WHAT THIS DOES: seeds one flag row, OFF.
--
--   map_crowd_flow_enabled → lib/crowdFlowProducer.readCrowdFlowSignals
--
-- WHY A FLAG AT ALL. The producer reads `intel_observations` rows captured under
-- D4 consent (`intel_contribution_consent`, migration 2172) and turns them into
-- a PUBLIC aggregate. Every capability in this repository that publishes from
-- that consent-scoped store is gated by a default-off flag (INTEL_FLAGS in
-- lib/intelContracts.ts); this follows that convention rather than becoming the
-- one publisher that turns itself on at deploy.
--
-- The name ends in `_enabled`, so scripts/check-flag-polarity.mjs classifies it
-- automatically and no CLASSIFIED entry is needed.
--
-- APPLYING THIS ENABLES NOTHING. Four independent things still hold crowd flow
-- shut, and they are recorded in the lib/crowdFlowProducer header:
--
--   1. This flag is FALSE.
--   2. No route calls `produceZoneTransitions` or `deriveCrowdFlow`. There is
--      no HTTP surface for crowd flow at all, so nothing can ask for one.
--   3. Both consent tables (`intel_contribution_consent`,
--      `route_flow_contribution_consent`) are default-off and empty, and
--      consent is checked per contributor at READ time, so a withdrawal is
--      immediate and retroactive rather than eventual.
--   4. The caller must inject both zone resolvers; without them the read
--      refuses rather than falling back to a coordinate.
--
-- SUPERSEDED CLAIM, kept visible rather than quietly deleted: this header used
-- to say the repository feeds "exactly ONE" family and that
-- `readCrowdFlowSignals` therefore refuses to issue its query at all.
-- Migration 2224 added a SECOND family (`accepted_plan`, derived from accepted
-- route plans), so that sentence is no longer true and the blanket refusal no
-- longer fires.
--
-- Read that as a narrower change than it sounds. The second family clears the
-- audit's four-part bar on SOURCE independence (different table, consent
-- record, capture service and traveller act), but both families are
-- self-reported INTENT rather than measured movement, and their populations
-- overlap: one person can accept a plan and file a next-move contribution for
-- the same edge. Two families here therefore certify two independent SOURCES,
-- not two independent POPULATIONS. That residual is recorded in
-- `ACCEPTED_PLAN_INDEPENDENCE.residualCorrelation`, and a test fails if anyone
-- empties it. The confidence ladder is the mitigation and is unchanged: two
-- families still cap the band at `provisional`; `likely_current` needs three.
--
-- Idempotent; safe to re-run.

INSERT INTO feature_flags (flag, enabled, description) VALUES
  ('map_crowd_flow_enabled', FALSE,
   'Map spec §10 Crowd Flow: derive aggregate zone-to-zone movement from anonymized signal families and publish it as crowd_flow MapObjects, gated on cohort density, multiple signal families, freshness and the k-anonymity privacy gate. Derived at read time; no storage.')
ON CONFLICT (flag) DO NOTHING;

-- Postcondition: the flag exists (mirrors 2166's shape).
DO $$
DECLARE
  present integer;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags WHERE flag = 'map_crowd_flow_enabled';
  IF present <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: map_crowd_flow_enabled not present after seed';
  END IF;
END $$;
