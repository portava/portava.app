-- Migration 0048: booking_stay_connected
-- Adds stay_connected_traveler and stay_connected_buddy to rent_buddy_bookings.
-- Replaces the ephemeral in-memory Map so opt-ins survive server restarts
-- and work across multiple API instances.

ALTER TABLE rent_buddy_bookings
  ADD COLUMN IF NOT EXISTS stay_connected_traveler BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS stay_connected_buddy    BOOLEAN NOT NULL DEFAULT FALSE;
