-- 0138_city_country_geocode_cache.sql
-- Persist positive city→country forward-geocode results so server restarts
-- don't re-hit Nominatim (rate-limited 1 req/sec) for cities already resolved.
-- Only POSITIVE results are stored; negative/failed geocodes stay in the
-- short-TTL in-memory cache so transient failures retry.

CREATE TABLE IF NOT EXISTS city_country_geocode_cache (
  city_key     TEXT PRIMARY KEY,           -- normalised city name (lowercase, de-accented)
  country      TEXT NOT NULL,              -- canonical English country name
  country_code TEXT NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  resolved_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE city_country_geocode_cache ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS city_country_geocode_cache_svc ON city_country_geocode_cache;
CREATE POLICY city_country_geocode_cache_svc ON city_country_geocode_cache
  FOR ALL TO service_role USING (true) WITH CHECK (true);
