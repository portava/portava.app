-- Migration 0110: rent_buddy_payouts table for payout hold/release lifecycle
-- Payouts represent amounts owed to buddies after booking completion.

CREATE TABLE IF NOT EXISTS rent_buddy_payouts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id        UUID NOT NULL REFERENCES rent_buddy_bookings(id) ON DELETE CASCADE,
  buddy_id          UUID NOT NULL REFERENCES rent_buddy_profiles(id),
  amount_usd        NUMERIC(10,2) NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'pending',
    -- 'pending' | 'on_hold' | 'approved' | 'released' | 'failed'
  hold_reason       TEXT,
  released_by       UUID REFERENCES profiles(id),
  held_by           UUID REFERENCES profiles(id),
  held_at           TIMESTAMPTZ,
  released_at       TIMESTAMPTZ,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE rent_buddy_payouts ENABLE ROW LEVEL SECURITY;
CREATE POLICY rb_payout_svc ON rent_buddy_payouts
  FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY rb_payout_buddy_read ON rent_buddy_payouts FOR SELECT
  USING (buddy_id IN (SELECT id FROM rent_buddy_profiles WHERE user_id = auth.uid()));

CREATE INDEX IF NOT EXISTS rb_payouts_booking_idx ON rent_buddy_payouts(booking_id);
CREATE INDEX IF NOT EXISTS rb_payouts_buddy_idx   ON rent_buddy_payouts(buddy_id);
CREATE INDEX IF NOT EXISTS rb_payouts_status_idx  ON rent_buddy_payouts(status);
