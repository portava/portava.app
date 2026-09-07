-- Rollback for 2480_sensing_contribution_sessions.sql
-- NOT APPLIED anywhere; 2480 itself is NOT applied anywhere (owner runs all SQL).
-- Dry-run only inside a rolled-back transaction on portava-ci, 2026-09-07.
--
-- WHAT 2480 DID
-- =============
-- Created public.sensing_contribution_sessions (no FK, no identity column),
-- three SECURITY DEFINER functions (sensing_session_consume,
-- revoke_sensing_session, purge_expired_sensing_sessions), service_role-only
-- RLS with no UPDATE grant.
--
-- WHAT THIS DOES
-- ==============
-- Drops the three functions and the table. If 2481 was applied afterwards,
-- its issuer FK and function go with the table (DROP ... CASCADE is NOT used;
-- 2481's own rollback must run first — the guard below refuses otherwise).
--
-- ⚠ REFUSES IF THE TABLE STILL HOLDS UNEXPIRED, UNREVOKED SESSIONS.
-- Dropping them silently invalidates credentials devices still hold. Revoke or
-- let them expire first, then re-run.
--
-- Idempotent: re-running after the objects are gone is a no-op.

BEGIN;

DO $$
DECLARE v_live int;
BEGIN
  IF to_regclass('public.sensing_contribution_sessions') IS NULL THEN RETURN; END IF;
  PERFORM 1 FROM pg_constraint WHERE conname = 'sensing_contribution_sessions_issuer_fk';
  IF FOUND THEN
    RAISE EXCEPTION 'REFUSING: 2481''s issuer FK is present. Run the 2481 rollback first.';
  END IF;
  SELECT count(*) INTO v_live FROM public.sensing_contribution_sessions
   WHERE revoked_at IS NULL AND expires_at > now();
  IF v_live > 0 THEN
    RAISE EXCEPTION 'REFUSING: % live session(s) would be silently invalidated. Revoke them or let them expire, then re-run.', v_live;
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.sensing_session_consume(text, timestamptz);
DROP FUNCTION IF EXISTS public.revoke_sensing_session(text, timestamptz);
DROP FUNCTION IF EXISTS public.purge_expired_sensing_sessions(timestamptz);
DROP TABLE IF EXISTS public.sensing_contribution_sessions;

COMMIT;
