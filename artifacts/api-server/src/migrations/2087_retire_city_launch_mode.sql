-- 2087_retire_city_launch_mode.sql
--
-- OUTCOME: DROP and REMOVE-FROM-SEED for a single flag, `city_launch_mode`,
-- on the owner's ruling of 2026-08-13 (ruling #4 of the closeout pass).
--
-- WHY THIS ONE IS RETIRED WHEN THE RECONCILIATION KEPT IT
-- =======================================================
--
-- The flag survived 2086 as KEEP-with-a-defect, recorded in
-- docs/ops/flag-disposition.md: its ONLY reader was the app tree's
-- getActiveKillSwitches() (featureFlags.machine.ts), which drives the red
-- "kill switch active" banner on the admin Feature Flags screen. It sat in
-- KILL_SWITCH_FLAGS beside disable_posting, disable_messaging,
-- disable_rent_buddy_booking and invite_only_beta — each of which ALSO has a
-- server-side isKillSwitchEngaged() call. This one had none. Switching it on
-- announced that a kill switch was engaged while restricting nothing.
--
-- The disposition doc left the remedy — write the server reader, or retire —
-- to the owner. The owner has now ruled: a banner-only kill switch with no
-- server-side enforcement is misleading operational machinery. Retire it.
--
-- WHAT CHANGES ALONGSIDE THIS FILE, IN THE SAME COMMIT
-- ====================================================
--
--   - the seed row is removed from 0117_beta_feature_flags.sql, so a database
--     built by replaying the migrations never creates the row this file
--     deletes (the remove-from-seed half, exactly as 2086 did for 0090/2068);
--   - the app-tree reader is removed: 'city_launch_mode' leaves
--     KILL_SWITCH_FLAGS in travel-buddy-standalone's featureFlags.machine.ts
--     and its label leaves constants/killSwitches.ts, so the banner can no
--     longer announce it (red-proofed by the retirement-guard tests in
--     featureFlags.machine.test.ts, which fail against the pre-change client);
--   - its APP_TREE_READS declaration is removed from
--     scripts/check-flag-polarity.mjs — the reader it vouched for is gone;
--   - verify-db-beta-flags.mjs no longer requires the row to exist live, and
--     the check-db-triggers fixtures now expect six 0117 beta flags, not seven.
--
-- ON DELETE CASCADE — SAME GUARD AS 2080 / 0209 / 2086
-- ====================================================
--
-- 0118_feature_flag_audit_log.sql:8 declares
--     flag TEXT NOT NULL REFERENCES feature_flags(flag) ON DELETE CASCADE
-- so deleting the row destroys its toggle history without warning. This
-- migration REFUSES rather than cascading: if audit rows exist it raises and
-- rolls back, and whoever runs it decides deliberately whether to archive
-- them first.

BEGIN;

-- ── Fail closed on audit history ────────────────────────────────────────────
DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n
    FROM public.feature_flag_audit_log
   WHERE flag = 'city_launch_mode';

  IF n > 0 THEN
    RAISE EXCEPTION
      'REFUSING: % feature_flag_audit_log row(s) reference city_launch_mode. '
      'ON DELETE CASCADE would destroy that toggle history without warning. '
      'Archive those rows first, then re-run. This is a deliberate decision, '
      'not an error to work around.', n;
  END IF;
END $$;

-- ── The retirement itself ───────────────────────────────────────────────────
DELETE FROM public.feature_flags
 WHERE flag = 'city_launch_mode';

-- ── Post-condition: it may not survive ──────────────────────────────────────
DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n
    FROM public.feature_flags
   WHERE flag = 'city_launch_mode';

  IF n <> 0 THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: city_launch_mode still present after DELETE.';
  END IF;
END $$;

-- ── Post-condition: the five REAL kill switches must NOT have been caught ───
-- Every other 0117 kill switch has a server-side reader and must survive.
-- Asserting their survival is cheaper than trusting the WHERE clause above —
-- and it is what makes this file safe to re-run against a database where the
-- retirement has already happened.
DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(f, ', ')
    INTO missing
    FROM unnest(ARRAY[
      'disable_signups',
      'disable_posting',
      'disable_messaging',
      'disable_rent_buddy_booking',
      'invite_only_beta'
    ]) AS f
   WHERE NOT EXISTS (
     SELECT 1 FROM public.feature_flags ff WHERE ff.flag = f
   );

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION
      'POST-CONDITION FAILED: kill switch(es) missing after retirement: %. '
      'These are read by isKillSwitchEngaged() in shipping code and must '
      'survive this migration.', missing;
  END IF;
END $$;

COMMIT;
