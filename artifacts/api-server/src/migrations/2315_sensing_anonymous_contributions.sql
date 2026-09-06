-- 2315_sensing_anonymous_contributions.sql
--
-- Sensing / World Experience Intelligence — the ANONYMOUS contribution store.
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2315.
--
-- Additive and idempotent: one CREATE TABLE IF NOT EXISTS, three indexes, an
-- RLS lock, grants, and postconditions. No row is written, no row is deleted,
-- no flag is seeded, no existing table is altered, and no reader changes shape.
-- Re-running is a no-op.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE OWNER RULING THIS IMPLEMENTS (2026-09-06), QUOTED IN FULL
-- ══════════════════════════════════════════════════════════════════════════════
--   "A short-lived anonymous sensing contribution/aggregation store IS allowed
--    even though intel_observations requires actor_id. It is not a second intel
--    lifecycle. Existing intel evidence -> claims -> snapshots remains canonical.
--    The anonymous store may only own privacy-reduced sensor contributions,
--    rotating IDs, TTL, cohort/coverage aggregation and revocation. It must not
--    duplicate claim/review/status/conflict/snapshot semantics and must not
--    contain a permanent profiles/user FK."
--
-- Every clause is enforced below, most of them by a postcondition rather than by
-- prose, because a boundary nobody checks is a boundary that erodes.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THIS TABLE OWNS, AND WHAT IT REFUSES TO OWN
-- ══════════════════════════════════════════════════════════════════════════════
-- OWNS (the five things the ruling permits):
--   * a privacy-reduced sensor contribution — a coarse BAND, never a magnitude;
--   * a ROTATING pseudonym (`rotation_id`) instead of any user id;
--   * a TTL (`expires_at`, hard-bounded by a CHECK);
--   * the cohort grouping key the aggregation needs (`cohort_key`,`bucket_start`);
--   * a revocation handle that carries no identity (`revocation_tag`).
--
-- REFUSES:
--   * No status / state / review / conflict / snapshot / confidence / verified
--     column. Those are the canonical intel lifecycle's vocabulary and they stay
--     there. This store has no lifecycle at all: a contribution is written once,
--     is read only in aggregate, and then expires. There is nothing to review,
--     nothing to supersede, nothing to resolve.
--   * NO SECOND COVERAGE TABLE. Migration 2130 refused `intel_coverage_cells`
--     because it "would be the third coverage model", and 2181 then built the one
--     that exists (`intel_coverage_snapshots`). The ruling permits "cohort/
--     coverage aggregation" — so the aggregation here is a PURE FUNCTION over
--     these rows (lib/sensingAnonStore.ts `aggregateSensingCohort`), computed at
--     read time and stored nowhere. A stored aggregate would be a snapshot, and
--     snapshots are exactly what the ruling forbids duplicating.
--   * No foreign key of any kind — see below.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- NO FOREIGN KEY, TO ANYTHING, EVER
-- ══════════════════════════════════════════════════════════════════════════════
-- The ruling bars a "permanent profiles/user FK". This table goes further and
-- declares NO foreign key at all, because the harm is linkage, not the word
-- "profiles": an FK to any row that is itself user-keyed reintroduces the join
-- one indirection away. Zero FKs is a property a postcondition can check by
-- reading pg_constraint, which "no FK to profiles" alone is not — a future
-- `ALTER TABLE ... ADD CONSTRAINT ... REFERENCES public.some_user_table` would
-- pass the narrow test and fail the intent.
--
-- The consequence is deliberate and is the whole point: this table CANNOT be
-- swept by account deletion, because there is nothing to sweep BY. That is not a
-- deletion gap — src/lib/deletionDispositions.ts classifies tables that carry a
-- user-identifying column, and this one carries none, by construction and by
-- postcondition. Erasure here is `revocation_tag` (below) plus a 72-hour ceiling.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY THERE IS NO created_at
-- ══════════════════════════════════════════════════════════════════════════════
-- Every other table in this repo carries one. This one must not. A per-row
-- storage instant is a re-identification vector inside an otherwise anonymous
-- cohort ("who arrived first"), and a store whose whole justification is
-- privacy reduction should not keep a timestamp finer than the bucket it is
-- aggregated in. `bucket_start` — already coarsened to the rotation grid — is
-- the only time this table knows, and the TTL ceiling is measured from it.
-- `contribution_id` is a v4 uuid (gen_random_uuid), which encodes no time.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- ROTATING ID, AND WHY IT ROTATES ON EXACTLY THE AGGREGATION CLOCK
-- ══════════════════════════════════════════════════════════════════════════════
-- `rotation_id` is HMAC-SHA256 (server-keyed) over a client-held secret, the
-- bucket start, and the cohort key. It is not a user id, it is not stable across
-- buckets, and it is not stable across cohorts within a bucket, so it builds no
-- cross-place graph and no cross-time trail.
--
-- The rotation period is EXACTLY the privacy gate's aggregation time bucket
-- (PRIVACY_THRESHOLD_V1.timeBucketMinutes). That equality is load-bearing in one
-- direction: if the pseudonym rotated FASTER than the aggregation window, one
-- person would appear as several distinct "actors" and would INFLATE the
-- distinct-actor count the privacy gate is counting — the precise failure
-- lib/privacyGate.ts records for CompassGraphEngine, which counts events and
-- calls them people. Rotating on the same clock makes one person exactly one
-- rotation_id per aggregated cohort.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- REVOCATION WITHOUT AN IDENTITY
-- ══════════════════════════════════════════════════════════════════════════════
-- `revocation_tag` is HMAC-SHA256 (server-keyed) over the same client-held
-- secret and the bucket start — and NOT over the cohort key. To revoke, the
-- holder presents the secret; the server recomputes the tag for every bucket
-- still inside the TTL ceiling (at most 72h / 30min + 1 = 145 of them) and
-- deletes the matching rows. No identity is presented, none is stored, and the
-- server cannot invert a stored tag back to a secret.
--
-- THE COST, STATED PLAINLY: because the tag is not cohort-scoped, rows written
-- by one holder in one bucket ARE linkable to each other inside the database,
-- across cohorts. That is a bounded, 30-minute linkage, and it is the price of
-- being able to honour "delete everything I contributed" from a holder who does
-- not remember which cohorts they contributed to. Cohort-scoping the tag would
-- remove that linkage and make revocation silently incomplete after an app
-- reinstall, which is the worse failure. See lib/sensingAnonStore.ts.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- INERT BY CONSTRUCTION
-- ══════════════════════════════════════════════════════════════════════════════
-- Nothing writes this table and nothing reads it. There is no route, no
-- scheduler, no feature flag and no client. It ships EMPTY and stays empty until
-- a capture path is built and separately ruled on. Deliberately NOT flag-gated,
-- for 2217's reason: the rollout control is the absence of a writer, and a new
-- flag's natural default would be the only thing standing between an empty table
-- and a populated one.
--
-- No sweeper is scheduled either, and that is a stated limitation rather than an
-- oversight: `expires_at` is enforced at the CHECK (nothing can be written with
-- a lifetime past the ceiling) and at the READ (lib/sensingAnonStore.ts refuses
-- expired rows and they cannot reach an aggregate), so an unswept row is already
-- invisible. Physical deletion is `purgeExpiredSensingContributions`, which
-- exists and is called by nothing.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'gen_random_uuid') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: gen_random_uuid() must be available (pgcrypto or PG13+).';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.sensing_contributions (
  -- Per-row random identity. v4, so it encodes no timestamp and orders nothing.
  contribution_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The ROTATING pseudonym. 64 lowercase hex = HMAC-SHA256 digest. Distinct
  -- rotation_id count is what the privacy gate is handed as distinctActors.
  rotation_id     text NOT NULL CHECK (rotation_id ~ '^[0-9a-f]{64}$'),

  -- The revocation handle. Same digest shape, epoch-scoped, cohort-agnostic.
  revocation_tag  text NOT NULL CHECK (revocation_tag ~ '^[0-9a-f]{64}$'),

  -- Independent-group token from lib/intelGroupKey.deriveGroupKey, epoch-scoped
  -- by the writer. NULL is the NORMAL case for an anonymous contribution and
  -- means "no attested independent group", which earns ZERO group credit in
  -- lib/intelIndependence — never a group inferred from a separate pseudonym.
  group_key       text CHECK (group_key ~ '^[0-9a-f]{64}$'),

  -- The cohort / coverage grouping key. An OPAQUE caller-supplied label (a zone
  -- id, a canonical place id, whatever the aggregation groups by). Deliberately
  -- NOT a coordinate and deliberately NOT a foreign key: this table introduces
  -- no fourth spatial model and takes no reference to one.
  cohort_key      text NOT NULL CHECK (length(cohort_key) BETWEEN 1 AND 128),

  -- Start of the rotation/aggregation bucket, aligned to the grid by the writer.
  -- The ONLY time this table knows about a contribution.
  bucket_start    timestamptz NOT NULL,

  -- WHAT was sensed. A closed vocabulary; an unknown kind is not storable.
  signal_kind     text NOT NULL CHECK (signal_kind IN (
                    'crowd_density',
                    'queue_length',
                    'noise_level',
                    'movement_pace',
                    'availability'
                  )),

  -- HOW MUCH, reduced to a coarse band. A raw magnitude is never stored: three
  -- bands is the privacy reduction, and it is enforced here rather than trusted
  -- to the writer.
  signal_band     text NOT NULL CHECK (signal_band IN ('low', 'moderate', 'high')),

  -- TTL. No DEFAULT on purpose (2312's reasoning): a lifetime must be written
  -- deliberately or not at all, so an INSERT that forgets it fails loudly rather
  -- than inheriting a quiet 24 hours.
  expires_at      timestamptz NOT NULL,

  -- "Short-lived" made structural. Measured from bucket_start because there is
  -- no created_at to measure from, and capped at 72 hours so no writer can turn
  -- this into durable behavioural history by passing a large TTL.
  CONSTRAINT sensing_contributions_ttl_bounded CHECK (
    expires_at > bucket_start
    AND expires_at <= bucket_start + interval '72 hours'
  )
);

COMMENT ON TABLE public.sensing_contributions IS
  'Anonymous sensing contribution store (owner ruling 2026-09-06). Privacy-reduced sensor bands keyed to a ROTATING pseudonym, a cohort key and a bucket, with a hard 72h TTL and identity-free revocation. NOT a second intel lifecycle: intel_observations -> intel_claims -> intel_state_snapshots remains canonical, and this table carries no status/review/conflict/snapshot column and no foreign key of any kind. Aggregation is a pure read-time function (lib/sensingAnonStore.ts) routed through lib/privacyGate.evaluatePrivacy; no aggregate is stored. service_role only. Ships empty and has no writer.';

COMMENT ON COLUMN public.sensing_contributions.rotation_id IS
  'Server-keyed HMAC over (client-held secret, bucket_start, cohort_key). Rotates on exactly the privacy gate aggregation clock, so one person is exactly one rotation_id per aggregated cohort — a faster rotation would inflate the distinct-actor count the gate depends on.';

COMMENT ON COLUMN public.sensing_contributions.revocation_tag IS
  'Server-keyed HMAC over (client-held secret, bucket_start). Cohort-agnostic so one revocation sweeps every cohort in that bucket; epoch-scoped so the linkage it creates cannot outlive one bucket. The secret is never stored and the tag cannot be inverted.';

COMMENT ON COLUMN public.sensing_contributions.cohort_key IS
  'Opaque caller-supplied grouping label. Never a coordinate, never a foreign key — this store introduces no new spatial model and references none.';

-- Read path: one cohort, one bucket, unexpired.
CREATE INDEX IF NOT EXISTS sensing_contributions_cohort_bucket_idx
  ON public.sensing_contributions (cohort_key, bucket_start);
-- Revocation path: delete every row carrying one of the presented tags.
CREATE INDEX IF NOT EXISTS sensing_contributions_revocation_idx
  ON public.sensing_contributions (revocation_tag);
-- TTL path: the (unscheduled) purge, and the reader's expiry filter.
CREATE INDEX IF NOT EXISTS sensing_contributions_expiry_idx
  ON public.sensing_contributions (expires_at);

-- RLS ON with NO POLICIES — the deny-by-default posture 2217 established for
-- protected_zones. service_role bypasses RLS and is the only principal holding a
-- grant, so the table is unreachable from anon and authenticated even if a
-- future grant is added by accident. A sensing contribution must never be
-- readable row-by-row through PostgREST: the protection is the aggregate, and a
-- row on its own is the thing the aggregate exists to hide.
ALTER TABLE public.sensing_contributions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sensing_contributions FROM PUBLIC;
REVOKE ALL ON public.sensing_contributions FROM anon;
REVOKE ALL ON public.sensing_contributions FROM authenticated;
REVOKE ALL ON public.sensing_contributions FROM service_role;
GRANT SELECT, INSERT, DELETE ON public.sensing_contributions TO service_role;
-- No UPDATE grant, to anyone. A contribution is a one-shot statement about a
-- bucket that has already happened; the only legitimate mutations are expiry and
-- revocation, and both are DELETE.

-- ── POSTCONDITIONS ──────────────────────────────────────────────────────────
-- Each is `IF <bad thing> THEN RAISE`, never an unconditional reporter — see
-- src/test/migrationDeployability.test.ts for why that distinction is a rule.

DO $$
BEGIN
  IF to_regclass('public.sensing_contributions') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: sensing_contributions table missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'public.sensing_contributions'::regclass AND relrowsecurity = true
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: RLS not enabled on sensing_contributions';
  END IF;
END $$;

-- THE RULING'S HARD LINE: no permanent profiles/user FK. Checked as "no foreign
-- key at all", which is strictly stronger and closes the indirection route.
DO $$
DECLARE offending text;
BEGIN
  SELECT string_agg(c.conname::text || ' -> ' || fn.nspname::text || '.' || f.relname::text, ', ')
    INTO offending
  FROM pg_constraint c
  JOIN pg_class     t  ON t.oid  = c.conrelid
  JOIN pg_namespace n  ON n.oid  = t.relnamespace
  JOIN pg_class     f  ON f.oid  = c.confrelid
  JOIN pg_namespace fn ON fn.oid = f.relnamespace
  WHERE c.contype = 'f'
    AND n.nspname = 'public'
    AND t.relname = 'sensing_contributions';

  IF offending IS NOT NULL THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED: sensing_contributions carries a FOREIGN KEY (%). The owner ruling of 2026-09-06 forbids a permanent profiles/user FK on this store, and this check forbids every FK because an FK to any user-keyed table reintroduces the same join one indirection away.',
      offending;
  END IF;
END $$;

-- No user-identifying column may exist, by name. This is the other half of the
-- FK rule: a bare uuid column called actor_id is a user link with no constraint
-- attached, and pg_constraint would never see it.
DO $$
DECLARE offending text;
BEGIN
  SELECT string_agg(column_name, ', ') INTO offending
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name   = 'sensing_contributions'
    AND column_name IN (
      'user_id', 'actor_id', 'profile_id', 'owner_id', 'author_id', 'created_by',
      'member_id', 'viewer_id', 'accepted_by', 'contributor_id', 'host_id',
      'buddy_id', 'sender_id', 'recipient_id', 'follower_id', 'following_id',
      'reporter_id', 'submitted_by', 'uploader_id', 'auth_user_id', 'device_id'
    );

  IF offending IS NOT NULL THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED: sensing_contributions carries a user-identifying column (%). The anonymous store may hold a ROTATING id and nothing else that names a person or a device.',
      offending;
  END IF;
END $$;

-- The ruling's "must not duplicate claim/review/status/conflict/snapshot
-- semantics", enforced as negative space in the column list.
DO $$
DECLARE offending text;
BEGIN
  SELECT string_agg(column_name, ', ') INTO offending
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name   = 'sensing_contributions'
    AND (
      column_name LIKE '%status%'   OR column_name LIKE '%state%'
      OR column_name LIKE '%claim%'  OR column_name LIKE '%review%'
      OR column_name LIKE '%conflict%' OR column_name LIKE '%snapshot%'
      OR column_name LIKE '%confidence%' OR column_name LIKE '%verified%'
      OR column_name LIKE '%supersed%'   OR column_name LIKE '%resolv%'
      OR column_name LIKE '%observation%'
    );

  IF offending IS NOT NULL THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED: sensing_contributions carries lifecycle column(s) (%). The owner ruling of 2026-09-06 keeps claim/review/status/conflict/snapshot semantics in the canonical intel spine (intel_observations -> intel_claims -> intel_state_snapshots); this store owns contributions, rotation, TTL, cohort aggregation and revocation only.',
      offending;
  END IF;
END $$;

-- No anon/authenticated POLICY, and in fact no policy at all (2217 posture).
DO $$
DECLARE
  exposed      text;
  policy_count int;
BEGIN
  SELECT string_agg(policyname::text || ' [' || array_to_string(roles, '/') || ']', ', ')
    INTO exposed
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename  = 'sensing_contributions'
    AND roles && ARRAY['anon', 'authenticated', 'public']::name[];

  IF exposed IS NOT NULL THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED: sensing_contributions has an anon/authenticated policy (%). This table is service_role only — a per-row read by any user principal defeats the aggregate that protects it.',
      exposed;
  END IF;

  SELECT count(*) INTO policy_count
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'sensing_contributions';

  IF policy_count <> 0 THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED: sensing_contributions has % policy/policies. RLS is enabled with ZERO policies on purpose (deny-by-default); service_role bypasses RLS and needs none.',
      policy_count;
  END IF;
END $$;

-- No grant to a user principal either. RLS already denies, but the grant must
-- not exist: ALTER DEFAULT PRIVILEGES in this database hands new tables to
-- authenticated, which is the blanket-grant hole 2172 documents.
DO $$
DECLARE granted text;
BEGIN
  -- Read the ACL itself rather than information_schema.role_table_grants: that
  -- view only shows privileges whose grantor or grantee is a currently enabled
  -- role, so a grant made by someone else would be invisible and the check would
  -- pass by not looking. aclexplode has no such filter. grantee = 0 is PUBLIC.
  SELECT string_agg(DISTINCT coalesce(g.rolname::text, 'PUBLIC') || ':' || a.privilege_type, ', ')
    INTO granted
  FROM pg_class      c
  JOIN pg_namespace  n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(c.relacl) a
  LEFT JOIN pg_roles g ON g.oid = a.grantee
  WHERE n.nspname = 'public'
    AND c.relname = 'sensing_contributions'
    AND (a.grantee = 0 OR g.rolname IN ('anon', 'authenticated'));

  IF granted IS NOT NULL THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED: sensing_contributions grants privileges to a user principal (%). Only service_role may hold a grant on this table.',
      granted;
  END IF;
END $$;

COMMIT;

-- REVERSAL:
--   DROP TABLE IF EXISTS public.sensing_contributions;
-- Safe at any time while the table has no writer. Dropping it destroys only
-- contributions that were already inside a 72-hour ceiling.
