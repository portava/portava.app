-- Migration 0086: Add osm_id column to discovery_places for OSM save tracking
--
-- OSM places returned by Overpass are not stored in discovery_places, so they
-- have no saved_count and cannot participate in the popular sort.  This migration
-- adds an osm_id column (e.g. "node/12345678") as a stable natural key so that
-- when a user saves an OSM place the wishlist handler can upsert a lightweight
-- row and increment saved_count.  The popular sort then uses real save data
-- instead of falling back to rating as a tie-breaker.
--
-- osm_id is nullable because all existing rows (source='curated' or source='traveler')
-- have no OSM identifier.  The partial unique index enforces uniqueness only where
-- the value is not NULL, keeping the constraint tight without requiring a migration
-- to backfill old rows.
--
-- city has a DEFAULT '' added so that the wishlist handler can insert OSM rows
-- without knowing the destination city.  These rows are used only for saved_count
-- tracking; they won't appear in city-filtered discovery queries (the ilike
-- filter won't match an empty string against a real city name).

ALTER TABLE discovery_places
  ADD COLUMN IF NOT EXISTS osm_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS discovery_places_osm_id_idx
  ON discovery_places (osm_id)
  WHERE osm_id IS NOT NULL;

ALTER TABLE discovery_places
  ALTER COLUMN city SET DEFAULT '';
