-- 3311_intel_snapshot_input_provenance.sql
--
-- ═══════════════════════════════════════════════════════════════════════════
-- FORWARD PROVENANCE FOR PROJECTED STATE (census-sensing S112, §26)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT
--   `input_observation_ids uuid[]` on intel_state_snapshots (the current-state
--   cache) and intel_state_snapshot_versions (the immutable record): the
--   intel_observations.id values the projection READ to produce the row.
--   Written by lib/intelProjection.projectAndStore from the cohort
--   lib/intelProjectionAggregator.assembleClaimInput assembled. NOT NULL with
--   an empty default, so a row written by an older writer reads as "no
--   provenance recorded" rather than as NULL-means-anything; GIN-indexed on
--   both tables so `input_observation_ids && ARRAY[...]` is an index scan.
--
-- WHY
--   census-sensing §24.4 measured that a revocation could only be enumerated
--   at SUBJECT granularity — "every snapshot of every subject the account ever
--   observed", over-inclusive by construction — because nothing recorded which
--   observations a snapshot rested on. §22 / §18.4 name the required effect:
--   when evidence is erased, the state that rested on it is recomputed or
--   retracted. That needs the exact set. This column is the exact set.
--
-- WHAT IT IS NOT (the privacy argument, stated rather than assumed)
--   It is a FORWARD reference from a derived row to opaque observation ids.
--   An observation id names no contributor: intel_observations.actor_id holds
--   a rotating, non-reversible contributor token since 3002, and after an
--   erasure the referenced rows no longer exist at all — the ids dangle, which
--   is the intended trace ("this snapshot rested on evidence that was
--   withdrawn") and nothing more. It creates no path a service-role reader did
--   not already have through (subject_id, claim_type), and it is never served:
--   lib/liveClaimRead selects its columns by name and does not name this one.
--   It is NOT added to sensing_anon_contributions or sensing_published_
--   aggregates (2315 / 3110): the ANONYMOUS store keeps no per-row
--   provenance, per §20 / spec §17, and this migration does not touch it.
--
-- HOW THE WRITER BEHAVES WITHOUT THIS MIGRATION
--   projectAndStore tries the column and, on the schema-cache error PostgREST
--   raises for an unknown column, retries WITHOUT it and logs
--   `intel.projection.provenance_unavailable` at warn level once per process.
--   So deploying the code before this file degrades provenance to
--   "unrecorded" (the reach falls back to subject granularity) rather than
--   stopping every projection. Apply this file BEFORE the code for exact
--   provenance from the first write; see docs/ops/sensing-cutover-runbook.md.
--
-- Additive and idempotent. Re-running is a no-op. Rollback:
--   db/rollback/2026-09-26-3311-intel-snapshot-input-provenance-rollback.sql
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.intel_state_snapshots
  ADD COLUMN IF NOT EXISTS input_observation_ids uuid[] NOT NULL DEFAULT '{}'::uuid[];

ALTER TABLE public.intel_state_snapshot_versions
  ADD COLUMN IF NOT EXISTS input_observation_ids uuid[] NOT NULL DEFAULT '{}'::uuid[];

CREATE INDEX IF NOT EXISTS intel_state_snapshots_input_observation_ids_gin
  ON public.intel_state_snapshots USING gin (input_observation_ids);

CREATE INDEX IF NOT EXISTS intel_state_snapshot_versions_input_observation_ids_gin
  ON public.intel_state_snapshot_versions USING gin (input_observation_ids);

COMMENT ON COLUMN public.intel_state_snapshots.input_observation_ids IS
  'FORWARD provenance: the intel_observations.id values the projection read to produce this row (lib/intelProjection.projectAndStore). Empty means "unrecorded" (written before 3311 or under the writer''s fallback). Opaque ids naming no contributor; never selected by the read path. Read by services/accountDeletion/sensingRevocationReach to find exactly which state rested on erased evidence, and by the erasure recompute that rewrites or retracts it.';

COMMENT ON COLUMN public.intel_state_snapshot_versions.input_observation_ids IS
  'Same as intel_state_snapshots.input_observation_ids, on the immutable record. A retraction version written after an erasure carries an EMPTY array and privacy_reason = ''input_erased''.';

-- ── Postconditions ─────────────────────────────────────────────────────────
DO $$
DECLARE
  v_t text;
  v_type text;
BEGIN
  FOREACH v_t IN ARRAY ARRAY['intel_state_snapshots','intel_state_snapshot_versions'] LOOP
    SELECT udt_name INTO v_type
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = v_t AND column_name = 'input_observation_ids';
    IF v_type IS NULL THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED: %.input_observation_ids is absent.', v_t;
    END IF;
    IF v_type <> '_uuid' THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED: %.input_observation_ids is % rather than uuid[]: a text array would let a non-id ride in.', v_t, v_type;
    END IF;
    PERFORM 1 FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = v_t AND indexname = v_t || '_input_observation_ids_gin';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED: the GIN index on %.input_observation_ids is absent; the reach''s overlap query would seq-scan.', v_t;
    END IF;
  END LOOP;

  -- The anonymous store must stay provenance-free (§20 / spec §17).
  PERFORM 1 FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'sensing_anon_contributions' AND column_name LIKE '%observation%';
  IF FOUND THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: sensing_anon_contributions carries an observation reference; the anonymous store keeps no per-row provenance.';
  END IF;
END $$;
