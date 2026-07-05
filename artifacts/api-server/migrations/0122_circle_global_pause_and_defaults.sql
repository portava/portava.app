-- Migration 0122: Add global pause + per-type sharing defaults to circle_visibility_settings
-- Adds: trip_sharing_default, event_sharing_default, is_paused, paused_until

ALTER TABLE circle_visibility_settings
  ADD COLUMN IF NOT EXISTS trip_sharing_default TEXT    NOT NULL DEFAULT 'status_only',
  ADD COLUMN IF NOT EXISTS event_sharing_default TEXT   NOT NULL DEFAULT 'status_only',
  ADD COLUMN IF NOT EXISTS is_paused            BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS paused_until         TIMESTAMPTZ;

-- Constraint: only allow valid mode values for the per-type defaults
ALTER TABLE circle_visibility_settings
  DROP CONSTRAINT IF EXISTS circle_vis_trip_default_check;

ALTER TABLE circle_visibility_settings
  ADD CONSTRAINT circle_vis_trip_default_check
    CHECK (trip_sharing_default IN ('off', 'status_only', 'approximate_area', 'venue_checkin'));

ALTER TABLE circle_visibility_settings
  DROP CONSTRAINT IF EXISTS circle_vis_event_default_check;

ALTER TABLE circle_visibility_settings
  ADD CONSTRAINT circle_vis_event_default_check
    CHECK (event_sharing_default IN ('off', 'status_only', 'approximate_area', 'venue_checkin'));
