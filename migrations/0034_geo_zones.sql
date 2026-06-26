-- Migration 0034: geo_zones
-- Named geographic zones used by geofencing and location intelligence.

CREATE TABLE IF NOT EXISTS geo_zones (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text        NOT NULL,
  zone_type       text        NOT NULL
                  CHECK (zone_type IN ('city', 'neighborhood', 'venue', 'custom', 'airport', 'hotel')),
  center_lat      double precision,
  center_lng      double precision,
  radius_meters   integer,
  polygon_geojson jsonb,
  country_code    text,
  city            text,
  created_by      uuid        REFERENCES profiles(id) ON DELETE SET NULL,
  is_system       boolean     NOT NULL DEFAULT false,
  metadata        jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE geo_zones ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS geo_zones_city_idx      ON geo_zones(city);
CREATE INDEX IF NOT EXISTS geo_zones_zone_type_idx ON geo_zones(zone_type);

CREATE POLICY "geo_zones_public_read" ON geo_zones
  FOR SELECT USING (true);

CREATE POLICY "geo_zones_auth_create" ON geo_zones
  FOR INSERT WITH CHECK (auth.uid() = created_by);

CREATE POLICY "geo_zones_service_all" ON geo_zones
  FOR ALL TO service_role USING (true);
