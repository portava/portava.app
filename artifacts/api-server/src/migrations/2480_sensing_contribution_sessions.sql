-- 2480_sensing_contribution_sessions.sql
-- The ISSUED half of the Sensing spec's IntelligenceContributionSession (§4.2):
-- a short-lived, budgeted, opaque contribution credential.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- NOT APPLIED. The owner runs all SQL. This file is written so the decision in
-- docs/architecture/sensing-auth-posture-decision.md can be taken on evidence:
-- it was dry-run inside a ROLLED-BACK transaction on portava-ci and the
-- postconditions passed there. Nothing was committed to any database.
-- ══════════════════════════════════════════════════════════════════════════════
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2480.
-- Additive and idempotent; writes no row; creates no flag; does NOT
-- self-register in schema_migration_ledger.
--
-- ── WHY A SESSION TABLE, AND NOT A NULLABLE actor_id ─────────────────────────
-- The structural cap on Sensing is intel_observations.actor_id NOT NULL
-- REFERENCES profiles(id) (2130:142). Three candidates were weighed:
--
--   (a) Make actor_id NULLABLE and add anonymous provenance.   REJECTED.
--       Every guarantee on that table is keyed on actor_id: the RLS policies
--       (`actor_id = auth.uid()`), the replay key UNIQUE (actor_id,
--       idempotency_key) — NULLs are distinct, so anonymous rows would have NO
--       replay protection — erase_intel_for_actor(), intelGroupKey's
--       `solo:<actorId>` group credit, and privacyGate's distinct-actor count.
--       Anonymous rows would either be uncountable or count as one person.
--       It would also put passive sensor features into a table of human CLAIMS
--       with claim_type / value / moderation — the "second lifecycle inside the
--       first" the owner ruling forbids.
--   (b) A separate anonymous source table.                    ALREADY EXISTS.
--       sensing_anon_contributions (2315) is exactly that: no FK, rotating
--       peppered tokens, 72 h TTL, one row per contributor per cohort (2340),
--       identity-free revocation. The contribution store is not the gap.
--   (c) Wire what exists: the missing piece is ELIGIBILITY — who may obtain a
--       credential — and the credential itself. §3: "eligibility proves an
--       authorized participating device; ingest receives an opaque short-lived
--       credential." This table is the credential. It changes NOTHING about
--       intel_observations, whose FK stays exactly as it is for human claims.
--
-- ── WHAT A SESSION IS ────────────────────────────────────────────────────────
-- A bearer credential the device receives once, stored here only as an HMAC
-- under the server pepper (lib/sensingAnonStore.deriveSensingCredentialHash),
-- with the policy it was issued under and a BUDGET of cohorts it may still
-- contribute to. It holds no identity: the postconditions refuse the same
-- column names 2315 does. A contribution holds no session: 2315 forbids
-- `session_id`. The join between them exists only inside one request and
-- nowhere at rest.
--
-- Under Option A (authenticated_only) migration 2481 adds a NULLABLE
-- issued_to_profile_id to THIS table — an issuance ledger for account-level
-- revocation. It is never added to a contribution. 2480's FK postcondition
-- names that one constraint as the only FK ever permitted here.
--
-- ── ABUSE CONTROL IS THE BUDGET, ATOMIC IN SQL ───────────────────────────────
-- sensing_session_consume() decrements budget_cohorts_remaining in a single
-- UPDATE and returns a named reason. The caller consumes budget only after a
-- NON-duplicate contribution write (2340's replay key makes a replay a no-op
-- that costs nothing), so a replaying device gains nothing and a spraying
-- device runs out. UPDATE is not granted to any role: the only UPDATE paths are
-- the two SECURITY DEFINER functions below, so a "status" column can never
-- arrive through an ad-hoc write.
--
-- ── RETENTION ────────────────────────────────────────────────────────────────
-- expires_at is NOT NULL and CHECKed to ≤ starts_at + 72 hours (the same
-- ceiling as a contribution's TTL). purge_expired_sensing_sessions() removes
-- expired and revoked rows; a session that outlives the ceiling is
-- unrepresentable.
--
-- ── MODERATION ───────────────────────────────────────────────────────────────
-- There is nothing to moderate: no free text, no claim, no media. Abuse is
-- handled by the budget, the k-gate, and the differencing gate, not by review.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.sensing_anon_contributions') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: sensing_anon_contributions (2315) is absent — a session without a store is meaningless.';
  END IF;
  PERFORM 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'sensing_anon_contributions_replay_idx';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: 2340''s replay key is absent — budget accounting assumes a replay writes nothing.';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.sensing_contribution_sessions (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- HMAC(server pepper, bearer). The bearer is never stored.
  credential_hash          text        NOT NULL,
  policy_version           smallint    NOT NULL,
  -- The §3 verbs this session may exercise. CHECKed against the vocabulary.
  purpose_scopes           text[]      NOT NULL,
  reduction_version        smallint    NOT NULL,
  -- How the credential was obtained. Never WHO.
  issuance_class           text        NOT NULL,
  -- Cohorts (zone × 30-min bucket) this session may still contribute to.
  budget_cohorts_remaining integer     NOT NULL,
  starts_at                timestamptz NOT NULL DEFAULT now(),
  expires_at               timestamptz NOT NULL,
  revoked_at               timestamptz,

  CONSTRAINT sensing_contribution_sessions_credential_key UNIQUE (credential_hash),
  CONSTRAINT sensing_contribution_sessions_credential_check
    CHECK (length(credential_hash) BETWEEN 16 AND 128),
  CONSTRAINT sensing_contribution_sessions_lifetime_check
    CHECK (expires_at > starts_at AND expires_at <= starts_at + interval '72 hours'),
  CONSTRAINT sensing_contribution_sessions_budget_check
    CHECK (budget_cohorts_remaining >= 0),
  CONSTRAINT sensing_contribution_sessions_policy_check
    CHECK (policy_version >= 1 AND reduction_version >= 1),
  CONSTRAINT sensing_contribution_sessions_class_check
    CHECK (issuance_class IN ('attested_device', 'unattested_device', 'authenticated_profile')),
  CONSTRAINT sensing_contribution_sessions_scopes_check
    CHECK (purpose_scopes <@ ARRAY['collect','retain','aggregate','infer','personalize','surface','share']::text[]),
  CONSTRAINT sensing_contribution_sessions_revoked_check
    CHECK (revoked_at IS NULL OR revoked_at >= starts_at)
);

CREATE INDEX IF NOT EXISTS sensing_contribution_sessions_expiry_idx
  ON public.sensing_contribution_sessions (expires_at);

COMMENT ON TABLE public.sensing_contribution_sessions IS
  'Short-lived, budgeted, opaque sensing contribution credentials (Sensing §4.2 issued session). Holds an HMAC of the bearer, the policy it was issued under and a remaining-cohort budget. NO identity column and NO foreign key (Option A''s 2481 may add exactly one nullable issuer FK). A contribution never references a session (2315 forbids session_id). service_role only; UPDATE only through the two functions.';

-- ── Budget consumption: one UPDATE, one named reason ──────────────────────────
CREATE OR REPLACE FUNCTION public.sensing_session_consume(p_credential_hash text, p_now timestamptz)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  r public.sensing_contribution_sessions%ROWTYPE;
  n int;
BEGIN
  IF p_credential_hash IS NULL OR length(p_credential_hash) = 0 OR p_now IS NULL THEN
    RAISE EXCEPTION 'sensing_session_consume: credential hash and instant are required';
  END IF;
  SELECT * INTO r FROM public.sensing_contribution_sessions WHERE credential_hash = p_credential_hash FOR UPDATE;
  IF NOT FOUND THEN RETURN 'unknown'; END IF;
  IF r.revoked_at IS NOT NULL THEN RETURN 'revoked'; END IF;
  IF p_now < r.starts_at THEN RETURN 'not_started'; END IF;
  IF p_now >= r.expires_at THEN RETURN 'expired'; END IF;
  IF r.budget_cohorts_remaining <= 0 THEN RETURN 'budget_exhausted'; END IF;
  UPDATE public.sensing_contribution_sessions
     SET budget_cohorts_remaining = budget_cohorts_remaining - 1
   WHERE id = r.id AND budget_cohorts_remaining > 0;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 0 THEN RETURN 'budget_exhausted'; END IF;
  RETURN 'ok';
END;
$$;

-- ── Revocation by credential (device-initiated, or operator with the hash) ────
CREATE OR REPLACE FUNCTION public.revoke_sensing_session(p_credential_hash text, p_now timestamptz)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE n bigint;
BEGIN
  IF p_credential_hash IS NULL OR length(p_credential_hash) = 0 OR p_now IS NULL THEN
    RAISE EXCEPTION 'revoke_sensing_session: credential hash and instant are required';
  END IF;
  UPDATE public.sensing_contribution_sessions
     SET revoked_at = p_now
   WHERE credential_hash = p_credential_hash AND revoked_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

-- ── Retention: expired or revoked rows are removed ────────────────────────────
CREATE OR REPLACE FUNCTION public.purge_expired_sensing_sessions(p_now timestamptz)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE n bigint;
BEGIN
  IF p_now IS NULL THEN RAISE EXCEPTION 'purge_expired_sensing_sessions: instant is required'; END IF;
  DELETE FROM public.sensing_contribution_sessions WHERE expires_at <= p_now OR revoked_at IS NOT NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

REVOKE ALL ON FUNCTION public.sensing_session_consume(text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.revoke_sensing_session(text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.purge_expired_sensing_sessions(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sensing_session_consume(text, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.revoke_sensing_session(text, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.purge_expired_sensing_sessions(timestamptz) TO service_role;

-- ── RLS — service_role only, and UPDATE only through the functions ────────────
ALTER TABLE public.sensing_contribution_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sensing_contribution_sessions FROM PUBLIC;
REVOKE ALL ON public.sensing_contribution_sessions FROM anon;
REVOKE ALL ON public.sensing_contribution_sessions FROM authenticated;
REVOKE ALL ON public.sensing_contribution_sessions FROM service_role;
GRANT SELECT, INSERT, DELETE ON public.sensing_contribution_sessions TO service_role;

DROP POLICY IF EXISTS sensing_contribution_sessions_service ON public.sensing_contribution_sessions;
CREATE POLICY sensing_contribution_sessions_service ON public.sensing_contribution_sessions
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── POSTCONDITIONS ────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_fks int; v_rls boolean; v_policies int; v_col text;
BEGIN
  IF to_regclass('public.sensing_contribution_sessions') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: sensing_contribution_sessions is absent.';
  END IF;

  -- No FK, except the one 2481 may add under Option A (named, so nothing else can hide behind it).
  SELECT count(*) INTO v_fks FROM pg_constraint
   WHERE conrelid = 'public.sensing_contribution_sessions'::regclass AND contype = 'f'
     AND conname <> 'sensing_contribution_sessions_issuer_fk';
  IF v_fks > 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: sensing_contribution_sessions has % unexpected foreign key(s).', v_fks;
  END IF;

  -- No identity-shaped column. (issued_to_profile_id is 2481''s, Option A only, and is not in this list on purpose.)
  FOREACH v_col IN ARRAY ARRAY[
    'user_id','actor_id','profile_id','account_id','auth_id','owner_id','created_by',
    'contributor_id','device_id','session_id','installation_id','contributor_token','commitment'
  ] LOOP
    PERFORM 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'sensing_contribution_sessions' AND column_name = v_col;
    IF FOUND THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED: sensing_contribution_sessions has a column named %, which would link a credential to an identity or to a contribution.', v_col;
    END IF;
  END LOOP;

  -- And the contribution store still references nothing — the join must not appear on that side either.
  SELECT count(*) INTO v_fks FROM pg_constraint
   WHERE conrelid = 'public.sensing_anon_contributions'::regclass AND contype = 'f';
  IF v_fks > 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: sensing_anon_contributions acquired a foreign key.';
  END IF;
  PERFORM 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sensing_anon_contributions' AND column_name IN ('session_id','credential_hash');
  IF FOUND THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: sensing_anon_contributions references a session — the join must exist nowhere at rest.';
  END IF;

  SELECT relrowsecurity INTO v_rls FROM pg_class WHERE oid = 'public.sensing_contribution_sessions'::regclass;
  IF v_rls IS NOT TRUE THEN RAISE EXCEPTION 'POSTCONDITION FAILED: RLS is not enabled on sensing_contribution_sessions.'; END IF;

  SELECT count(*) INTO v_policies FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'sensing_contribution_sessions'
     AND ('anon' = ANY(roles) OR 'authenticated' = ANY(roles));
  IF v_policies > 0 THEN RAISE EXCEPTION 'POSTCONDITION FAILED: sensing_contribution_sessions has % anon/authenticated policy(ies).', v_policies; END IF;

  IF has_table_privilege('service_role', 'public.sensing_contribution_sessions', 'UPDATE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: service_role holds UPDATE on sensing_contribution_sessions — budgets and revocation must go through the functions.';
  END IF;
  IF has_table_privilege('authenticated', 'public.sensing_contribution_sessions', 'SELECT')
     OR has_table_privilege('anon', 'public.sensing_contribution_sessions', 'SELECT') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: a user role can read sensing_contribution_sessions.';
  END IF;

  IF to_regprocedure('public.sensing_session_consume(text, timestamptz)') IS NULL
     OR to_regprocedure('public.revoke_sensing_session(text, timestamptz)') IS NULL
     OR to_regprocedure('public.purge_expired_sensing_sessions(timestamptz)') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: a session function is absent.';
  END IF;

  PERFORM 1 FROM pg_constraint WHERE conrelid = 'public.sensing_contribution_sessions'::regclass
     AND conname = 'sensing_contribution_sessions_lifetime_check';
  IF NOT FOUND THEN RAISE EXCEPTION 'POSTCONDITION FAILED: the 72 h lifetime CHECK is missing.'; END IF;
END $$;

COMMIT;
