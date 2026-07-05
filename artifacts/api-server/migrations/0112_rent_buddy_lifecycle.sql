-- Migration 0112: Rent a Buddy — booking lifecycle state machine hardening
-- Adds missing status enum values, expiry tracking, and decline/dispute window columns.

-- ── New booking status values ───────────────────────────────────────────────
-- declined: buddy explicitly declined the request (not the same as cancelled)
-- expired: request was not answered before expires_at
-- cancelled_by_traveler / cancelled_by_buddy: specific cancellation actors
-- completed_pending_traveler_confirmation: buddy marked done; traveler has dispute window
-- scheduled: spec alias for confirmed (added for contract compatibility)

DO $$ BEGIN
  ALTER TYPE rent_buddy_booking_status ADD VALUE 'declined';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TYPE rent_buddy_booking_status ADD VALUE 'expired';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TYPE rent_buddy_booking_status ADD VALUE 'cancelled_by_traveler';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TYPE rent_buddy_booking_status ADD VALUE 'cancelled_by_buddy';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TYPE rent_buddy_booking_status ADD VALUE 'completed_pending_traveler_confirmation';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TYPE rent_buddy_booking_status ADD VALUE 'scheduled';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Lifecycle tracking columns ──────────────────────────────────────────────

ALTER TABLE rent_buddy_bookings
  ADD COLUMN IF NOT EXISTS expires_at                 TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS decline_reason             TEXT,
  ADD COLUMN IF NOT EXISTS cancellation_reason        TEXT,
  ADD COLUMN IF NOT EXISTS dispute_window_expires_at  TIMESTAMPTZ;

-- Backfill expires_at for existing pending requests (48h from creation)
UPDATE rent_buddy_bookings
  SET expires_at = created_at + INTERVAL '48 hours'
  WHERE status = 'pending'
    AND expires_at IS NULL;

-- ── Indexes for the expiry sweeper ──────────────────────────────────────────

CREATE INDEX IF NOT EXISTS rbb_pending_expires_idx ON rent_buddy_bookings (expires_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS rbb_pending_confirm_expires_idx ON rent_buddy_bookings (dispute_window_expires_at)
  WHERE status = 'completed_pending_traveler_confirmation';
