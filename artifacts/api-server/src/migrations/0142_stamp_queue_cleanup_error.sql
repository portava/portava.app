-- Migration 0142: surface orphan-cleanup failures on the stamp generation queue row
-- Adds two nullable columns so the worker can record cleanup errors directly on
-- the row instead of only in server logs, allowing ops to see them in the admin UI.
--
--   cleanup_error        TEXT  — error message from the storage remove() call
--   cleanup_error_paths  TEXT[] — storage paths that could not be deleted

ALTER TABLE stamp_generation_queue
  ADD COLUMN IF NOT EXISTS cleanup_error       TEXT        DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS cleanup_error_paths TEXT[]      DEFAULT NULL;

COMMENT ON COLUMN stamp_generation_queue.cleanup_error
  IS 'Error message from orphan cleanup (storage remove) if it failed during a generation failure. NULL when cleanup succeeded or was not needed.';

COMMENT ON COLUMN stamp_generation_queue.cleanup_error_paths
  IS 'Storage paths that were uploaded but could not be deleted when cleanup failed. Ops can use these to manually remove orphaned files from the stamp-artwork bucket.';
