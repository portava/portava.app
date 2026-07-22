-- Add an index on discovery_places.osm_id to speed up the join side of Path B
-- in eventPostsDiscovery.ts, which joins posts → discovery_places on
-- location_place_id = osm_id.  Without this index the DB must scan
-- discovery_places on every cache miss.
--
-- osm_id is nullable so the partial index (WHERE osm_id IS NOT NULL) keeps it
-- small and mirrors the partial index on posts.location_place_id (0103).

CREATE INDEX IF NOT EXISTS idx_discovery_places_osm_id
  ON discovery_places (osm_id)
  WHERE osm_id IS NOT NULL;
