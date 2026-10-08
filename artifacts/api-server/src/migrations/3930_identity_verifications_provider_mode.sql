-- 3930_identity_verifications_provider_mode.sql
-- Lane B (payments / identity / Trust), mission 2026-10-05. Written, NOT applied
-- to any database by the lane that wrote it.
--
-- ── WHAT ─────────────────────────────────────────────────────────────────────
-- Adds `public.identity_verifications.provider_mode text NULL`, constrained to
-- 'test' | 'live' | 'local_mock'. One nullable column, one CHECK, one COMMENT.
-- No row is written, no default is set, no grant changes, no flag is read.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────
-- The owner ruled (2026-10-04) that first-release Rent-a-Buddy bookings require
-- REAL identity verification: "No tester bypass or sandbox verification key."
-- An `identity_verifications` row does not say which kind of key produced it.
-- A Stripe Identity / Persona / Sumsub session created with a SANDBOX key
-- reaches `status = 'verified'` exactly as a live one does (the vendors'
-- sandboxes approve test documents on demand), so without this column a
-- sandbox approval is indistinguishable from a real one, and the day the
-- deployment's key is switched to live every sandbox-era approval would be
-- grandfathered into booking eligibility. Hosted testing shares production's
-- tables, so those rows are in the same table real users' rows land in.
--
-- `routes/verification.ts` now records the mode at session creation
-- (`services/identityVerification/currentVerification.ts sessionProviderMode`):
-- the key that creates a session is the key the provider's events for that
-- session belong to.
--
-- ── NULL IS "UNKNOWN", AND UNKNOWN DOES NOT COUNT ───────────────────────────
-- Every row written before this column existed is NULL. No backfill is
-- possible — nothing recorded which key was in use — and none is attempted:
-- inventing 'live' for a legacy row would be the bypass this file exists to
-- close. `readCurrentIdentityVerification` reads NULL as `mode_unrecorded`,
-- which is not verified. A user with only a legacy row re-verifies.
--
-- ── DEPLOY ORDER ─────────────────────────────────────────────────────────────
-- Apply BEFORE deploying the API that writes the column. Without it,
-- `POST /api/verification/session` fails its INSERT with 42703 and answers
-- `db_error`: no user can START verification (fail-closed — nobody becomes
-- verified, nobody is let through). Rolling back: deploy the previous API,
-- then `ALTER TABLE public.identity_verifications DROP COLUMN provider_mode;`
-- (the column carries no data any other object depends on).

ALTER TABLE public.identity_verifications
  ADD COLUMN IF NOT EXISTS provider_mode text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'identity_verifications_provider_mode_check'
      AND conrelid = 'public.identity_verifications'::regclass
  ) THEN
    ALTER TABLE public.identity_verifications
      ADD CONSTRAINT identity_verifications_provider_mode_check
      CHECK (provider_mode IS NULL OR provider_mode IN ('test', 'live', 'local_mock'));
  END IF;
END $$;

COMMENT ON COLUMN public.identity_verifications.provider_mode IS
  'Mode of the key that created this verification session: test (sandbox key), live, or local_mock (unsigned mock, local runs only). NULL = not recorded (written before 3930). Only live counts as a real verification on a hosted deployment (currentVerification.ts).';

-- ── POSTCONDITIONS ───────────────────────────────────────────────────────────
DO $$
DECLARE
  v_type text;
  v_nullable text;
  v_default text;
BEGIN
  SELECT data_type, is_nullable, column_default
    INTO v_type, v_nullable, v_default
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'identity_verifications' AND column_name = 'provider_mode';

  IF v_type IS NULL THEN
    RAISE EXCEPTION '3930: POSTCONDITION FAILED: identity_verifications.provider_mode does not exist';
  END IF;
  IF v_type <> 'text' THEN
    RAISE EXCEPTION '3930: POSTCONDITION FAILED: provider_mode is %, expected text', v_type;
  END IF;
  IF v_nullable <> 'YES' THEN
    RAISE EXCEPTION '3930: POSTCONDITION FAILED: provider_mode must be nullable (NULL = unrecorded, which does not count)';
  END IF;
  IF v_default IS NOT NULL THEN
    RAISE EXCEPTION '3930: POSTCONDITION FAILED: provider_mode must have NO default (a default would assert a mode nobody recorded): %', v_default;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'identity_verifications_provider_mode_check'
      AND conrelid = 'public.identity_verifications'::regclass
      AND contype = 'c'
  ) THEN
    RAISE EXCEPTION '3930: POSTCONDITION FAILED: identity_verifications_provider_mode_check is missing';
  END IF;
  IF EXISTS (SELECT 1 FROM public.identity_verifications WHERE provider_mode IS NOT NULL) THEN
    -- Not an error on a database where the API already wrote the column after an
    -- earlier apply; it IS an error if this file wrote anything. It wrote nothing,
    -- so a non-null row here came from the API. Report it, do not fail.
    RAISE NOTICE '3930: identity_verifications already holds rows with provider_mode set (written by the API, not by this file)';
  END IF;
END $$;
