-- Rollback for artifacts/api-server/src/migrations/2361_discovery_candidate_projection_flag.sql
-- Idempotent: safe to run whether or not 2361 was applied.
-- Removes the seeded capability flag. With the row absent, isFlagEnabled
-- returns false and withDiscoveryCandidates returns its input unchanged.
-- 2361 created no table, column, policy or grant.
BEGIN;
DELETE FROM public.feature_flags WHERE flag = 'discovery_candidate_projection_enabled';
DO $$
DECLARE remaining int;
BEGIN
  SELECT count(*) INTO remaining FROM public.feature_flags
    WHERE flag = 'discovery_candidate_projection_enabled';
  IF remaining <> 0 THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED: discovery_candidate_projection_enabled still present (%)', remaining;
  END IF;
END $$;
COMMIT;
