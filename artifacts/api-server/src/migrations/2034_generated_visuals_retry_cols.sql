-- Migration 2034: Add retry and pessimistic-lock columns to generated_visuals
-- Required by VisualGenerationWorker (worker queue & analytics).
-- Idempotent — safe to re-run. attempt_count was already added in 0194.

BEGIN;

ALTER TABLE generated_visuals ADD COLUMN IF NOT EXISTS retry_after  TIMESTAMPTZ;
ALTER TABLE generated_visuals ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;
ALTER TABLE generated_visuals ADD COLUMN IF NOT EXISTS locked_by    TEXT;

-- Speed up worker poll: queued rows eligible for pickup (retry_after in the past or absent)
CREATE INDEX IF NOT EXISTS generated_visuals_retry_idx
  ON generated_visuals (created_at)
  WHERE status = 'queued';

-- Speed up stuck-job recovery: generating rows past their lock
CREATE INDEX IF NOT EXISTS generated_visuals_lock_idx
  ON generated_visuals (locked_until)
  WHERE status = 'generating';

COMMIT;
