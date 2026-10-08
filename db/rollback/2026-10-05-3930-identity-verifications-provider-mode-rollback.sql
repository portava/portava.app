-- Rollback for 3930_identity_verifications_provider_mode.sql
-- Written 2026-10-05 by lane B (payments / identity / Trust). NOT rehearsed on a
-- database: this machine has no PostgreSQL. NOT run against portava-ci or production.
--
-- RUN IT SO THAT A REFUSAL STOPS THE RUN:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/rollback/2026-10-05-3930-identity-verifications-provider-mode-rollback.sql
--
-- ORDER: deploy the API that does NOT write provider_mode FIRST, then run this.
-- Run against an API that still writes the column, every verification session
-- INSERT fails with 42703 (fail-closed: nobody can start verification).
--
-- WHAT IS LOST: the recorded key mode of every attempt made since 3930. Without
-- it, `readCurrentIdentityVerification` can no longer tell a live verification
-- from a sandbox one, so every person reads `mode_unrecorded` (not verified) and
-- Rent-a-Buddy bookings stay closed until 3930 is re-applied and people
-- re-verify. That is the safe direction; it is still a loss, so this refuses
-- while any LIVE row exists unless the operator removes that guard on purpose.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'identity_verifications' AND column_name = 'provider_mode'
  ) AND EXISTS (SELECT 1 FROM public.identity_verifications WHERE provider_mode = 'live') THEN
    RAISE EXCEPTION '3930 rollback REFUSED: identity_verifications holds live-mode attempts; dropping provider_mode would make every one of them unrecorded';
  END IF;
END $$;

ALTER TABLE public.identity_verifications DROP CONSTRAINT IF EXISTS identity_verifications_provider_mode_check;
ALTER TABLE public.identity_verifications DROP COLUMN IF EXISTS provider_mode;

DO $$
BEGIN
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL THEN
    DELETE FROM public.schema_migration_ledger WHERE filename = '3930_identity_verifications_provider_mode.sql';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'identity_verifications' AND column_name = 'provider_mode'
  ) THEN
    RAISE EXCEPTION '3930 rollback FAILED: provider_mode still exists';
  END IF;
END $$;

COMMIT;
