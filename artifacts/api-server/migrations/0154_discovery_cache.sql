-- 0154_discovery_cache.sql
-- Persistent cache tables for Discovery OSM results and geocode lookups.
--
-- Problem: the in-memory Maps (cache, _geocodeMemory) are wiped on every deploy
-- or autoscale cold start, forcing every new instance to block on Nominatim +
-- Overpass before it can serve the first request.  Moving them to Postgres gives
-- every new instance an instant warm start via stale-while-revalidate.
--
-- Privacy: these tables contain only public OSM venue data and city-level
-- geocode results — no user data, no GPS coordinates.

CREATE TABLE IF NOT EXISTS discovery_cache (
  cache_key       text             PRIMARY KEY,
  destination     text             NOT NULL,
  category        text             NOT NULL,
  radius_km       integer          NOT NULL,
  places          jsonb            NOT NULL DEFAULT '[]',
  geocode_lat     double precision,
  geocode_lng     double precision,
  geocode_display text,
  cached_at       timestamptz      NOT NULL DEFAULT now(),
  expires_at      timestamptz      NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_discovery_cache_expires_at
  ON discovery_cache (expires_at);

CREATE INDEX IF NOT EXISTS idx_discovery_cache_dest_cat
  ON discovery_cache (destination, category);

COMMENT ON TABLE discovery_cache IS
  'Persistent L2 cache for OSM place results from GET /api/discovery. '
  'Entries survive server restarts; stale-while-revalidate pattern keeps latency low.';

-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS discovery_geocode_cache (
  location_key text             PRIMARY KEY,
  lat          double precision NOT NULL,
  lng          double precision NOT NULL,
  display_name text             NOT NULL,
  cached_at    timestamptz      NOT NULL DEFAULT now(),
  expires_at   timestamptz      NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_discovery_geocode_cache_expires_at
  ON discovery_geocode_cache (expires_at);

COMMENT ON TABLE discovery_geocode_cache IS
  'Persistent L2 cache for Nominatim geocode results. '
  'City-level coordinates only — no user location data.';

-- RLS: no user data in these tables; the service-role key used by the API
-- server can read/write via the default postgres policies.
-- Enable RLS so they appear in the schema health checks without leaking anything:
ALTER TABLE discovery_cache        ENABLE ROW LEVEL SECURITY;
ALTER TABLE discovery_geocode_cache ENABLE ROW LEVEL SECURITY;

-- Service-role bypass (equivalent to existing patterns in other cache tables):
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'discovery_cache' AND policyname = 'service_role_full_access'
  ) THEN
    CREATE POLICY service_role_full_access ON discovery_cache
      FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'discovery_geocode_cache' AND policyname = 'service_role_full_access'
  ) THEN
    CREATE POLICY service_role_full_access ON discovery_geocode_cache
      FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;
