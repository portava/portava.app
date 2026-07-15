-- 0022_availability_nudges.sql
--
-- Stores per-trip availability nudge notifications.
--
-- When a trip member marks specific dates as free, fellow members who have not
-- yet explicitly set their availability for that day receive one nudge.
-- Rate limit: one nudge per (recipient, trip) per calendar day, enforced by
-- the unique constraint — regardless of how many senders mark themselves free.

CREATE TABLE IF NOT EXISTS availability_nudges (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id    UUID         NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  recipient_id UUID         NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  trip_id      UUID         NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  nudge_date   DATE         NOT NULL,  -- representative free date being announced
  sent_on      DATE         NOT NULL DEFAULT CURRENT_DATE,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  -- One nudge per recipient per trip per calendar day (any sender)
  UNIQUE (recipient_id, trip_id, sent_on)
);

-- Recipients can read their own nudges; the service role handles all writes.
ALTER TABLE availability_nudges ENABLE ROW LEVEL SECURITY;

CREATE POLICY "availability_nudges_select"
  ON availability_nudges FOR SELECT
  USING (auth.uid() = recipient_id);

-- Fast lookup for unread-counts (recipient + created_at range).
CREATE INDEX availability_nudges_recipient_created_idx
  ON availability_nudges (recipient_id, created_at);
