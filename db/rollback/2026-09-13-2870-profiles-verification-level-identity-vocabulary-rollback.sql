-- Rollback for 2870_profiles_verification_level_identity_vocabulary.sql
-- Written 2026-09-13. NOT APPLIED ANYWHERE.
--
-- ⚠ THIS ROLLBACK IS DESTRUCTIVE OF EVIDENCE, AND THAT IS NOT AVOIDABLE.
-- Narrowing the constraint requires that no row hold a value the narrowed
-- constraint rejects, so any profile that has COMPLETED a provider
-- government-ID check must first be reset to 'none'. That erases the record
-- that the check happened, in the column every gate reads
-- (lib/travelerVerification.ts, routes/rentABuddyRollout.ts).
--
-- It is therefore safe ONLY while no identity verification has completed.
-- Measured on production 2026-09-13, read-only: `identity_verifications` 0 rows
-- and 0 of 58 profiles hold a verification_level other than 'none'. RE-MEASURE
-- BEFORE RUNNING — the guard below refuses rather than trusting that reading.
--
-- Run the whole file. It is one transaction and it aborts rather than erasing.

BEGIN;

-- ── Refuse if any identity-verified row exists ───────────────────────────────
DO $$
DECLARE
  n BIGINT;
BEGIN
  SELECT count(*) INTO n
  FROM public.profiles
  WHERE verification_level IN ('id_verified', 'id_selfie_verified');

  IF n > 0 THEN
    RAISE EXCEPTION
      'REFUSING TO ROLL BACK 2870: % profile(s) hold an identity verification level. '
      'Narrowing the constraint would require resetting them to ''none'', which erases '
      'evidence of a completed government-ID check. Decide what those rows should become '
      '(owner decision D-LEVEL-VOCAB) and migrate them deliberately, then re-run with '
      'this guard removed.', n;
  END IF;
END $$;

-- ── Restore the pre-2870 constraint ──────────────────────────────────────────
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_verification_level_check;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_verification_level_check
  CHECK (verification_level = ANY (ARRAY[
    'none'::text,
    'basic_verified'::text,
    'trusted_traveler'::text,
    'host_verified'::text,
    'buddy_verified'::text
  ]));

COMMENT ON COLUMN public.profiles.verification_level IS NULL;

-- ── Postcondition: the two identity levels are gone, the five remain ─────────
DO $$
DECLARE
  def TEXT;
  v   TEXT;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO def
  FROM pg_constraint c
  JOIN pg_class t     ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public' AND t.relname = 'profiles'
    AND c.conname = 'profiles_verification_level_check';

  IF def IS NULL THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED: the constraint is absent.';
  END IF;
  IF position('''id_verified''' in def) > 0 OR position('''id_selfie_verified''' in def) > 0 THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED: an identity level survives in %', def;
  END IF;
  FOREACH v IN ARRAY ARRAY['none','basic_verified','trusted_traveler','host_verified','buddy_verified']
  LOOP
    IF position('''' || v || '''' in def) = 0 THEN
      RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED: % was dropped: %', v, def;
    END IF;
  END LOOP;
END $$;

COMMIT;
