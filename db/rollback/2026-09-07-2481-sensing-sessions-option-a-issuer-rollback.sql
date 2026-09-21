-- Rollback for 2481_sensing_sessions_option_a_issuer.sql (OPTION A only)
-- NOT APPLIED anywhere; 2481 itself is NOT applied anywhere (owner runs all SQL).
-- Dry-run only inside a rolled-back transaction on portava-ci, 2026-09-07.
--
-- WHAT 2481 DID
-- =============
-- Added the nullable issuance-ledger column issued_to_profile_id (FK → profiles,
-- ON DELETE CASCADE), the Option A consistency CHECK, a partial index, and
-- revoke_sensing_sessions_for_profile().
--
-- WHAT THIS DOES
-- ==============
-- Removes all four, leaving 2480's table intact. Run BEFORE the 2480 rollback.
--
-- ⚠ REFUSES IF LIVE PROFILE-ISSUED SESSIONS EXIST: dropping the column strips
-- the operator's ability to revoke them by account. Revoke first, then re-run.
--
-- Idempotent.

BEGIN;

DO $$
DECLARE v_live int;
BEGIN
  IF to_regclass('public.sensing_contribution_sessions') IS NULL THEN RETURN; END IF;
  PERFORM 1 FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'sensing_contribution_sessions' AND column_name = 'issued_to_profile_id';
  IF NOT FOUND THEN RETURN; END IF;
  EXECUTE 'SELECT count(*) FROM public.sensing_contribution_sessions WHERE issued_to_profile_id IS NOT NULL AND revoked_at IS NULL AND expires_at > now()'
     INTO v_live;
  IF v_live > 0 THEN
    RAISE EXCEPTION 'REFUSING: % live profile-issued session(s). Revoke them (revoke_sensing_sessions_for_profile) first, then re-run.', v_live;
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.revoke_sensing_sessions_for_profile(uuid, timestamptz);
DROP INDEX IF EXISTS public.sensing_contribution_sessions_issuer_idx;
ALTER TABLE IF EXISTS public.sensing_contribution_sessions
  DROP CONSTRAINT IF EXISTS sensing_contribution_sessions_option_a_check;
ALTER TABLE IF EXISTS public.sensing_contribution_sessions
  DROP CONSTRAINT IF EXISTS sensing_contribution_sessions_issuer_fk;
ALTER TABLE IF EXISTS public.sensing_contribution_sessions
  DROP COLUMN IF EXISTS issued_to_profile_id;

COMMIT;
