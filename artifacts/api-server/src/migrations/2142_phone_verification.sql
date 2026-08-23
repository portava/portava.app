-- 2142_phone_verification.sql
-- Phone verification: the capability the product gated on but never had.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- ── WHY ─────────────────────────────────────────────────────────────────────
-- All 13 rent_buddy_launch_controls rows carry require_phone_verification =
-- true, and the booking path enforces it. But there was no phone-verification
-- signal anywhere in the product except rent_buddy_profiles.phone_verified — a
-- column on the BUDDY table, written by nothing, and absent for any traveller
-- who never applied to be a buddy. `profiles` has no phone column at all and
-- auth.users.phone_confirmed_at is never read. So the requirement was
-- unsatisfiable by construction: a policy the code demanded and the schema
-- could not express.
--
-- This puts the verified state on `profiles`, where the rest of the app's
-- identity signals already live (date_of_birth, dob_verified, id_verified_at,
-- verification_level), so every surface can read it rather than only the buddy
-- subsystem.
--
-- ── WHAT THIS DOES NOT DO ───────────────────────────────────────────────────
-- It does not make anyone verified. Columns default to NULL/unverified and are
-- written only by PhoneVerificationService after a challenge is confirmed. It
-- also does not backfill rent_buddy_profiles.phone_verified — that column stays
-- as the buddy subsystem's own record; the traveller-side gate reads profiles.
--
-- SAFE TO RE-RUN. Every statement is guarded.

BEGIN;

-- ── 1. Verified phone state on profiles ─────────────────────────────────────
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS phone_e164        text,
  ADD COLUMN IF NOT EXISTS phone_verified_at timestamptz;

COMMENT ON COLUMN public.profiles.phone_e164 IS
  'E.164 phone number, set only once a challenge is confirmed. NULL = no verified phone. '
  'Personal data: erased by account deletion (see deletionDispositions).';
COMMENT ON COLUMN public.profiles.phone_verified_at IS
  'When the number in phone_e164 was confirmed. NULL = unverified. '
  'Presence of a timestamp is the authoritative traveller-side phone signal.';

-- E.164 shape only. Deliberately permissive about which country codes exist —
-- this validates format, not routability, and the provider is the authority on
-- whether a number can actually receive a message.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'profiles_phone_e164_format'
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_phone_e164_format
      CHECK (phone_e164 IS NULL OR phone_e164 ~ '^\+[1-9][0-9]{6,14}$');
  END IF;
END $$;

-- A verified number identifies one account. Without this, one phone could
-- verify unlimited accounts and the signal would be worth nothing as an
-- anti-Sybil measure — which is most of why it is being collected.
-- Partial, so unverified/NULL rows are unconstrained.
CREATE UNIQUE INDEX IF NOT EXISTS profiles_phone_e164_verified_unique
  ON public.profiles (phone_e164)
  WHERE phone_e164 IS NOT NULL AND phone_verified_at IS NOT NULL;

-- ── 2. Challenge table ──────────────────────────────────────────────────────
-- Codes are NEVER stored in plaintext. code_hash is sha256(id || ':' || code);
-- the row's own random uuid is the salt, so two identical codes hash
-- differently and a leaked table cannot be reversed by a rainbow table.
CREATE TABLE IF NOT EXISTS public.phone_verification_challenges (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  phone_e164    text NOT NULL,
  code_hash     text NOT NULL,
  attempts      integer NOT NULL DEFAULT 0,
  max_attempts  integer NOT NULL DEFAULT 5,
  expires_at    timestamptz NOT NULL,
  consumed_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT phone_challenge_e164_format
    CHECK (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  CONSTRAINT phone_challenge_attempts_sane
    CHECK (attempts >= 0 AND max_attempts > 0)
);

COMMENT ON TABLE public.phone_verification_challenges IS
  'Outstanding phone-verification challenges. Codes are stored only as '
  'sha256(id || '':'' || code). Rows are short-lived and swept after expiry.';

-- The hot lookup: newest live challenge for a user.
CREATE INDEX IF NOT EXISTS phone_challenges_user_active_idx
  ON public.phone_verification_challenges (user_id, created_at DESC)
  WHERE consumed_at IS NULL;

-- Sweep support.
CREATE INDEX IF NOT EXISTS phone_challenges_expiry_idx
  ON public.phone_verification_challenges (expires_at)
  WHERE consumed_at IS NULL;

-- ── 3. RLS ──────────────────────────────────────────────────────────────────
-- A challenge row is a credential in flight. No client ever needs to read one:
-- the code arrives by SMS and is submitted back through the API, which uses the
-- service role. So RLS is enabled with NO policy for anon/authenticated at all,
-- which denies everything to them while leaving the service role unaffected.
ALTER TABLE public.phone_verification_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.phone_verification_challenges FORCE ROW LEVEL SECURITY;

REVOKE ALL ON public.phone_verification_challenges FROM anon, authenticated;

-- ── 4. Post-conditions ──────────────────────────────────────────────────────
DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'profiles'
     AND column_name IN ('phone_e164', 'phone_verified_at');
  IF n <> 2 THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: expected 2 phone columns on profiles, found %', n;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relname = 'phone_verification_challenges' AND relkind = 'r'
  ) THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: phone_verification_challenges was not created';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND indexname = 'profiles_phone_e164_verified_unique'
  ) THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: verified-phone uniqueness index missing — '
                    'one phone could verify many accounts';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname = 'public'
       AND c.relname = 'phone_verification_challenges'
       AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: RLS is not enabled on phone_verification_challenges';
  END IF;
END $$;

COMMIT;
