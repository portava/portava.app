-- Migration 0113: Rent-a-Buddy lifecycle fixes
-- Adds: new checkin_type enum values, no_show_pending booking status,
--       no_show_grace_expires_at column, and booking change-request table

-- ── 1. New checkin_type values ────────────────────────────────────────────────
-- Existing: arrival, comfort_30min, check_ok, uncomfortable, end_early,
--           contact_support, start_safe_return, emergency_phrase
-- New values needed by lifecycle check-in and no-show endpoints:

ALTER TYPE rent_buddy_checkin_type ADD VALUE IF NOT EXISTS 'arrived';
ALTER TYPE rent_buddy_checkin_type ADD VALUE IF NOT EXISTS 'started';
ALTER TYPE rent_buddy_checkin_type ADD VALUE IF NOT EXISTS 'could_not_find';
ALTER TYPE rent_buddy_checkin_type ADD VALUE IF NOT EXISTS 'no_show';
ALTER TYPE rent_buddy_checkin_type ADD VALUE IF NOT EXISTS 'unsafe';
ALTER TYPE rent_buddy_checkin_type ADD VALUE IF NOT EXISTS 'missed';

-- ── 2. no_show_pending booking status ────────────────────────────────────────
-- Booking enters no_show_pending when a party reports the other did not appear.
-- The expiry sweeper escalates to 'disputed' after no_show_grace_expires_at.

ALTER TYPE rent_buddy_booking_status ADD VALUE IF NOT EXISTS 'no_show_pending';

-- ── 3. no_show_grace_expires_at column ────────────────────────────────────────
-- Records when the grace period for a no-show response expires.
-- Set by the no-show reporting endpoint; read by the expiry sweeper.

ALTER TABLE rent_buddy_bookings
  ADD COLUMN IF NOT EXISTS no_show_grace_expires_at TIMESTAMPTZ;

-- ── 4. buddy_booking_change_requests — time/service/price change requests ─────
-- Distinct from rent_buddy_route_change_requests (which tracks GPS route stops).
-- This table tracks proposed changes to booking date, start time, duration,
-- service type, or agreed price before the session starts.
--
-- Either party can raise a change request; the other party accepts or declines.
-- Only accepted requests mutate the booking row.

CREATE TABLE IF NOT EXISTS buddy_booking_change_requests (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id       UUID NOT NULL REFERENCES rent_buddy_bookings(id) ON DELETE CASCADE,
  requested_by     UUID NOT NULL REFERENCES profiles(id),
  change_field     TEXT NOT NULL,   -- 'date' | 'start_time' | 'duration_h' | 'service' | 'price_usd'
  current_value    JSONB NOT NULL DEFAULT '{}',
  proposed_value   JSONB NOT NULL DEFAULT '{}',
  reason           TEXT,
  status           rent_buddy_change_request_status NOT NULL DEFAULT 'pending',
  responded_by     UUID REFERENCES profiles(id),
  response_note    TEXT,
  responded_at     TIMESTAMPTZ,
  expires_at       TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for fast lookup of pending change requests for a booking
CREATE INDEX IF NOT EXISTS idx_buddy_bk_change_requests_booking
  ON buddy_booking_change_requests (booking_id, status);

-- RLS: parties to the booking can read; service role has full access
ALTER TABLE buddy_booking_change_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY bk_chg_req_read ON buddy_booking_change_requests FOR SELECT
  USING (
    requested_by = auth.uid()
    OR booking_id IN (
      SELECT id FROM rent_buddy_bookings
      WHERE traveler_id = auth.uid()
    )
  );

CREATE POLICY bk_chg_req_svc ON buddy_booking_change_requests FOR ALL
  USING (auth.role() = 'service_role');
