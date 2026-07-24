-- Migration 2029: PostGIS spatial layer (map audit §30 / #18 — deliberate).
--
-- Enables indexed radius / KNN / containment on the hot geo tables. Approach:
--   • CREATE EXTENSION postgis
--   • a GENERATED geography column per table, computed from the EXISTING lat/lng
--     columns — so NO application write path changes and NO backfill script:
--     the column auto-populates from current rows and stays in sync forever.
--   • a GiST index on each geography column (radius + KNN in one index).
--   • two demonstration RPCs (indexed nearby queries) the app can adopt behind
--     a flag; the JS-haversine / btree-bbox paths keep working untouched until
--     then.
--
-- ⚠ COST / LOCK: adding a STORED generated column REWRITES the table under an
-- ACCESS EXCLUSIVE lock. On large prod tables run this in a maintenance window.
-- It is otherwise idempotent (IF NOT EXISTS throughout) and fully reversible
-- (see 0193_postgis_rollback.sql). CREATE EXTENSION needs a role with rights to
-- create extensions (Supabase: run in the SQL editor / as the service role).
--
-- PREFIX NOTE: numbered 0193 against this snapshot; renumber on collision.

CREATE EXTENSION IF NOT EXISTS postgis;

-- ── Generated geography columns + GiST indexes ────────────────────────────────

-- user_location_state (lat/lng) — Discovery live map.
ALTER TABLE user_location_state
  ADD COLUMN IF NOT EXISTS geog geography(Point,4326)
  GENERATED ALWAYS AS (
    CASE WHEN lat IS NOT NULL AND lng IS NOT NULL
      THEN ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography END
  ) STORED;
CREATE INDEX IF NOT EXISTS user_location_state_geog_gist ON user_location_state USING gist (geog);

-- events (location_lat/location_lng).
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS geog geography(Point,4326)
  GENERATED ALWAYS AS (
    CASE WHEN location_lat IS NOT NULL AND location_lng IS NOT NULL
      THEN ST_SetSRID(ST_MakePoint(location_lng, location_lat), 4326)::geography END
  ) STORED;
CREATE INDEX IF NOT EXISTS events_geog_gist ON events USING gist (geog);

-- posts (location_lat/location_lng) — geofence + nearby.
ALTER TABLE posts
  ADD COLUMN IF NOT EXISTS geog geography(Point,4326)
  GENERATED ALWAYS AS (
    CASE WHEN location_lat IS NOT NULL AND location_lng IS NOT NULL
      THEN ST_SetSRID(ST_MakePoint(location_lng, location_lat), 4326)::geography END
  ) STORED;
CREATE INDEX IF NOT EXISTS posts_geog_gist ON posts USING gist (geog);

-- hidden_gems (exact latitude/longitude + approx_*) — /hidden-gems/nearby.
ALTER TABLE hidden_gems
  ADD COLUMN IF NOT EXISTS geog geography(Point,4326)
  GENERATED ALWAYS AS (
    CASE WHEN latitude IS NOT NULL AND longitude IS NOT NULL
      THEN ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography END
  ) STORED;
ALTER TABLE hidden_gems
  ADD COLUMN IF NOT EXISTS approx_geog geography(Point,4326)
  GENERATED ALWAYS AS (
    CASE WHEN approx_latitude IS NOT NULL AND approx_longitude IS NOT NULL
      THEN ST_SetSRID(ST_MakePoint(approx_longitude, approx_latitude), 4326)::geography END
  ) STORED;
CREATE INDEX IF NOT EXISTS hidden_gems_geog_gist        ON hidden_gems USING gist (geog)        WHERE status = 'active';
CREATE INDEX IF NOT EXISTS hidden_gems_approx_geog_gist ON hidden_gems USING gist (approx_geog) WHERE status = 'active';

-- places (canonical external places, latitude/longitude).
ALTER TABLE places
  ADD COLUMN IF NOT EXISTS geog geography(Point,4326)
  GENERATED ALWAYS AS (
    CASE WHEN latitude IS NOT NULL AND longitude IS NOT NULL
      THEN ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography END
  ) STORED;
CREATE INDEX IF NOT EXISTS places_geog_gist ON places USING gist (geog) WHERE merged_into_place_id IS NULL;

-- fsq_places (provider POIs, latitude/longitude).
ALTER TABLE fsq_places
  ADD COLUMN IF NOT EXISTS geog geography(Point,4326)
  GENERATED ALWAYS AS (
    CASE WHEN latitude IS NOT NULL AND longitude IS NOT NULL
      THEN ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography END
  ) STORED;
CREATE INDEX IF NOT EXISTS fsq_places_geog_gist ON fsq_places USING gist (geog);

-- ── Demonstration RPCs (indexed nearby; adopt behind a flag) ──────────────────

-- Canonical places within radius, nearest first (uses places_geog_gist).
CREATE OR REPLACE FUNCTION places_within_radius(
  p_lat double precision, p_lng double precision, p_radius_m double precision, p_limit int DEFAULT 50
) RETURNS TABLE(id uuid, distance_m double precision)
LANGUAGE sql STABLE AS $$
  WITH q AS (SELECT ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography AS g)
  SELECT p.id, ST_Distance(p.geog, q.g) AS distance_m
  FROM places p, q
  WHERE p.merged_into_place_id IS NULL AND p.geog IS NOT NULL
    AND ST_DWithin(p.geog, q.g, p_radius_m)
  ORDER BY p.geog <-> q.g
  LIMIT p_limit;
$$;

-- Fresh traveler locations within radius (app still applies privacy coarsening
-- to the returned ids — this only replaces the bbox scan). Uses the GiST index.
CREATE OR REPLACE FUNCTION user_locations_within_radius(
  p_lat double precision, p_lng double precision, p_radius_m double precision,
  p_since timestamptz DEFAULT now() - interval '60 minutes', p_limit int DEFAULT 250
) RETURNS TABLE(user_id uuid, distance_m double precision)
LANGUAGE sql STABLE AS $$
  WITH q AS (SELECT ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography AS g)
  SELECT u.user_id, ST_Distance(u.geog, q.g) AS distance_m
  FROM user_location_state u, q
  WHERE u.geog IS NOT NULL AND u.last_known_at >= p_since
    AND ST_DWithin(u.geog, q.g, p_radius_m)
  ORDER BY u.geog <-> q.g
  LIMIT p_limit;
$$;

ANALYZE user_location_state;
ANALYZE hidden_gems;
ANALYZE places;
ANALYZE events;
ANALYZE posts;
ANALYZE fsq_places;
