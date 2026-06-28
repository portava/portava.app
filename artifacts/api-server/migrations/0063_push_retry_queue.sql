-- Migration 0063: push_retry_queue supplemental indexes
--
-- 0062_notifications_schema.sql creates push_retry_queue and its primary
-- index (push_retry_queue_status_next_retry_idx, WHERE status IN
-- ('queued','processing')).  This migration adds two further indexes that
-- complement the worker hot-path without redefining the table schema.
--
-- Safe to re-run: CREATE INDEX IF NOT EXISTS is a no-op when the index exists.
-- Must be run AFTER 0062.

-- Partial index used by the retry-worker tick query:
--   SELECT ... FROM push_retry_queue
--   WHERE status = 'queued' AND next_retry_at <= now()
--   ORDER BY next_retry_at
-- The WHERE clause narrows to 'queued' only (not 'processing'), so this
-- partial index is tighter than the 0062 one and avoids index bloat from
-- already-processed rows.
CREATE INDEX IF NOT EXISTS prq_status_next_retry_idx
  ON public.push_retry_queue (status, next_retry_at)
  WHERE status = 'queued';

-- Supports per-user queue lookups (admin and cleanup queries).
CREATE INDEX IF NOT EXISTS prq_user_idx
  ON public.push_retry_queue (user_id);
