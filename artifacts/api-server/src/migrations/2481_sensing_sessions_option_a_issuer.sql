-- 2481_sensing_sessions_option_a_issuer.sql
-- OPTION A ONLY (SENSING_AUTH_POSTURE = authenticated_only). Do NOT apply under
-- Option B; under Option B this file is never run and the column never exists.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- NOT APPLIED. The owner runs all SQL. Dry-run inside a ROLLED-BACK transaction
-- on portava-ci only. Nothing was committed to any database.
-- ══════════════════════════════════════════════════════════════════════════════
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2481.
-- Requires 2480. Additive and idempotent.
--
-- ── WHAT THIS ADDS, AND THE §3 JUSTIFICATION IT OWES ─────────────────────────
-- §3: "World-intelligence contribution records should not carry a permanent
-- profiles.id / account user_id foreign key unless a narrowly justified,
-- reviewed security requirement proves it necessary."
--
-- This file adds `issued_to_profile_id` to the SESSION row — the issuance
-- ledger — and to NOTHING else. The justification is narrow and named:
--   * it is the abuse control Option A depends on: an operator can revoke every
--     credential an abusive account obtained (revoke_sensing_sessions_for_profile)
--     and the profile-keyed rate limit has a durable record to reconcile against;
--   * it is SHORT-LIVED: the row it sits on cannot outlive 72 hours (2480's
--     lifetime CHECK) and is purged on expiry, so no permanent movement history
--     accrues — a profile ↔ credential mapping that lasts a day is not a track;
--   * it never reaches a contribution: 2315 forbids session_id / credential_hash
--     on sensing_anon_contributions, and 2480's postcondition re-asserts it. A
--     contribution's contributor_token is derived from a DEVICE-side commitment
--     the session never sees, so even with this ledger the server cannot map a
--     stored contribution back to the profile that obtained the credential.
--   * ON DELETE CASCADE: deleting the profile deletes its sessions (and
--     erase_intel_for_actor-style erasure has nothing else to reach — the
--     contributions were never linked).
--
-- ── CONSISTENCY ──────────────────────────────────────────────────────────────
-- issuance_class = 'authenticated_profile' ⇔ issued_to_profile_id IS NOT NULL.
-- Under Option A every session is profile-issued, so the CHECK below is the
-- posture made structural: an anonymous session row cannot be written.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.sensing_contribution_sessions') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: sensing_contribution_sessions (2480) is absent.';
  END IF;
  IF to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.profiles is absent.';
  END IF;
END $$;

ALTER TABLE public.sensing_contribution_sessions
  ADD COLUMN IF NOT EXISTS issued_to_profile_id uuid;

DO $$
BEGIN
  PERFORM 1 FROM pg_constraint WHERE conname = 'sensing_contribution_sessions_issuer_fk';
  IF NOT FOUND THEN
    ALTER TABLE public.sensing_contribution_sessions
      ADD CONSTRAINT sensing_contribution_sessions_issuer_fk
      FOREIGN KEY (issued_to_profile_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
  END IF;
  PERFORM 1 FROM pg_constraint WHERE conname = 'sensing_contribution_sessions_option_a_check';
  IF NOT FOUND THEN
    ALTER TABLE public.sensing_contribution_sessions
      ADD CONSTRAINT sensing_contribution_sessions_option_a_check
      CHECK (
        (issuance_class = 'authenticated_profile') = (issued_to_profile_id IS NOT NULL)
        AND issuance_class = 'authenticated_profile'
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS sensing_contribution_sessions_issuer_idx
  ON public.sensing_contribution_sessions (issued_to_profile_id)
  WHERE issued_to_profile_id IS NOT NULL;

COMMENT ON COLUMN public.sensing_contribution_sessions.issued_to_profile_id IS
  'OPTION A issuance ledger: the profile that obtained this short-lived credential. Present so an operator can revoke every session an account obtained. Never propagated to a contribution — the server cannot map a stored contribution back to this profile.';

-- Account-level revocation: the operator action Option A''s abuse control needs.
CREATE OR REPLACE FUNCTION public.revoke_sensing_sessions_for_profile(p_profile_id uuid, p_now timestamptz)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE n bigint;
BEGIN
  IF p_profile_id IS NULL OR p_now IS NULL THEN
    RAISE EXCEPTION 'revoke_sensing_sessions_for_profile: profile and instant are required';
  END IF;
  UPDATE public.sensing_contribution_sessions
     SET revoked_at = p_now
   WHERE issued_to_profile_id = p_profile_id AND revoked_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;
REVOKE ALL ON FUNCTION public.revoke_sensing_sessions_for_profile(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_sensing_sessions_for_profile(uuid, timestamptz) TO service_role;

-- ── POSTCONDITIONS ────────────────────────────────────────────────────────────
DO $$
DECLARE v_nullable text; v_fks int;
BEGIN
  SELECT is_nullable INTO v_nullable FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'sensing_contribution_sessions' AND column_name = 'issued_to_profile_id';
  IF v_nullable IS DISTINCT FROM 'YES' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: issued_to_profile_id must exist and be NULLABLE (2480 rows and rollback safety).';
  END IF;
  PERFORM 1 FROM pg_constraint WHERE conname = 'sensing_contribution_sessions_issuer_fk' AND contype = 'f';
  IF NOT FOUND THEN RAISE EXCEPTION 'POSTCONDITION FAILED: the issuer FK is missing.'; END IF;
  PERFORM 1 FROM pg_constraint WHERE conname = 'sensing_contribution_sessions_option_a_check' AND contype = 'c';
  IF NOT FOUND THEN RAISE EXCEPTION 'POSTCONDITION FAILED: the Option A consistency CHECK is missing.'; END IF;

  -- The link must not have propagated to the contribution store.
  SELECT count(*) INTO v_fks FROM pg_constraint
   WHERE conrelid = 'public.sensing_anon_contributions'::regclass AND contype = 'f';
  IF v_fks > 0 THEN RAISE EXCEPTION 'POSTCONDITION FAILED: sensing_anon_contributions acquired a foreign key.'; END IF;
  PERFORM 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sensing_anon_contributions'
      AND column_name IN ('session_id','credential_hash','issued_to_profile_id','profile_id','actor_id','user_id');
  IF FOUND THEN RAISE EXCEPTION 'POSTCONDITION FAILED: an identity or session column reached sensing_anon_contributions.'; END IF;

  IF has_table_privilege('service_role', 'public.sensing_contribution_sessions', 'UPDATE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: service_role gained UPDATE on sensing_contribution_sessions.';
  END IF;
  IF to_regprocedure('public.revoke_sensing_sessions_for_profile(uuid, timestamptz)') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: revoke_sensing_sessions_for_profile is absent.';
  END IF;
END $$;

COMMIT;
