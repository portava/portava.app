-- Rollback for 2340_sensing_anon_replay_and_time_bounds.sql
-- Applied by hand to portava-ci (hwokxgbmezheskbzskfr) on 2026-09-07.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb) — the table does not exist there.
--
-- WHAT 2340 DID
-- =============
--   1. CREATE UNIQUE INDEX sensing_anon_contributions_replay_idx
--        ON sensing_anon_contributions (cohort_key, contributor_token)
--   2. ADD CONSTRAINT sensing_anon_contributions_time_bounds_check
--        CHECK (time_bucket <= created_at + 60s AND time_bucket >= created_at - 72h)
--   3. REVOKE ALL ... FROM service_role; GRANT SELECT, INSERT, DELETE TO service_role
--      (the grant 2315 stated, made non-decorative)
--
-- WHAT THIS ROLLBACK DOES
-- =======================
-- Drops (1) and (2). It deliberately does NOT revert (3): reverting it would
-- mean re-granting UPDATE to service_role, which 2315 never intended and which
-- no code path uses. The privilege state after this rollback is exactly what
-- 2315's prose claimed all along.
--
-- WHAT REMOVING THEM DOES TO BEHAVIOUR
-- ====================================
-- Nothing a user can see: the store has no route, no flag and no consumer.
-- Application-side, lib/sensingAnonStore.buildSensingContributionRow still
-- refuses a future or over-age observation before the round trip, and still
-- treats a 23505 as a duplicate; without the index no 23505 is ever raised, so
-- a replay would write a row again. That is the pre-2340 state, not a new one.
--
-- ⚠ REFUSES IF DROPPING THE INDEX WOULD HIDE DUPLICATES.
-- If rows exist that violate the replay key (impossible while the index stands,
-- possible only if someone dropped it by hand and wrote through), this file
-- refuses rather than quietly re-legalising them. The store has 0 rows in CI as
-- of 2026-09-07, so the guard is expected to pass.
--
-- Idempotent: re-running after the objects are gone is a no-op.

BEGIN;

DO $$
DECLARE
  v_dupes int;
BEGIN
  IF to_regclass('public.sensing_anon_contributions') IS NULL THEN
    RETURN; -- nothing to roll back
  END IF;
  SELECT count(*) INTO v_dupes FROM (
    SELECT 1 FROM public.sensing_anon_contributions
     GROUP BY cohort_key, contributor_token HAVING count(*) > 1
  ) d;
  IF v_dupes > 0 THEN
    RAISE EXCEPTION
      'REFUSING: % (cohort_key, contributor_token) pair(s) already have more than one row. Resolve them deliberately before removing the replay key.', v_dupes;
  END IF;
END $$;

DROP INDEX IF EXISTS public.sensing_anon_contributions_replay_idx;

ALTER TABLE IF EXISTS public.sensing_anon_contributions
  DROP CONSTRAINT IF EXISTS sensing_anon_contributions_time_bounds_check;

-- (3) is intentionally not reverted — see the header.

COMMIT;
