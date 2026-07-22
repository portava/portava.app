-- Add a partial index on posts.location_place_id to speed up Path B in
-- eventPostsDiscovery.ts, which filters .not("location_place_id", "is", null)
-- and joins to discovery_places on location_place_id = osm_id.
-- Without this index every cache miss causes a full-table scan on posts.

CREATE INDEX IF NOT EXISTS idx_posts_location_place_id
  ON posts (location_place_id)
  WHERE location_place_id IS NOT NULL;
