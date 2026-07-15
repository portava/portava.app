-- 0011: Add GPS coordinate columns to trip_plan_items
-- lat/lng are optional public-safe coordinates for map view.
-- location_is_private controls whether coordinates are exposed to viewers.

ALTER TABLE trip_plan_items
  ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS location_is_private BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN trip_plan_items.lat IS
  'Public-safe latitude. NULL unless explicitly set. Always null when location_is_private=true.';
COMMENT ON COLUMN trip_plan_items.lng IS
  'Public-safe longitude. NULL unless explicitly set. Always null when location_is_private=true.';
COMMENT ON COLUMN trip_plan_items.location_is_private IS
  'When true, lat/lng are stripped from all non-owner API responses.';
