-- Migration 2214: feature flag for Map spec §10 Crowd Flow
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
-- APPLYING THIS ENABLES NOTHING. Two independent things still hold crowd flow
-- shut, and both are recorded in the lib/crowdFlowProducer header:
--
--   1. This flag is FALSE.
--   2. §10 requires MIN_SIGNAL_FAMILIES (2) OBSERVED signal families and this
--      repository feeds exactly ONE (`next_stop_contribution`, itself behind
--      `intel_trail_followup`, also off). `readCrowdFlowSignals` therefore
--      refuses to issue its query at all — it will not process consent-scoped
--      contribution rows for a result that provably cannot publish.
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
