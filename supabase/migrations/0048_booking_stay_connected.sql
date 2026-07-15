-- Migration 0048: persist stay-connected opt-ins on rent_buddy_bookings
-- Replaces the previous in-memory Map approach so opt-ins survive server
-- restarts and work correctly across multiple API instances.

ALTER TABLE rent_buddy_bookings
  ADD COLUMN IF NOT EXISTS stay_connected_traveler BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS stay_connected_buddy    BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN rent_buddy_bookings.stay_connected_traveler IS
  'TRUE when the traveler has opted to keep the Telegraph thread open after completion.';
COMMENT ON COLUMN rent_buddy_bookings.stay_connected_buddy IS
  'TRUE when the buddy has opted to keep the Telegraph thread open after completion.';
