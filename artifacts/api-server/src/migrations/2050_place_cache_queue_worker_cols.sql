-- Extend place_cache_invalidation_queue with worker lock columns.
--
-- The 2047 migration created the table with only (place_id PK, queued_at).
-- This migration adds the pessimistic-lock columns required by the
-- placeCollectionsWorker so multiple server instances cannot process the
-- same place concurrently.
--
-- place_id remains the PRIMARY KEY — one active queue entry per place.
-- status: 'pending' | 'processing' | 'done'
-- locked_until / locked_by: pessimistic lock (mirrors stamp_generation_queue).

ALTER TABLE place_cache_invalidation_queue
  ADD COLUMN IF NOT EXISTS status       TEXT        NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'done')),
  ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS locked_by    TEXT;

-- Index to speed up the worker's "claim next pending batch" query.
CREATE INDEX IF NOT EXISTS idx_place_cache_invalidation_queue_pending
  ON place_cache_invalidation_queue (queued_at)
  WHERE status = 'pending';
