-- 2111_trip_crew_ghost_mode_flag_convergence.sql
--
-- STATUS: STAGED — NOT APPLIED. reconciliation-staging/, outside canonical.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- BLOCKED ON: Q13 (feature_flags values — seed conflicts)
--
-- ROLLBACK: a one-row UPDATE, reversible by another UPDATE — BUT the
-- pre-change value must be captured before this file runs, because it is
-- currently unknown (§8 item 9g). See STEP 0 below, following the same
-- snapshot-first convention already used in
-- _incoming/prod-apply-flag-reconciliation.sql for this project's other
-- flag reconciliation.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- STEP 0 — SNAPSHOT BEFORE ANYTHING (run this first, keep the output)
-- ═══════════════════════════════════════════════════════════════════════════
--   SELECT flag, enabled, description, metadata, updated_at
--     FROM public.feature_flags WHERE flag = 'trip_crew_ghost_mode_enabled';
-- That row is the only rollback source. There is no migration that restores
-- an unknown prior value from nothing.
--
-- WHAT THIS RESOLVES
-- ==================
-- RECONCILIATION-PACKET.md §4.3 SEED_VALUE_CONFLICT and §7 row 2111. Five
-- writes to the same flag, all `INSERT ... ON CONFLICT DO NOTHING`:
--
--   false  canonical  0037_feature_flags.sql:41
--   false  canonical  0041_trip_crew_location.sql:65
--   false  root       0041_trip_crew_location.sql:83
--   true   legacy     0041_trip_crew_location.sql:132  (targets column `key`,
--                      which is not this table's PK — `flag` is; this write
--                      plausibly errored or missed its ON CONFLICT target
--                      entirely, but that is an inference, not confirmed)
--   true   legacy     20260702_crew_location_flags_reseed.sql:10 (corrects
--                      the column-name bug above, ON CONFLICT (flag) DO NOTHING)
--
-- CORRECTION TO THE PACKET'S OWN CHARACTERIZATION: every one of these five
-- writes is `ON CONFLICT DO NOTHING`, not an `UPDATE` or
-- `ON CONFLICT ... DO UPDATE`. That makes this FIRST-writer-wins on the
-- `flag` primary key, not "last-writer-wins" as §4.3 states. The practical
-- consequence is identical either way — the live value is unrecoverable
-- from files because apply order is unknown — but the mechanism the packet
-- names is not the one in the file text, and the corrective below (an
-- unconditional UPDATE) is written to be correct regardless of which
-- characterization is right, since it does not depend on conflict
-- resolution order at all.
--
-- WHY FALSE
-- ==========
-- §7's own instruction: "Set trip_crew_ghost_mode_enabled to the single
-- reviewed value, idempotently, from canonical." Canonical's own two writes
-- (0037, 0041) both say `false`; root, the third non-legacy source, agrees.
-- Only the legacy tree ever wrote `true`, and its first attempt targeted
-- the wrong column. This migration sets the value canonical has always
-- declared, not a guess.
--
-- IF THE FLAG IS CURRENTLY TRUE LIVE: this is a real, user-visible behaviour
-- change (§8 item 9g: "If the flag gates a user-visible behaviour, flipping
-- it is a product change, not a schema change. Confirm which way is
-- intended before applying.") — do not run this file on the assumption that
-- flipping a flag is risk-free just because the DDL is one UPDATE.

BEGIN;

-- ── Precondition ─────────────────────────────────────────────────────────
DO $$
DECLARE
  current_value boolean;
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.feature_flags does not exist live.';
  END IF;

  SELECT enabled INTO current_value FROM public.feature_flags WHERE flag = 'trip_crew_ghost_mode_enabled';

  IF current_value IS NULL AND NOT EXISTS (
    SELECT 1 FROM public.feature_flags WHERE flag = 'trip_crew_ghost_mode_enabled'
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: trip_crew_ghost_mode_enabled row does not exist live at all — none of the five seed attempts took effect. Re-derive from Q13 before deciding whether to INSERT instead of UPDATE.';
  END IF;

  RAISE NOTICE '2111: trip_crew_ghost_mode_enabled currently reads % live (captured immediately before this migration''s change — this is the STEP 0 snapshot value, also run separately and keep the output).', current_value;

  IF current_value IS TRUE THEN
    RAISE NOTICE '2111: WARNING — flipping a currently-TRUE flag to false is a user-visible product change, not a no-op. Confirm this is intended before this transaction commits.';
  END IF;
END $$;

-- ── The change ───────────────────────────────────────────────────────────
UPDATE public.feature_flags
   SET enabled = false,
       updated_at = now()
 WHERE flag = 'trip_crew_ghost_mode_enabled';

-- ── Postcondition ────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.feature_flags
    WHERE flag = 'trip_crew_ghost_mode_enabled' AND enabled = false
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: trip_crew_ghost_mode_enabled is not false after this migration ran.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'service_role' AND rolbypassrls
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: service_role no longer has BYPASSRLS.';
  END IF;
END $$;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- ROLLBACK
-- ═══════════════════════════════════════════════════════════════════════════
-- UPDATE public.feature_flags
--    SET enabled = <STEP 0's captured value>, updated_at = now()
--  WHERE flag = 'trip_crew_ghost_mode_enabled';
-- -- There is no way to derive the rollback value from this file or the
-- -- repository — it is whatever STEP 0's snapshot recorded. If STEP 0 was
-- -- skipped, the pre-change value is permanently lost.

-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFICATION (run after apply)
-- ═══════════════════════════════════════════════════════════════════════════
-- SELECT flag, enabled, updated_at FROM public.feature_flags
--  WHERE flag = 'trip_crew_ghost_mode_enabled'; -- expect enabled = false
