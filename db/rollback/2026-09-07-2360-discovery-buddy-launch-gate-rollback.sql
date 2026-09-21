-- Rollback for artifacts/api-server/src/migrations/2360_discovery_buddy_launch_gate_flag.sql
-- Idempotent: safe to run whether or not 2360 was applied.
--
-- Removes the seeded capability flag. With the row absent, isFlagEnabled
-- returns false and routes/discoverySearch.ts searchTravelers(isBuddy) runs
-- the pre-2360 behaviour — no marketplace-launch check. Nothing else to undo:
-- 2360 created no table, column, policy or grant.
BEGIN;
DELETE FROM public.feature_flags WHERE flag = 'discovery_buddy_launch_gate_enabled';
DO $$
DECLARE remaining int;
BEGIN
  SELECT count(*) INTO remaining FROM public.feature_flags
    WHERE flag = 'discovery_buddy_launch_gate_enabled';
  IF remaining <> 0 THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED: discovery_buddy_launch_gate_enabled still present (%)', remaining;
  END IF;
END $$;
COMMIT;
