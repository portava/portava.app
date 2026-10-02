-- 3110_sensing_published_aggregates.sql
-- The DURABLE last-published store the anti-differencing gate needs.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band).
--
-- Additive and idempotent: CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT
-- EXISTS, CREATE OR REPLACE FUNCTION, and REVOKE/GRANT statements that are
-- no-ops when already in effect. No row is written, no flag is created or
-- flipped, no existing reader changes shape. It does NOT self-register in
-- schema_migration_ledger — since 2258 that is the apply tooling's job.
--
-- UNAPPLIED. This file is committed, not run: applying it is the owner's act.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY — the gate has a memory requirement that nothing in this tree satisfies
-- ══════════════════════════════════════════════════════════════════════════════
-- lib/sensingDifferencingGate implements the anti-differencing control §3
-- requires: a cohort may be RE-published only when its distinct-contributor
-- count has moved by at least a whole independent party, or has not moved at
-- all. Two publications that differ by one contributor leak that contributor —
-- "the count went from 17 to 18 after Alice walked in" is a presence fact about
-- Alice, and a k-floor on each publication alone does not stop it, because both
-- 17 and 18 clear k = 15.
--
-- The control is a rule over PUBLISHED values, and its own header says so:
--
--     "The caller keeps the last published aggregate (a de-identified value)
--      and hands it back in."
--
-- THE CALLER HAS NOWHERE TO KEEP IT. That sentence is the whole defect. A gate
-- whose previous value lives in one process's memory is not a control: it resets
-- on every deploy, every restart and every extra replica, and a reset reads as
-- `no_previous`, which PUBLISHES. So the failure mode of forgetting is the
-- unsafe direction — exactly the direction an attacker would induce.
--
-- WHY intel_state_snapshots IS NOT THAT STORE, WHICH IS THE SUBTLE PART. It is
-- one row per (subject, zone, claim), UPSERTED IN PLACE by the projection
-- writer as new evidence arrives. So by the time a publisher reads it, it
-- already holds the CURRENT value. The number the gate must compare against —
-- the one that was last SERVED — has been overwritten by the thing it was
-- supposed to be compared with. A gate handed (current, current) always sees
-- delta 0, answers `unchanged`, and publishes every time. It would be a control
-- that is structurally incapable of refusing.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY THIS TABLE IS APPEND-ONLY, AND NOT ANOTHER UPSERT-IN-PLACE
-- ══════════════════════════════════════════════════════════════════════════════
-- The obvious shape is one row per cohort, upserted. It would work, and it would
-- reproduce the exact hazard above one layer down: a writer that upserts is one
-- careless call away from overwriting the previous publication with the
-- candidate that has not been published yet, and nothing in the schema would
-- notice.
--
-- So a publication is an INSERT and only an INSERT. service_role is granted
-- SELECT, INSERT, DELETE and NOT UPDATE — asserted in the postconditions rather
-- than assumed, because in this database ALTER DEFAULT PRIVILEGES hands a new
-- table's privileges to service_role at CREATE TABLE time, so a narrow GRANT
-- with no preceding REVOKE can be decorative (2340 carries the same fix for the
-- same reason). The gate reads the most recent unexpired row for a cohort; the
-- history behind it is an audit trail of what was actually served, which is the
-- artifact an anti-differencing review would ask for and an upsert destroys.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THIS TABLE IS NOT
-- ══════════════════════════════════════════════════════════════════════════════
-- It is not a second intel lifecycle and it is not a contribution store. It
-- holds only DE-IDENTIFIED AGGREGATE values that already cleared the privacy
-- gate, keyed by a cohort (a coarse zone in one 30-minute bucket). It carries no
-- contributor token, no group token, no commitment, no epoch and no identity of
-- any kind, and the postconditions refuse those column names as well as any
-- foreign key at all — the same ratchet 2315 applies to the contribution store,
-- for the same reason: a join out is a re-identification path.
--
-- THE k-FLOOR IS STRUCTURAL HERE. A row that does not clear
-- PRIVACY_THRESHOLD_V1 (15 distinct contributors, 5 independent groups,
-- intelContracts.ts:732-736) cannot be written at all. That is deliberate
-- duplication of a code constant, in the same spirit as 2340's 72 hours: the SQL
-- is the authority, and src/test/sensingIngestDurableGate.test.ts pins these two
-- numbers against PRIVACY_THRESHOLD_V1 so the two cannot drift silently. An
-- unpublishable aggregate is not a publication and must be unrepresentable, not
-- merely unwritten.
--
-- RETENTION. A publication expires within 72 hours, structurally, the same
-- ceiling 2315 puts on a contribution — the cohort it describes cannot outlive
-- its own contributions, so a comparison against a publication older than that
-- would be a comparison against a cohort that no longer exists.

BEGIN;

-- ══════════════════════════════════════════════════════════════════════════════
-- PRECONDITIONS
-- ══════════════════════════════════════════════════════════════════════════════
DO $pre$
BEGIN
  IF to_regclass('public.sensing_anon_contributions') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.sensing_anon_contributions is absent — apply 2315 first. A last-published store with no contribution store behind it has nothing to have published.';
  END IF;
END $pre$;

-- ══════════════════════════════════════════════════════════════════════════════
-- THE STORE
-- ══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.sensing_published_aggregates (
  -- Storage key only. Random per row; it identifies a PUBLICATION, never a
  -- person, and nothing joins to it.
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ── Which cohort was published ─────────────────────────────────────────────
  -- The same grouping key the contribution store carries
  -- (lib/sensingAnonStore.sensingCohortKey: v<reduction>|<zone>|<bucket>). Plain
  -- text, no FK — a cohort is a derived label, not a row somewhere else.
  cohort_key           text        NOT NULL,
  zone_id              text        NOT NULL,
  time_bucket          timestamptz NOT NULL,
  reduction_version    smallint    NOT NULL DEFAULT 1,

  -- ── The published, de-identified values ────────────────────────────────────
  -- Every one of these already cleared the privacy gate. distinct_contributors
  -- is the number the differencing rule compares; the rest are stored so a
  -- suppressed re-publication can RE-SERVE the previous aggregate faithfully,
  -- which is what evaluateDifferencing's `serve: previous` branch means.
  distinct_contributors integer    NOT NULL,
  distinct_groups       integer    NOT NULL,
  max_group_share       numeric    NOT NULL,
  contribution_count    integer    NOT NULL,

  -- The cohort's per-contributor median ordinal, 0..4, or NULL. Unitless; its
  -- meaning is pinned by reduction_version in code, never by a SQL vocabulary.
  median_signal_bucket  smallint,

  -- The freshest arrival counted in the cohort, at bucket granularity already.
  -- Nullable: a cohort can be published with nothing newer to report.
  observed_at           timestamptz,

  -- ── TTL ────────────────────────────────────────────────────────────────────
  published_at         timestamptz NOT NULL DEFAULT now(),
  expires_at           timestamptz NOT NULL,

  -- Short-lived is STRUCTURAL, exactly as in 2315. A publication that outlives
  -- the contributions it summarises cannot be written at all.
  CONSTRAINT sensing_published_aggregates_ttl_check
    CHECK (expires_at > published_at AND expires_at <= published_at + interval '72 hours'),

  -- THE k-FLOOR, STRUCTURAL. An aggregate below the privacy threshold is not a
  -- publication; it is a suppression, and a suppression has no row here.
  CONSTRAINT sensing_published_aggregates_k_floor_check
    CHECK (distinct_contributors >= 15 AND distinct_groups >= 5),
  CONSTRAINT sensing_published_aggregates_group_share_check
    CHECK (max_group_share >= 0 AND max_group_share <= 1),
  CONSTRAINT sensing_published_aggregates_counts_check
    CHECK (contribution_count >= distinct_contributors),
  CONSTRAINT sensing_published_aggregates_bucket_check
    CHECK (median_signal_bucket IS NULL OR median_signal_bucket BETWEEN 0 AND 4),
  CONSTRAINT sensing_published_aggregates_reduction_check
    CHECK (reduction_version >= 1),
  CONSTRAINT sensing_published_aggregates_zone_check
    CHECK (length(zone_id) BETWEEN 1 AND 128),
  CONSTRAINT sensing_published_aggregates_cohort_check
    CHECK (length(cohort_key) BETWEEN 1 AND 320)
);

-- The gate's one read: the most recent unexpired publication for a cohort.
CREATE INDEX IF NOT EXISTS sensing_published_aggregates_cohort_idx
  ON public.sensing_published_aggregates (cohort_key, published_at DESC);
-- The sweep scans by expiry.
CREATE INDEX IF NOT EXISTS sensing_published_aggregates_expiry_idx
  ON public.sensing_published_aggregates (expires_at);

COMMENT ON TABLE public.sensing_published_aggregates IS
  'The DURABLE last-published store for the anti-differencing gate (lib/sensingDifferencingGate). One row per PUBLICATION of one cohort, append-only: the gate reads the most recent unexpired row for a cohort and compares the candidate against it, so a re-publication that moves by less than a whole independent party is suppressed. Holds only de-identified aggregate values that already cleared the privacy threshold; carries no contributor token, no group token, no epoch, no identity and no foreign key at all. UPDATE is granted to nobody — a publication is a record of what was served, not a value to correct. Short-lived: 72 hours maximum, structurally.';

-- ══════════════════════════════════════════════════════════════════════════════
-- RETENTION
-- ══════════════════════════════════════════════════════════════════════════════
-- Takes its instant as an argument and reads no clock, so it is deterministic
-- and testable — the same shape as purge_expired_sensing_contributions (2315).
CREATE OR REPLACE FUNCTION public.purge_expired_sensing_publications(p_now timestamptz)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  n bigint;
BEGIN
  IF p_now IS NULL THEN
    RAISE EXCEPTION 'purge_expired_sensing_publications: instant is required';
  END IF;
  DELETE FROM public.sensing_published_aggregates WHERE expires_at <= p_now;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$fn$;

REVOKE ALL ON FUNCTION public.purge_expired_sensing_publications(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.purge_expired_sensing_publications(timestamptz) FROM anon;
REVOKE ALL ON FUNCTION public.purge_expired_sensing_publications(timestamptz) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.purge_expired_sensing_publications(timestamptz) TO service_role;

COMMENT ON FUNCTION public.purge_expired_sensing_publications(timestamptz) IS
  'TTL hygiene for sensing_published_aggregates: deletes publications whose expires_at has passed p_now. Deterministic (the instant is supplied, no clock is read) and idempotent.';

-- ══════════════════════════════════════════════════════════════════════════════
-- RLS — restricted, service_role only (2311's posture, as 2315 applies it)
-- ══════════════════════════════════════════════════════════════════════════════
ALTER TABLE public.sensing_published_aggregates ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.sensing_published_aggregates FROM PUBLIC;
REVOKE ALL ON public.sensing_published_aggregates FROM anon;
REVOKE ALL ON public.sensing_published_aggregates FROM authenticated;
-- REVOKE from service_role first, then grant back narrowly: without this the
-- GRANT is decorative under ALTER DEFAULT PRIVILEGES and UPDATE would survive.
REVOKE ALL ON public.sensing_published_aggregates FROM service_role;
GRANT SELECT, INSERT, DELETE ON public.sensing_published_aggregates TO service_role;

DROP POLICY IF EXISTS sensing_published_aggregates_service ON public.sensing_published_aggregates;
CREATE POLICY sensing_published_aggregates_service ON public.sensing_published_aggregates
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- No anon or authenticated policy is created, deliberately. RLS is on and the
-- table has no permissive policy for those roles, so they are denied by the
-- default rather than by an omission someone could later "fix" by adding one.
--
-- UPDATE is not granted to anyone. See the header: an updatable last-published
-- row is one careless call away from being overwritten by the candidate it was
-- supposed to be compared against, which is precisely the defect that makes
-- intel_state_snapshots unusable for this.

-- ══════════════════════════════════════════════════════════════════════════════
-- POSTCONDITIONS
-- ══════════════════════════════════════════════════════════════════════════════
DO $post$
DECLARE
  v_rls      boolean;
  v_policies int;
  v_fks      int;
  v_col      text;
BEGIN
  IF to_regclass('public.sensing_published_aggregates') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: public.sensing_published_aggregates is absent.';
  END IF;

  -- ── No foreign key at all — a join out of a sensing table is a
  --    re-identification path, which is 2315's own ratchet applied here. ──────
  SELECT count(*) INTO v_fks
    FROM pg_constraint c
   WHERE c.conrelid = 'public.sensing_published_aggregates'::regclass
     AND c.contype = 'f';
  IF v_fks > 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: sensing_published_aggregates has % foreign key constraint(s). A published aggregate references nothing; a join out of it is a re-identification path.', v_fks;
  END IF;

  -- A soft FK needs no constraint — just a column named like one. Refuse the
  -- name, and refuse the contribution-store identifiers too: a published
  -- aggregate that carried a contributor token would be the tracking store this
  -- whole design exists to avoid.
  FOREACH v_col IN ARRAY ARRAY[
    'user_id','actor_id','profile_id','account_id','auth_id','owner_id',
    'created_by','contributor_id','device_id','session_id','installation_id',
    'contributor_token','group_token','commitment','rotation_epoch','credential_hash'
  ] LOOP
    PERFORM 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'sensing_published_aggregates'
        AND column_name = v_col;
    IF FOUND THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED: sensing_published_aggregates has a column named %. A publication carries de-identified aggregate values only — an identity or a contributor token on it is a permanent trace even without a foreign key.', v_col;
    END IF;
  END LOOP;

  -- ── It must not become a second intel lifecycle either ────────────────────
  FOREACH v_col IN ARRAY ARRAY[
    'status','claim_type','claim_id','conflict','snapshot','snapshot_id',
    'review','reviewer_id','verdict','moderation_state','superseded_by'
  ] LOOP
    PERFORM 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'sensing_published_aggregates'
        AND column_name = v_col;
    IF FOUND THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED: sensing_published_aggregates has a column named %, which belongs to the canonical intel lifecycle. intel_observations -> intel_claims -> intel_state_snapshots remains canonical; this table records what a privacy gate served and nothing else.', v_col;
    END IF;
  END LOOP;

  -- ── RLS posture ───────────────────────────────────────────────────────────
  SELECT relrowsecurity INTO v_rls
    FROM pg_class WHERE oid = 'public.sensing_published_aggregates'::regclass;
  IF v_rls IS NOT TRUE THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: RLS is not enabled on sensing_published_aggregates.';
  END IF;

  SELECT count(*) INTO v_policies
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'sensing_published_aggregates'
     AND ('anon' = ANY(roles) OR 'authenticated' = ANY(roles));
  IF v_policies > 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: sensing_published_aggregates has % anon/authenticated policy(ies). This store is service_role only.', v_policies;
  END IF;

  -- ── Append-only, checked rather than claimed ──────────────────────────────
  IF has_table_privilege('service_role', 'public.sensing_published_aggregates', 'UPDATE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: service_role holds UPDATE on sensing_published_aggregates — the last published value could be overwritten in place by the candidate it must be compared against, which is exactly the defect that makes intel_state_snapshots unusable as this store.';
  END IF;
  IF has_table_privilege('authenticated', 'public.sensing_published_aggregates', 'SELECT')
     OR has_table_privilege('anon', 'public.sensing_published_aggregates', 'SELECT') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: a user role can read sensing_published_aggregates.';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.sensing_published_aggregates', 'INSERT')
     OR NOT has_table_privilege('service_role', 'public.sensing_published_aggregates', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.sensing_published_aggregates', 'DELETE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: service_role lost a privilege the gate or the sweep needs.';
  END IF;

  -- ── The two structural floors ─────────────────────────────────────────────
  PERFORM 1 FROM pg_constraint
    WHERE conrelid = 'public.sensing_published_aggregates'::regclass
      AND conname = 'sensing_published_aggregates_ttl_check';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: the TTL CHECK is missing — a publication could outlive the contributions it summarises.';
  END IF;

  PERFORM 1 FROM pg_constraint
    WHERE conrelid = 'public.sensing_published_aggregates'::regclass
      AND conname = 'sensing_published_aggregates_k_floor_check';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: the k-floor CHECK is missing — an aggregate below the privacy threshold could be recorded as a publication.';
  END IF;

  IF to_regprocedure('public.purge_expired_sensing_publications(timestamptz)') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: purge_expired_sensing_publications is absent — nothing would sweep expired publications.';
  END IF;
END $post$;

COMMIT;
