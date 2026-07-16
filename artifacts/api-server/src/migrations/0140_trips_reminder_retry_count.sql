-- 0140_trips_reminder_retry_count.sql
-- Tracks how many times the crash-recovery sweep has attempted to re-send a
-- reminder that was claimed but never delivered.
--
-- The scheduler increments this counter on every failed recovery attempt and
-- stops retrying once it reaches the configured maximum (currently 3).  This
-- prevents an indefinitely-retried stale claim from producing noisy logs and
-- wasted DB round-trips when all push tokens are invalid or Supabase is in a
-- persistent error state.

ALTER TABLE trips ADD COLUMN IF NOT EXISTS reminder_retry_count integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN trips.reminder_retry_count IS
  'Number of recovery-sweep retry attempts made after a crash-between-claim-and-send. '
  'Incremented on each failed recovery attempt; rows at or above the configured maximum '
  'are excluded from future recovery queries (permanently abandoned).';
