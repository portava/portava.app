-- 0022_availability_nudges.sql
--
-- Stores per-trip availability nudge notifications.
--
-- When a trip member marks specific dates as free, fellow members who have not
-- yet marked that day receive a nudge. The unique constraint enforces the
-- rate-limit: one nudge per (sender, recipient, trip) per calendar day, so
-- multiple PATCH calls in a single day don't spam recipients.

CREATE TABLE IF NOT EXISTS availability_nudges (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id    UUID         NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  recipient_id UUID         NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  trip_id      UUID         NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  nudge_date   DATE         NOT NULL,  -- representative free date being announced
  sent_on      DATE         NOT NULL DEFAULT CURRENT_DATE,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (sender_id, recipient_id, trip_id, sent_on)
);

-- Recipients can read their own nudges; the service role handles all writes.
ALTER TABLE availability_nudges ENABLE ROW LEVEL SECURITY;

CREATE POLICY "availability_nudges_select"
  ON availability_nudges FOR SELECT
  USING (auth.uid() = recipient_id);

-- Fast lookup for unread-counts (recipient + created_at range).
CREATE INDEX availability_nudges_recipient_created_idx
  ON availability_nudges (recipient_id, created_at);
