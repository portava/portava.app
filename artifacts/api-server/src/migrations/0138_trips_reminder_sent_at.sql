-- 0138_trips_reminder_sent_at.sql
-- Persistent dedup for the 24h trip-tomorrow reminder.
-- The scheduler previously deduplicated only with an in-memory Set, so any
-- server restart inside the 22-26h window re-sent the reminder to every trip
-- member. The scheduler now atomically claims a trip by setting this column
-- (UPDATE ... WHERE reminder_sent_at IS NULL) before sending.

ALTER TABLE trips ADD COLUMN IF NOT EXISTS reminder_sent_at timestamptz;

COMMENT ON COLUMN trips.reminder_sent_at IS
  'Set when the 24h trip-tomorrow reminder was claimed/sent; NULL = not yet sent.';
