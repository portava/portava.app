-- 2273_intel_replayable_projection.sql
-- Intelligence Gathering unit I1 — replayable projection + lineage (spec §1
-- "every model decision is reproducible", §8 "store every component so the
-- result can be replayed", §11 Table 17 snapshot schema, Appendix B "every
-- projection is replayable").
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). IG band 2273.
--
-- ── THE DEFECT THIS CLOSES ───────────────────────────────────────────────────
-- lib/confidenceScore.scoreConfidence returns the full replayable record
-- (components, penalties, raw, penalty, formulaVersion) and its own header says
-- "callers persist the whole record, never just the number". The projection
-- writer (lib/intelProjection.projectClaim) kept ONLY `confidence` and `band`,
-- and intel_state_snapshots is upserted IN PLACE on (subject_id, zone_id,
-- claim_type) — so a snapshot could never be replayed, and every earlier
-- projection of the same key was overwritten. Nothing recorded which claim
-- versions produced a state or which algorithm produced it. Table 17 requires
-- input_claim_versions, conflict_state and algorithm_version on the snapshot.
--
-- ── WHAT THIS ADDS ───────────────────────────────────────────────────────────
--   1. intel_state_snapshots gains the Table-17 lineage columns, all NULLABLE
--      and additive so every existing row stays valid:
--        confidence_components jsonb  the ConfidenceResult (components, penalties,
--                                     raw, penalty, formulaVersion) + the freshness
--                                     inputs (age, ttl, curve) — the replay inputs
--        algorithm_version     text   required for replay (Table 17)
--        input_claim_versions  jsonb  array of {claim_id, updated_at, version}
--        conflict_state        text   none | contextualized | material. COLUMN
--                                     ONLY: unit I2 (conflict detection) populates
--                                     it; this unit writes NULL.
--   2. intel_state_snapshot_versions — an APPEND-ONLY history table. The
--      current-state table stays an in-place upsert (readers key on it), and
--      every projection pass appends one immutable version row per snapshot
--      write, carrying the same lineage. This is the "immutable state snapshot"
--      §11 asks for: the current row is a cache, the version row is the record.
--
-- ── APPEND-ONLY ENFORCEMENT ──────────────────────────────────────────────────
-- Reuses public.intel_append_only() from 2130: a BEFORE UPDATE OR DELETE row
-- trigger that RAISEs on UPDATE unconditionally and on DELETE unless the
-- transaction has declared `portava.erasure_in_progress` (the same declaration
-- the observation tables use, so a future retention purge can run under it).
-- Plus a BEFORE TRUNCATE guard that refuses unconditionally. The grants say the
-- same thing: service_role gets INSERT + SELECT only — no UPDATE, no DELETE.
-- 2137 removed the statement-level UPDATE/DELETE trigger from the observation
-- tables for good reason (it fires on zero-row statements and broke unrelated
-- teardown); this table follows the post-2137 shape: row trigger + truncate
-- guard, nothing at statement level.
--
-- ── NO FOREIGN KEYS, DELIBERATELY ────────────────────────────────────────────
-- A version row is a record of a computation. subject_id is a places(id) value
-- but carries no FK: an ON DELETE CASCADE from places would issue a DELETE that
-- the append-only trigger refuses, blocking place deletion; ON DELETE SET NULL
-- would issue an UPDATE the trigger refuses just the same. The current-state
-- table (intel_state_snapshots) keeps its FK and cascades; the history is a log
-- and is keyed, not joined. It carries no actor column and no personal data —
-- distinct_actors is a count (already classified restricted on the snapshot).
--
-- ── RETENTION ────────────────────────────────────────────────────────────────
-- Unbounded by this migration. The projection runs every five minutes, so this
-- table grows by one row per live (subject, zone, claim_type) key per pass; an
-- index on generated_at is provided for the retention purge that an owner
-- retention ruling will add (it must run under the erasure declaration, exactly
-- like purge_expired_intel_snapshots). Not invented here.
--
-- RUNTIME EFFECT: NONE until the paired code lands AND intel_claim_projection_crowd
-- is on (it is off). No flag is seeded or changed here.

BEGIN;

-- ── Preconditions ────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.intel_state_snapshots') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: apply 2130_intel_storage.sql first (intel_state_snapshots missing).';
  END IF;
  IF to_regprocedure('public.intel_append_only()') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.intel_append_only() (2130) is missing — the version table cannot be made append-only.';
  END IF;
END $$;

-- ── 1. Table-17 lineage columns on the current-state snapshot ────────────────
ALTER TABLE public.intel_state_snapshots
  ADD COLUMN IF NOT EXISTS confidence_components jsonb,
  ADD COLUMN IF NOT EXISTS algorithm_version text,
  ADD COLUMN IF NOT EXISTS input_claim_versions jsonb,
  ADD COLUMN IF NOT EXISTS conflict_state text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'intel_state_snapshots_conflict_state_check') THEN
    ALTER TABLE public.intel_state_snapshots
      ADD CONSTRAINT intel_state_snapshots_conflict_state_check
      CHECK (conflict_state IS NULL OR conflict_state IN ('none', 'contextualized', 'material'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'intel_state_snapshots_input_claim_versions_array') THEN
    ALTER TABLE public.intel_state_snapshots
      ADD CONSTRAINT intel_state_snapshots_input_claim_versions_array
      CHECK (input_claim_versions IS NULL OR jsonb_typeof(input_claim_versions) = 'array');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'intel_state_snapshots_confidence_components_object') THEN
    ALTER TABLE public.intel_state_snapshots
      ADD CONSTRAINT intel_state_snapshots_confidence_components_object
      CHECK (confidence_components IS NULL OR jsonb_typeof(confidence_components) = 'object');
  END IF;
END $$;

COMMENT ON COLUMN public.intel_state_snapshots.confidence_components IS
  'I1: the replay record — lib/confidenceScore ConfidenceResult (components, penalties, raw, penalty, formulaVersion, invalid) plus the freshness inputs (ageSeconds, ttlSeconds, curve). Replaying it through the same formula reproduces confidence + band.';
COMMENT ON COLUMN public.intel_state_snapshots.algorithm_version IS
  'I1 / Table 17: the projection algorithm version that produced this state. Required for replay; a replay under a different version reports divergence.';
COMMENT ON COLUMN public.intel_state_snapshots.input_claim_versions IS
  'I1 / Table 17: exact lineage array of {claim_id, updated_at, version, status} for the claims that fed this state.';
COMMENT ON COLUMN public.intel_state_snapshots.conflict_state IS
  'Table 17: none | contextualized | material. Column only in I1 (written NULL); unit I2 (conflict detection) populates it.';

-- ── 2. Append-only version history ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.intel_state_snapshot_versions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id            uuid NOT NULL,
  zone_id               text NOT NULL DEFAULT '',
  claim_type            text NOT NULL,
  value                 jsonb NOT NULL,
  confidence            numeric,
  confidence_band       text,
  source_count          integer NOT NULL DEFAULT 0,
  distinct_actors       integer,
  privacy_eligible      boolean NOT NULL DEFAULT false,
  privacy_reason        text,
  observed_at           timestamptz NOT NULL,
  expires_at            timestamptz NOT NULL,
  confidence_components jsonb NOT NULL,
  algorithm_version     text NOT NULL,
  input_claim_versions  jsonb NOT NULL DEFAULT '[]'::jsonb,
  conflict_state        text,
  generated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT intel_state_snapshot_versions_band_check
    CHECK (confidence_band IS NULL OR confidence_band IN ('unverified','provisional','likely_current','live','strong')),
  CONSTRAINT intel_state_snapshot_versions_confidence_range
    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  CONSTRAINT intel_state_snapshot_versions_conflict_state_check
    CHECK (conflict_state IS NULL OR conflict_state IN ('none', 'contextualized', 'material')),
  CONSTRAINT intel_state_snapshot_versions_components_object
    CHECK (jsonb_typeof(confidence_components) = 'object'),
  CONSTRAINT intel_state_snapshot_versions_claim_versions_array
    CHECK (jsonb_typeof(input_claim_versions) = 'array'),
  CONSTRAINT intel_state_snapshot_versions_algorithm_version_nonempty
    CHECK (length(algorithm_version) BETWEEN 1 AND 128)
);

-- Read path: the history of one key, newest first (replay / audit).
CREATE INDEX IF NOT EXISTS intel_state_snapshot_versions_key_generated
  ON public.intel_state_snapshot_versions (subject_id, zone_id, claim_type, generated_at DESC);
-- Retention path: a future purge sweeps by age.
CREATE INDEX IF NOT EXISTS intel_state_snapshot_versions_generated_at
  ON public.intel_state_snapshot_versions (generated_at);

-- Append-only: row-level UPDATE/DELETE guard + TRUNCATE guard (post-2137 shape).
DROP TRIGGER IF EXISTS intel_state_snapshot_versions_no_update_delete ON public.intel_state_snapshot_versions;
CREATE TRIGGER intel_state_snapshot_versions_no_update_delete
  BEFORE UPDATE OR DELETE ON public.intel_state_snapshot_versions
  FOR EACH ROW EXECUTE FUNCTION public.intel_append_only();
DROP TRIGGER IF EXISTS intel_state_snapshot_versions_no_truncate ON public.intel_state_snapshot_versions;
CREATE TRIGGER intel_state_snapshot_versions_no_truncate
  BEFORE TRUNCATE ON public.intel_state_snapshot_versions
  FOR EACH STATEMENT EXECUTE FUNCTION public.intel_append_only();

-- RLS + grants: deny-default, REVOKE first (2093/2130 shape), then INSERT+SELECT
-- for service_role only. No UPDATE, no DELETE, for anyone — the trigger and the
-- grant say the same thing. No policies: service_role bypasses RLS and no other
-- role holds a privilege, so this is deny-all by design.
ALTER TABLE public.intel_state_snapshot_versions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.intel_state_snapshot_versions FROM PUBLIC;
REVOKE ALL ON public.intel_state_snapshot_versions FROM anon;
REVOKE ALL ON public.intel_state_snapshot_versions FROM authenticated;
REVOKE ALL ON public.intel_state_snapshot_versions FROM service_role;
GRANT INSERT, SELECT ON public.intel_state_snapshot_versions TO service_role;

COMMENT ON TABLE public.intel_state_snapshot_versions IS
  'I1: append-only history of every projection write (spec §11 "write immutable state snapshot with input claim versions and algorithm version"). One row per snapshot write per pass. UPDATE/DELETE refused by trigger and by grant; no FKs (a log is keyed, not joined). Service-role only.';

-- ── Postconditions (conditional RAISE only) ──────────────────────────────────
DO $$
DECLARE
  missing_cols int;
  bad_grants int;
  client_grants int;
BEGIN
  SELECT 4 - count(*) INTO missing_cols FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'intel_state_snapshots'
     AND column_name IN ('confidence_components','algorithm_version','input_claim_versions','conflict_state');
  IF missing_cols <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: % Table-17 lineage column(s) missing from intel_state_snapshots', missing_cols;
  END IF;

  IF to_regclass('public.intel_state_snapshot_versions') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: intel_state_snapshot_versions was not created';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = 'public' AND c.relname = 'intel_state_snapshot_versions' AND c.relrowsecurity) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: RLS is not enabled on intel_state_snapshot_versions';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'intel_state_snapshot_versions_no_update_delete')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'intel_state_snapshot_versions_no_truncate') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: append-only triggers missing on intel_state_snapshot_versions';
  END IF;

  -- The grant must not contradict the trigger: nobody may hold UPDATE or DELETE.
  SELECT count(*) INTO bad_grants FROM information_schema.role_table_grants
   WHERE table_schema = 'public' AND table_name = 'intel_state_snapshot_versions'
     AND privilege_type IN ('UPDATE','DELETE','TRUNCATE');
  IF bad_grants > 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: % UPDATE/DELETE/TRUNCATE grant(s) exist on the append-only version table', bad_grants;
  END IF;

  -- Client roles hold nothing at all.
  SELECT count(*) INTO client_grants FROM information_schema.role_table_grants
   WHERE table_schema = 'public' AND table_name = 'intel_state_snapshot_versions'
     AND grantee IN ('anon','authenticated');
  IF client_grants > 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: anon/authenticated hold % privilege(s) on intel_state_snapshot_versions', client_grants;
  END IF;
END $$;

COMMIT;

-- REVERSAL:
--   DROP TABLE IF EXISTS public.intel_state_snapshot_versions;
--   ALTER TABLE public.intel_state_snapshots
--     DROP CONSTRAINT IF EXISTS intel_state_snapshots_conflict_state_check,
--     DROP CONSTRAINT IF EXISTS intel_state_snapshots_input_claim_versions_array,
--     DROP CONSTRAINT IF EXISTS intel_state_snapshots_confidence_components_object,
--     DROP COLUMN IF EXISTS confidence_components,
--     DROP COLUMN IF EXISTS algorithm_version,
--     DROP COLUMN IF EXISTS input_claim_versions,
--     DROP COLUMN IF EXISTS conflict_state;
-- (Reverse alongside the paired intelProjection.ts change; the writer inserts
-- these columns unconditionally.)
