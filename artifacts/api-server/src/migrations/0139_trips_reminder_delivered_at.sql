-- 0139_trips_reminder_delivered_at.sql
-- Outbox completion marker for the 24h trip-tomorrow reminder.
--
-- reminder_sent_at (migration 0138) is set *before* the push is sent to
-- guarantee at-most-once delivery across restarts.  The trade-off is that a
-- crash in the tiny window between claiming and sending leaves reminder_sent_at
-- set and reminder_delivered_at NULL, which the scheduler detects and recovers.
--
-- Recovery logic: any row where reminder_sent_at IS NOT NULL AND
-- reminder_delivered_at IS NULL AND reminder_sent_at < now() - 10 minutes is
-- re-queued for delivery on the next scheduler poll.

ALTER TABLE trips ADD COLUMN IF NOT EXISTS reminder_delivered_at timestamptz;

COMMENT ON COLUMN trips.reminder_delivered_at IS
  'Set after the 24h trip-tomorrow push was successfully sent. '
  'NULL with a non-NULL reminder_sent_at older than ~10 minutes signals a '
  'crash-between-claim-and-send that the scheduler will recover automatically.';
