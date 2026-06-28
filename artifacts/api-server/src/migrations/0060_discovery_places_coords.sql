-- Migration: add lat/lng coordinates to discovery_places
-- Community-submitted places can now carry an optional coordinate pair so
-- they appear on the DiscoveryMapView alongside OSM results.  Both columns
-- are nullable — existing rows without coordinates are unaffected.

ALTER TABLE discovery_places
  ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION;

-- Partial index for fast map-view queries (only rows that have coordinates).
CREATE INDEX IF NOT EXISTS discovery_places_has_coords_idx
  ON discovery_places (city, place_type)
  WHERE lat IS NOT NULL AND lng IS NOT NULL;
