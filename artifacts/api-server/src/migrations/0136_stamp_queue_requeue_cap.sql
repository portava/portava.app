-- 0136: Cap auto-requeue rounds for stamp generation jobs.
--
-- Adds requeue_count (number of automatic re-queue rounds a job has been
-- through) and a terminal 'permanently_failed' status the worker moves jobs
-- into once the cap is reached. Manual admin re-queue resets requeue_count.

ALTER TABLE stamp_generation_queue
  ADD COLUMN IF NOT EXISTS requeue_count int NOT NULL DEFAULT 0;

-- Extend the status CHECK to include the new terminal state.
ALTER TABLE stamp_generation_queue
  DROP CONSTRAINT IF EXISTS stamp_generation_queue_status_check;
ALTER TABLE stamp_generation_queue
  ADD CONSTRAINT stamp_generation_queue_status_check
  CHECK (status IN ('queued', 'generating', 'review_required', 'retryable_failed', 'permanently_failed', 'archived'));

-- The one-active-job-per-catalog partial unique index must not treat
-- permanently_failed rows as "active", or admin regenerate could never
-- enqueue a fresh job for that catalog entry.
DROP INDEX IF EXISTS uix_queue_catalog_active;
CREATE UNIQUE INDEX uix_queue_catalog_active
  ON stamp_generation_queue (catalog_id)
  WHERE status NOT IN ('archived', 'retryable_failed', 'permanently_failed');
