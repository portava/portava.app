-- 2315_sensing_anon_contributions.sql
-- The short-lived ANONYMOUS sensing contribution store.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2315.
--
-- Additive and idempotent: CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT
-- EXISTS, CREATE OR REPLACE FUNCTION, and every policy guarded by DROP POLICY IF
-- EXISTS. No existing table is altered, no row is written, no flag is created or
-- flipped, no reader changes shape. Re-running the file is a no-op. It does NOT
-- self-register in schema_migration_ledger — since 2258 that is the apply
-- tooling's job.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE RULING THIS IMPLEMENTS (owner, verbatim)
-- ══════════════════════════════════════════════════════════════════════════════
-- "A short-lived anonymous sensing contribution/aggregation store IS allowed even
--  though intel_observations requires actor_id. It is not a second intel
--  lifecycle. Existing intel evidence -> claims -> snapshots remains canonical.
--  The anonymous store may only own privacy-reduced sensor contributions,
--  rotating IDs, TTL, cohort/coverage aggregation and revocation. It must not
--  duplicate claim/review/status/conflict/snapshot semantics and must not contain
--  a permanent profiles/user FK."
--
-- Every clause is enforced structurally below, not merely promised in prose:
--
--   "must not contain a permanent profiles/user FK"
--        -> the table has ZERO foreign-key constraints of any kind, and a
--           postcondition inspects pg_constraint and RAISEs if one exists.
--           A second postcondition RAISEs if any column is NAMED like an account
--           handle (user_id / actor_id / profile_id / account_id / auth_id /
--           owner_id / device_id), which is how a soft FK gets in without a
--           constraint.
--   "must not duplicate claim/review/status/conflict/snapshot semantics"
--        -> a postcondition enumerates this table's columns and RAISEs if any of
--           them is named for a lifecycle concept intel_claims / 2311
--           intel_claim_reviews / intel_state_snapshots already own (status,
--           state, claim_type, claim_id, conflict*, snapshot*, review*, verdict,
--           moderation_state, confidence, supersede*, promotion_source). There is
--           no status column, no review row, no conflict predicate and no
--           snapshot here: a contribution is only ever WRITTEN, COUNTED, and
--           EXPIRED or REVOKED.
--   "short-lived"
--        -> expires_at is NOT NULL and a CHECK caps it at created_at + 72h, so a
--           long-lived row is UNREPRESENTABLE rather than merely discouraged.
--   "rotating IDs"
--        -> contributor_token is a server-derived opaque token bound to
--           rotation_epoch; the same device produces an unlinkable token in the
--           next epoch. See lib/sensingAnonStore.ts for the derivation.
--   "revocation"
--        -> purge_sensing_contributions_for_token() deletes by that token, which
--           the device proves ownership of by revealing its epoch secret. No
--           identity is presented, because there is none to present.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY THIS IS NOT intel_observations, AND CANNOT BECOME IT
-- ══════════════════════════════════════════════════════════════════════════════
-- intel_observations (2130) is an ACTIVE HUMAN REPORT: it carries
-- actor_id uuid NOT NULL REFERENCES public.profiles(id), a claim_type, a value,
-- visibility, moderation_state and a commercial disclosure, and it feeds the
-- canonical evidence -> claims -> snapshots lifecycle. That lifecycle is
-- untouched by this file and remains the only place a claim is ever made.
--
-- This table is the opposite object: a PASSIVE, PRIVACY-REDUCED contribution with
-- no author, no assertion and no opinion. It says "some unlinkable contributor
-- registered a coarse reading in this zone during this time bucket". It cannot
-- become an observation because it has nothing to say: there is no claim_type and
-- no value, only an ordinal bucket whose meaning is pinned by reduction_version
-- in code. Nothing reads this table today (see "INERT" below).
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY THERE IS NO SENSOR / CHANNEL VOCABULARY
-- ══════════════════════════════════════════════════════════════════════════════
-- The obvious next column is "what was sensed" — a channel or signal-family
-- label. It is deliberately absent. Any vocabulary written here would be the
-- first step back toward claim families (crowd.level, queue.wait, ...), which is
-- exactly what the ruling forbids, and choosing one is a product decision with a
-- named owner, not a schema decision an engineer makes from memory — the same
-- reasoning 2217 applied to protected zones. So the payload is a semantics-free
-- ordinal, and reduction_version pins what produced it. Adding an axis later is a
-- version bump plus an explicit owner decision, not a silent widening.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- PRIVACY POSTURE — service_role only, identical to 2311
-- ══════════════════════════════════════════════════════════════════════════════
-- Contributor tokens are pseudonyms. Even unlinkable pseudonyms plus a zone and a
-- time bucket are a presence trace, so no user ever reads this table: RLS is
-- enabled with a service_role policy and NO anon or authenticated policy at all,
-- denying by default rather than by omission. Grants are revoked from PUBLIC,
-- anon and authenticated first, because ALTER DEFAULT PRIVILEGES in this database
-- hands new tables INSERT/UPDATE to authenticated (the blanket-grant hole 2172
-- documents). A postcondition asserts the anon/authenticated policy count is 0.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- INERT BY CONSTRUCTION
-- ══════════════════════════════════════════════════════════════════════════════
-- No route, scheduler, job or feature flag references this table or either
-- function. There is no writer in any live path; lib/sensingAnonStore.ts is a
-- contract module that nothing imports outside its tests. Applying this migration
-- changes no observable behaviour of the running product — it only makes the
-- store exist.

BEGIN;

-- ══════════════════════════════════════════════════════════════════════════════
-- THE STORE
-- ══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.sensing_anon_contributions (
  -- Storage key only. Random per row; it identifies a ROW, never a person, and
  -- nothing joins to it.
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ── The rotating id ────────────────────────────────────────────────────────
  -- An opaque hex token derived SERVER-side (HMAC under a server pepper) from a
  -- rotation epoch and a one-way commitment the device sends. Properties that
  -- matter, all provided by lib/sensingAnonStore.ts:
  --   * stable WITHIN one epoch, so distinct contributors can be counted;
  --   * unlinkable ACROSS epochs, so no long-lived pseudonym accumulates;
  --   * not computable by anyone lacking the server pepper, so a leaked table
  --     cannot be correlated against a device that reveals its own secret.
  -- It is text, not uuid, precisely so it never reads as an account identifier.
  contributor_token text        NOT NULL,

  -- Which rotation window the token belongs to. Needed to re-derive the token
  -- during revocation, and it is what makes rotation checkable rather than
  -- asserted.
  rotation_epoch    bigint      NOT NULL,

  -- ── Independent-group signal (optional, fail-closed) ───────────────────────
  -- Same semantics as lib/intelGroupKey: an opaque token shared by members of one
  -- party and distinct across parties. NULL means "no verifiable group identity",
  -- which earns ZERO group credit in the privacy gate — a separate contributor is
  -- never inferred to be a separate party. Nullable on purpose: a contribution
  -- with no group signal is honest and still counts as a person.
  group_token       text,

  -- ── The privacy-reduced payload ────────────────────────────────────────────
  -- A coarse zone label, never a coordinate. Plain text like
  -- intel_observations.zone_id; no FK, so no join reaches reference geometry from
  -- here.
  zone_id           text        NOT NULL,

  -- Time, reduced. The FLOOR of the observation instant to the shared privacy
  -- time bucket (intelContracts.PRIVACY_THRESHOLD_V1.timeBucketMinutes = 30), so
  -- the precise moment a device sensed anything is never stored.
  time_bucket       timestamptz NOT NULL,

  -- The cohort/coverage grouping key the aggregation groups on, derived in
  -- lib/sensingAnonStore.sensingCohortKey from (zone_id, time_bucket,
  -- reduction_version). Stored so the grouping is a fact of the row rather than a
  -- convention a future reader could drift from.
  cohort_key        text        NOT NULL,

  -- The reduced reading: a unitless ordinal, NOT a claim. There is no value
  -- jsonb, no claim_type and no free text anywhere in this table.
  signal_bucket     smallint    NOT NULL,

  -- Pins the reduction pipeline that produced signal_bucket. The MEANING of the
  -- ordinal lives in code (lib/sensingAnonStore.SENSING_REDUCTION_VERSION), not
  -- in an SQL vocabulary, so widening it is a code change under review rather
  -- than a CHECK constraint edit.
  reduction_version smallint    NOT NULL DEFAULT 1,

  -- ── TTL ────────────────────────────────────────────────────────────────────
  created_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,

  -- Short-lived is STRUCTURAL. A row that outlives 72 hours cannot be written at
  -- all, so "short-lived" survives a careless caller, a bad default, and a
  -- scheduler that never runs. The sweep below is hygiene on top of this, not the
  -- guarantee itself.
  CONSTRAINT sensing_anon_contributions_ttl_check
    CHECK (expires_at > created_at AND expires_at <= created_at + interval '72 hours'),

  -- Tokens are opaque and non-empty. A blank token would collapse every
  -- contributor into one and silently deflate (or, if ever inverted, inflate) a
  -- cohort count.
  CONSTRAINT sensing_anon_contributions_token_check
    CHECK (length(contributor_token) BETWEEN 16 AND 128),
  CONSTRAINT sensing_anon_contributions_group_token_check
    CHECK (group_token IS NULL OR length(group_token) BETWEEN 16 AND 128),
  CONSTRAINT sensing_anon_contributions_zone_check
    CHECK (length(zone_id) BETWEEN 1 AND 128),
  CONSTRAINT sensing_anon_contributions_cohort_check
    CHECK (length(cohort_key) BETWEEN 1 AND 320),

  -- The ordinal band. Five buckets, deliberately coarse.
  CONSTRAINT sensing_anon_contributions_bucket_check
    CHECK (signal_bucket BETWEEN 0 AND 4),
  CONSTRAINT sensing_anon_contributions_reduction_check
    CHECK (reduction_version >= 1),
  CONSTRAINT sensing_anon_contributions_epoch_check
    CHECK (rotation_epoch >= 0)
);

-- The aggregation reads one cohort at a time and drops expired rows.
CREATE INDEX IF NOT EXISTS sensing_anon_contributions_cohort_idx
  ON public.sensing_anon_contributions (cohort_key, expires_at);
-- Revocation looks up by (epoch, token); the sweep scans by expiry.
CREATE INDEX IF NOT EXISTS sensing_anon_contributions_token_idx
  ON public.sensing_anon_contributions (rotation_epoch, contributor_token);
CREATE INDEX IF NOT EXISTS sensing_anon_contributions_expiry_idx
  ON public.sensing_anon_contributions (expires_at);

COMMENT ON TABLE public.sensing_anon_contributions IS
  'Short-lived ANONYMOUS sensing contributions. Owns only: privacy-reduced sensor contributions, rotating contributor tokens, TTL, the cohort/coverage grouping key, and revocation. It is NOT a second intel lifecycle: intel_observations -> intel_claims -> intel_state_snapshots remains canonical, and this table has no claim, status, review, conflict or snapshot semantics of any kind. It carries NO foreign key to profiles or auth.users, and no foreign key at all. service_role only; no anon/authenticated policy.';

-- ══════════════════════════════════════════════════════════════════════════════
-- RETENTION AND REVOCATION
-- ══════════════════════════════════════════════════════════════════════════════
-- Both take their instant / token as an argument and read no clock and no
-- identity, so they are deterministic and testable — the same shape as
-- purge_intel_contributions_older_than (2173).

-- TTL hygiene. The CHECK above already bounds a row's life; this removes the
-- expired ones. Idempotent: a second run over the same instant deletes nothing.
CREATE OR REPLACE FUNCTION public.purge_expired_sensing_contributions(p_now timestamptz)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  n bigint;
BEGIN
  IF p_now IS NULL THEN
    RAISE EXCEPTION 'purge_expired_sensing_contributions: instant is required';
  END IF;
  DELETE FROM public.sensing_anon_contributions WHERE expires_at <= p_now;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

-- Revocation. The caller supplies the epoch and the contributor token it has
-- RE-DERIVED from a device-presented epoch secret (lib/sensingAnonStore
-- .revokeSensingContributions). This function therefore never sees a secret, a
-- device, or an account — only an opaque token — and there is no identity column
-- it could have consulted instead.
CREATE OR REPLACE FUNCTION public.revoke_sensing_contributions(
  p_rotation_epoch bigint,
  p_contributor_token text
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  n bigint;
BEGIN
  IF p_rotation_epoch IS NULL OR p_contributor_token IS NULL OR length(p_contributor_token) = 0 THEN
    RAISE EXCEPTION 'revoke_sensing_contributions: epoch and token are required';
  END IF;
  DELETE FROM public.sensing_anon_contributions
   WHERE rotation_epoch = p_rotation_epoch
     AND contributor_token = p_contributor_token;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

REVOKE ALL ON FUNCTION public.purge_expired_sensing_contributions(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.purge_expired_sensing_contributions(timestamptz) FROM anon;
REVOKE ALL ON FUNCTION public.purge_expired_sensing_contributions(timestamptz) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.purge_expired_sensing_contributions(timestamptz) TO service_role;

REVOKE ALL ON FUNCTION public.revoke_sensing_contributions(bigint, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.revoke_sensing_contributions(bigint, text) FROM anon;
REVOKE ALL ON FUNCTION public.revoke_sensing_contributions(bigint, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_sensing_contributions(bigint, text) TO service_role;

COMMENT ON FUNCTION public.purge_expired_sensing_contributions(timestamptz) IS
  'TTL hygiene for sensing_anon_contributions: deletes rows whose expires_at has passed p_now. Deterministic (the instant is supplied, no clock is read) and idempotent.';
COMMENT ON FUNCTION public.revoke_sensing_contributions(bigint, text) IS
  'Identity-free revocation: deletes every contribution written under one rotating contributor token in one epoch. The caller re-derives that token from a device-presented epoch secret; this function sees no secret, no device and no account, and the table holds no identity it could have used instead.';

-- ══════════════════════════════════════════════════════════════════════════════
-- RLS — restricted, service_role only (2311's posture, verbatim)
-- ══════════════════════════════════════════════════════════════════════════════
ALTER TABLE public.sensing_anon_contributions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.sensing_anon_contributions FROM PUBLIC;
REVOKE ALL ON public.sensing_anon_contributions FROM anon;
REVOKE ALL ON public.sensing_anon_contributions FROM authenticated;
GRANT SELECT, INSERT, DELETE ON public.sensing_anon_contributions TO service_role;

DROP POLICY IF EXISTS sensing_anon_contributions_service ON public.sensing_anon_contributions;
CREATE POLICY sensing_anon_contributions_service ON public.sensing_anon_contributions
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- No anon or authenticated policy is created, deliberately. RLS is on and the
-- table has no permissive policy for those roles, so they are denied by the
-- default rather than by an omission someone could later "fix" by adding one.
--
-- UPDATE is not granted to anyone. A contribution is written once and then only
-- counted, expired or revoked; there is nothing about it to correct, and an
-- UPDATE path is how a "status" column arrives later.

-- ══════════════════════════════════════════════════════════════════════════════
-- POSTCONDITIONS
-- ══════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_rls       boolean;
  v_policies  int;
  v_fks       int;
  v_user_fks  int;
  v_col       text;
  v_bad       text;
BEGIN
  IF to_regclass('public.sensing_anon_contributions') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: public.sensing_anon_contributions is absent.';
  END IF;

  -- ── The ruling's hard clause: no permanent profiles/user FK, ever ──────────
  SELECT count(*) INTO v_user_fks
    FROM pg_constraint c
    JOIN pg_class rel      ON rel.oid = c.confrelid
    JOIN pg_namespace nsp  ON nsp.oid = rel.relnamespace
   WHERE c.conrelid = 'public.sensing_anon_contributions'::regclass
     AND c.contype = 'f'
     AND (
       (nsp.nspname = 'public' AND rel.relname = 'profiles')
       OR (nsp.nspname = 'auth' AND rel.relname = 'users')
     );
  IF v_user_fks > 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: sensing_anon_contributions has % foreign key(s) to profiles/auth.users. The owner ruling forbids a permanent account FK on the anonymous store outright.', v_user_fks;
  END IF;

  -- Stronger ratchet: NO foreign key at all. Any FK is a join back to identifiable
  -- data one hop away, and an indirect route to the thing the ruling forbids.
  SELECT count(*) INTO v_fks
    FROM pg_constraint c
   WHERE c.conrelid = 'public.sensing_anon_contributions'::regclass
     AND c.contype = 'f';
  IF v_fks > 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: sensing_anon_contributions has % foreign key constraint(s). The anonymous store references nothing; a join out of it is a re-identification path.', v_fks;
  END IF;

  -- A soft FK needs no constraint — just a column named like one. Refuse the name.
  FOREACH v_col IN ARRAY ARRAY[
    'user_id','actor_id','profile_id','account_id','auth_id','owner_id',
    'created_by','contributor_id','device_id','session_id','installation_id'
  ] LOOP
    PERFORM 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'sensing_anon_contributions'
        AND column_name = v_col;
    IF FOUND THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED: sensing_anon_contributions has a column named %. An account or device handle on the anonymous store is a permanent identity even without a foreign key.', v_col;
    END IF;
  END LOOP;

  -- ── The ruling's other clause: no claim/review/status/conflict/snapshot ────
  FOREACH v_bad IN ARRAY ARRAY[
    'status','state','claim_type','claim_id','claim_family','value',
    'conflict','conflict_state','snapshot','snapshot_id','review','review_id',
    'reviewer_id','verdict','moderation_state','visibility','confidence',
    'superseded_by','promotion_source','prior_status','new_status','source_class'
  ] LOOP
    PERFORM 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'sensing_anon_contributions'
        AND column_name = v_bad;
    IF FOUND THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED: sensing_anon_contributions has a column named %, which belongs to the canonical intel lifecycle (intel_claims / intel_claim_reviews / intel_state_snapshots). The anonymous store must not duplicate claim, review, status, conflict or snapshot semantics.', v_bad;
    END IF;
  END LOOP;

  -- ── RLS posture (2311) ────────────────────────────────────────────────────
  SELECT relrowsecurity INTO v_rls
    FROM pg_class WHERE oid = 'public.sensing_anon_contributions'::regclass;
  IF v_rls IS NOT TRUE THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: RLS is not enabled on sensing_anon_contributions — a pseudonym plus a zone and a time bucket is a presence trace.';
  END IF;

  SELECT count(*) INTO v_policies
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'sensing_anon_contributions'
     AND ('anon' = ANY(roles) OR 'authenticated' = ANY(roles));
  IF v_policies > 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: sensing_anon_contributions has % anon/authenticated policy(ies). This store is service_role only.', v_policies;
  END IF;

  -- ── TTL is structural, not a convention ───────────────────────────────────
  PERFORM 1 FROM pg_constraint
    WHERE conrelid = 'public.sensing_anon_contributions'::regclass
      AND conname = 'sensing_anon_contributions_ttl_check';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: the TTL CHECK is missing — "short-lived" would be a promise rather than a property.';
  END IF;

  -- ── Both functions exist ──────────────────────────────────────────────────
  IF to_regprocedure('public.purge_expired_sensing_contributions(timestamptz)') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: purge_expired_sensing_contributions is absent — nothing would sweep expired contributions.';
  END IF;
  IF to_regprocedure('public.revoke_sensing_contributions(bigint, text)') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: revoke_sensing_contributions is absent — a contributor could not withdraw.';
  END IF;
END $$;

COMMIT;
