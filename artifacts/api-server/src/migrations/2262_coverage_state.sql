BEGIN;
ALTER TABLE public.intel_coverage_snapshots
  ADD COLUMN IF NOT EXISTS coverage_state text NOT NULL DEFAULT 'unknown'
  CHECK (coverage_state IN ('covered','no_coverage','unknown'));
COMMIT;