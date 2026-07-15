-- Migration: 0034_geo_zones.sql
-- Creates geo_zones table for geographic fencing zones.

CREATE TYPE IF NOT EXISTS geo_zone_type AS ENUM (
  'circle', 'polygon', 'city', 'neighborhood', 'venue'
);

CREATE TABLE IF NOT EXISTS geo_zones (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  zone_type        geo_zone_type NOT NULL,
  center_lat       double precision,
  center_lng       double precision,
  radius_meters    double precision,
  polygon_geojson  jsonb,
  country_code     text,
  city             text,
  created_by       uuid REFERENCES profiles(id) ON DELETE SET NULL,
  is_system        boolean NOT NULL DEFAULT false,
  metadata         jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE geo_zones ENABLE ROW LEVEL SECURITY;

CREATE POLICY "geo_zones_public_read"   ON geo_zones FOR SELECT USING (true);
CREATE POLICY "geo_zones_auth_insert"   ON geo_zones FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "geo_zones_owner_update"  ON geo_zones FOR UPDATE USING (auth.uid() = created_by OR is_system);
