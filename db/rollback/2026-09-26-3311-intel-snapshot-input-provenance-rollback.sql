-- Rollback for 3311_intel_snapshot_input_provenance.sql
--
-- Drops the two provenance columns and their GIN indexes. Safe at any time:
-- the writer (lib/intelProjection.projectAndStore) falls back to writing
-- without the column when PostgREST reports it unknown, and the deletion
-- reach (services/accountDeletion/sensingRevocationReach) falls back to
-- subject-granularity enumeration. What is LOST by rolling back is exactness:
-- an erasure after this rollback can only recompute every snapshot of every
-- subject the account observed, not the ones that rested on its evidence.
-- Idempotent.

DROP INDEX IF EXISTS public.intel_state_snapshots_input_observation_ids_gin;
DROP INDEX IF EXISTS public.intel_state_snapshot_versions_input_observation_ids_gin;
ALTER TABLE public.intel_state_snapshots DROP COLUMN IF EXISTS input_observation_ids;
ALTER TABLE public.intel_state_snapshot_versions DROP COLUMN IF EXISTS input_observation_ids;
