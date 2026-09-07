-- 2361_discovery_candidate_projection_flag.sql
-- Discovery — ONE capability flag for the server-built DiscoveryCandidate
-- projection (Sensing §8 line 135; §5.1 truth/confidence/freshness), seeded OFF.
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2361.
--
-- Additive + idempotent. Safe to re-run. Seeds exactly one flag with a LIVE
-- reader (check-flag-polarity rule: "a flag arrives with the unit that reads
-- it"). `*_enabled` ⇒ CAPABILITY convention: read fail-closed via isFlagEnabled.
--
-- WHAT THE FLAG GATES
--   lib/discoveryCandidate.ts withDiscoveryCandidates, called at the four
--   GET /api/discovery serialisation sites (cache-A serve, Compass candidate
--   hit, Compass fresh rank, cold fetch). ON: every served place carries an
--   additive `candidate` object — { whyNow: null, whyForUser, rankedBy,
--   confidence, freshness, truthClass }. OFF (the seed): the route hands back
--   the same array it was given; the served JSON is byte-identical to today.
--
-- WHY OFF: Discovery is a live surface; nothing changes what a user sees until
-- an owner flips a flag. The mapping defaults in the module header (truth-class
-- rules, confidence priors) are recorded for ratification, not assumed.
--
-- Reader: lib/discoveryCandidate.ts (DISCOVERY_CANDIDATE_PROJECTION_FLAG, literal).
-- Rollback: db/rollback/2026-09-07-2361-discovery-candidate-projection-rollback.sql
-- RUNTIME EFFECT: NONE with the flag absent or false.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.feature_flags does not exist.';
  END IF;
END $$;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'discovery_candidate_projection_enabled',
    false,
    'Discovery: server-built DiscoveryCandidate projection (Sensing §8/§5.1). ON: every place served by GET /api/discovery carries an additive `candidate` { whyNow (always null — no live producer), whyForUser (ranker feature keys, ≤3), rankedBy, confidence (class prior), freshness (serve point + cache age), truthClass (corroborated|observed|stale|unknown) }. OFF (the seed): served JSON byte-identical to before. Fail-closed (isFlagEnabled). Read by lib/discoveryCandidate.ts. Mapping defaults await owner ratification; enabling is an owner decision.'
  )
ON CONFLICT (flag) DO NOTHING;

DO $$
DECLARE present int; on_count int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags
    WHERE flag = 'discovery_candidate_projection_enabled';
  IF present <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: expected discovery_candidate_projection_enabled present, found %', present;
  END IF;
  SELECT count(*) INTO on_count FROM public.feature_flags
    WHERE flag = 'discovery_candidate_projection_enabled' AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: discovery_candidate_projection_enabled seeded ON — Discovery is live and this must ship OFF';
  END IF;
END $$;

COMMIT;
