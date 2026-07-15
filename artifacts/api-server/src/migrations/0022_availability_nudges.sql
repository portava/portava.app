-- Migration: 0022_availability_nudges.sql
-- Creates availability_nudges table for rate-limiting nudge messages.

CREATE TABLE IF NOT EXISTS availability_nudges (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id    uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  recipient_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  trip_id      uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  nudge_date   date NOT NULL,
  sent_on      date NOT NULL DEFAULT CURRENT_DATE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT nudges_rate_limit UNIQUE (recipient_id, trip_id, sent_on)
);

ALTER TABLE availability_nudges ENABLE ROW LEVEL SECURITY;

CREATE POLICY "recipients_view_own_nudges" ON availability_nudges
  FOR SELECT USING (auth.uid() = recipient_id);
