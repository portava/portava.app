-- Rollback for artifacts/api-server/src/migrations/2740_layover_presence_ladder_flag.sql
--
-- 2740 seeds one feature-flag row and touches nothing else, so the rollback is
-- one DELETE. `isFlagEnabled` is fail-closed, so an absent row already reads
-- FALSE — removing it restores exactly the pre-2740 behaviour and cannot turn
-- the ladder on by accident.
--
-- If an owner has already flipped the flag TRUE, deleting the row turns the
-- aggregate-only ladder OFF and restores the named-profile response. That is
-- the intended direction of a rollback; it is stated here so it is not a
-- surprise.

BEGIN;

DELETE FROM public.feature_flags WHERE flag = 'layover_presence_ladder_enabled';

COMMIT;
