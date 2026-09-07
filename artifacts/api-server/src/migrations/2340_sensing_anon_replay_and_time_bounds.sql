-- 2340_sensing_anon_replay_and_time_bounds.sql
-- Anti-replay key and observation-time bounds for the anonymous sensing store.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2340.
--
-- Additive and idempotent: CREATE UNIQUE INDEX IF NOT EXISTS, a constraint added
-- only if absent (pg_constraint is consulted first), and REVOKE/GRANT statements
-- that are no-ops when already in effect. No row is written, no flag is created
-- or flipped, no reader changes shape. It does NOT self-register in
-- schema_migration_ledger — since 2258 that is the apply tooling's job.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY — two properties 2315 promised in prose and did not enforce
-- ══════════════════════════════════════════════════════════════════════════════
-- The Sensing spec's ingest contract (§4.3) requires "Replay / idempotency
-- protection" and "Reject impossible timestamps". The canonical intel path has
-- both: intel_observations carries UNIQUE (actor_id, idempotency_key) and a
-- CHECK (observed_at <= received_at + interval '60 seconds') (2130:186-197).
-- The anonymous store shipped with neither:
--
--   * A replayed contribution — the same commitment, epoch, zone and bucket
--     sent forty times — wrote forty rows. The aggregate counts DISTINCT
--     contributor tokens, so the published number did not inflate, but the
--     store had no idempotency key at all, and "one device ≠ a crowd" was a
--     property of one reader's Set rather than of the data.
--   * A contribution could claim any observation instant. The only check was
--     that the claimed rotation epoch matched the instant, and a device chooses
--     both. A reading dated twenty hours in the future was stored into a cohort
--     nobody had contributed to yet; a reading dated a week ago was stored into
--     one long past. Neither is drift. Both are fabricated evidence.
--
-- THE REPLAY KEY IS (cohort_key, contributor_token). A cohort is one zone in one
-- 30-minute privacy bucket under one reduction version; a contributor token is
-- stable within an epoch. So the natural identity of a contribution — "this
-- unlinkable contributor registered a reading in this zone during this bucket"
-- — is exactly that pair, and a second row under it is a replay by definition.
-- One contributor per cohort is therefore idempotency, not a sampling policy:
-- what a device may send per hour, per zone, per day remains the owner's
-- (docs/architecture/sensing-input-gap.md §3.2, "The abuse budget"). The
-- application treats a unique violation as a successful no-op (23505 ⇒
-- duplicate), the same shape lib/placeIdBridge and intelAttributionScheduler
-- use, so a retried request is not an error and a replayed one writes nothing.
--
-- A side effect that the aggregation now relies on: with exactly one row per
-- contributor per cohort, a per-row statistic over a cohort IS a per-person
-- statistic, which is what lets lib/sensingCoverageAggregate publish a median
-- signal bucket without one prolific device weighting it.
--
-- THE TIME BOUNDS ARE ON time_bucket, because that is what the row stores. The
-- precise instant is never written (2315), so the bound is at bucket
-- granularity: a bucket may not start more than 60 seconds after the row was
-- created (the intel path's MAX_OBSERVED_AT_SKEW, intelContracts.ts:648) and
-- may not start more than 72 hours before it (the store's own TTL ceiling — a
-- reading older than the longest any row can live has no cohort it could
-- honestly still be counted in). lib/sensingAnonStore refuses the same two
-- cases before the round trip; the CHECK is the authority.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- AND ONE THING 2315 CLAIMED THAT IT DID NOT ENFORCE
-- ══════════════════════════════════════════════════════════════════════════════
-- 2315 says "UPDATE is not granted to anyone" and grants service_role SELECT,
-- INSERT, DELETE. In this database ALTER DEFAULT PRIVILEGES hands a NEW table's
-- privileges to service_role at CREATE TABLE time, so a narrow GRANT with no
-- preceding REVOKE from service_role can be decorative (the canonical pattern is
-- 2217_protected_locations.sql:156-161). It happens to hold in portava-ci —
-- has_table_privilege('service_role', ..., 'UPDATE') measured false on
-- 2026-09-07 — but "happens to" is not a property. This file REVOKEs from
-- service_role and grants back exactly 2315's intent, then a postcondition
-- asserts UPDATE is absent, so the claim is checked wherever this runs.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- INERT
-- ══════════════════════════════════════════════════════════════════════════════
-- The store has no route, no flag and no consumer (src/test/sensingAnonStore
-- .test.ts allowlists every referrer). This migration narrows what the store
-- accepts; it changes nothing any user can see. Applied to portava-ci only; the
-- table it constrains does not exist in production, and applying 2315 there is
-- an owner decision this file does not take.

BEGIN;

-- ══════════════════════════════════════════════════════════════════════════════
-- PRECONDITIONS
-- ══════════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF to_regclass('public.sensing_anon_contributions') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.sensing_anon_contributions is absent — apply 2315 first.';
  END IF;
  PERFORM 1 FROM pg_constraint
    WHERE conrelid = 'public.sensing_anon_contributions'::regclass
      AND conname = 'sensing_anon_contributions_ttl_check';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: 2315''s TTL CHECK is missing — this is not the table 2315 created.';
  END IF;
  PERFORM 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sensing_anon_contributions'
      AND column_name IN ('cohort_key', 'contributor_token', 'time_bucket', 'created_at');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: expected 2315 columns are missing.';
  END IF;
END $$;

-- ══════════════════════════════════════════════════════════════════════════════
-- 1. ANTI-REPLAY / IDEMPOTENCY — one contribution per contributor per cohort
-- ══════════════════════════════════════════════════════════════════════════════
CREATE UNIQUE INDEX IF NOT EXISTS sensing_anon_contributions_replay_idx
  ON public.sensing_anon_contributions (cohort_key, contributor_token);

COMMENT ON INDEX public.sensing_anon_contributions_replay_idx IS
  'Idempotency key for the anonymous sensing store: one row per (cohort_key, contributor_token). A second write under the same pair is a replay; the application treats 23505 as a successful no-op. This is idempotency, not a sampling budget — per-device budgets are an owner decision.';

-- ══════════════════════════════════════════════════════════════════════════════
-- 2. OBSERVATION-TIME BOUNDS — a bucket cannot be in the future or past the TTL ceiling
-- ══════════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  PERFORM 1 FROM pg_constraint
    WHERE conrelid = 'public.sensing_anon_contributions'::regclass
      AND conname = 'sensing_anon_contributions_time_bounds_check';
  IF NOT FOUND THEN
    ALTER TABLE public.sensing_anon_contributions
      ADD CONSTRAINT sensing_anon_contributions_time_bounds_check
      CHECK (
        time_bucket <= created_at + interval '60 seconds'
        AND time_bucket >= created_at - interval '72 hours'
      );
  END IF;
END $$;

-- ══════════════════════════════════════════════════════════════════════════════
-- 3. THE GRANT 2315 INTENDED, MADE REAL — revoke first, then grant back narrowly
-- ══════════════════════════════════════════════════════════════════════════════
REVOKE ALL ON public.sensing_anon_contributions FROM PUBLIC;
REVOKE ALL ON public.sensing_anon_contributions FROM anon;
REVOKE ALL ON public.sensing_anon_contributions FROM authenticated;
REVOKE ALL ON public.sensing_anon_contributions FROM service_role;
GRANT SELECT, INSERT, DELETE ON public.sensing_anon_contributions TO service_role;

-- ══════════════════════════════════════════════════════════════════════════════
-- POSTCONDITIONS
-- ══════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_unique   boolean;
  v_fks      int;
  v_rls      boolean;
  v_policies int;
BEGIN
  -- The replay key exists and is UNIQUE — a non-unique index would be a lookup
  -- aid, not an idempotency key.
  SELECT i.indisunique INTO v_unique
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
   WHERE c.relname = 'sensing_anon_contributions_replay_idx';
  IF v_unique IS NOT TRUE THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: sensing_anon_contributions_replay_idx is missing or not unique — a replay would write a row.';
  END IF;

  PERFORM 1 FROM pg_constraint
    WHERE conrelid = 'public.sensing_anon_contributions'::regclass
      AND conname = 'sensing_anon_contributions_time_bounds_check'
      AND contype = 'c';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: the observation-time CHECK is missing — a future or ancient bucket would be stored.';
  END IF;

  -- 2315's structural promises must survive this file untouched.
  SELECT count(*) INTO v_fks
    FROM pg_constraint c
   WHERE c.conrelid = 'public.sensing_anon_contributions'::regclass
     AND c.contype = 'f';
  IF v_fks > 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: sensing_anon_contributions has % foreign key(s); 2315 forbids any.', v_fks;
  END IF;

  SELECT relrowsecurity INTO v_rls
    FROM pg_class WHERE oid = 'public.sensing_anon_contributions'::regclass;
  IF v_rls IS NOT TRUE THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: RLS is not enabled on sensing_anon_contributions.';
  END IF;

  SELECT count(*) INTO v_policies
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'sensing_anon_contributions'
     AND ('anon' = ANY(roles) OR 'authenticated' = ANY(roles));
  IF v_policies > 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: sensing_anon_contributions has % anon/authenticated policy(ies).', v_policies;
  END IF;

  -- The claim 2315 made in prose, now checked: nobody may UPDATE a contribution.
  IF has_table_privilege('service_role', 'public.sensing_anon_contributions', 'UPDATE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: service_role holds UPDATE on sensing_anon_contributions — the narrow grant was decorative.';
  END IF;
  IF has_table_privilege('authenticated', 'public.sensing_anon_contributions', 'SELECT')
     OR has_table_privilege('anon', 'public.sensing_anon_contributions', 'SELECT') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: a user role can read sensing_anon_contributions.';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.sensing_anon_contributions', 'INSERT')
     OR NOT has_table_privilege('service_role', 'public.sensing_anon_contributions', 'DELETE')
     OR NOT has_table_privilege('service_role', 'public.sensing_anon_contributions', 'SELECT') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: service_role lost a privilege 2315 granted — the sweep or the writer would fail.';
  END IF;
END $$;

COMMIT;
