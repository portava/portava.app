-- Migration 0034: geo_zones + place_profiles
-- Admin-defined spatial zones and enriched venue profiles
-- Safe to re-run: IF NOT EXISTS throughout

-- Admin-defined city/neighborhood polygons and bounding areas
CREATE TABLE IF NOT EXISTS geo_zones (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- city | neighborhood | district | venue_area | safety_zone
  zone_type       TEXT        NOT NULL DEFAULT 'neighborhood',
  name            TEXT        NOT NULL,
  city            TEXT,
  country_code    TEXT,
  -- bounding box (polygon stored as JSONB for portability; no PostGIS required)
  bounds_json     JSONB,
  center_lat      DOUBLE PRECISION,
  center_lng      DOUBLE PRECISION,
  radius_meters   DOUBLE PRECISION,
  -- safety and feature metadata
  safety_rating   TEXT,   -- safe | moderate | caution | avoid
  featured        BOOLEAN     NOT NULL DEFAULT FALSE,
  verified        BOOLEAN     NOT NULL DEFAULT FALSE,
  created_by      UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS gz_zone_type_idx  ON geo_zones (zone_type);
CREATE INDEX IF NOT EXISTS gz_city_idx       ON geo_zones (city);
CREATE INDEX IF NOT EXISTS gz_featured_idx   ON geo_zones (featured) WHERE featured = TRUE;

ALTER TABLE geo_zones ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  -- Everyone can read; only admin writes (handled by service role in routes)
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='geo_zones' AND policyname='gz_select_all') THEN
    CREATE POLICY gz_select_all ON geo_zones FOR SELECT USING (TRUE);
  END IF;
END $$;

-- Enriched venue profiles (sourced from OSM + community + admin verification)
CREATE TABLE IF NOT EXISTS place_profiles (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  osm_id          TEXT        UNIQUE,
  name            TEXT        NOT NULL,
  -- restaurant | cafe | attraction | hotel | nightlife | activity | transport | other
  place_type      TEXT        NOT NULL DEFAULT 'other',
  category        TEXT,
  city            TEXT,
  district        TEXT,
  country_code    TEXT,
  lat             DOUBLE PRECISION,
  lng             DOUBLE PRECISION,
  address         TEXT,
  website         TEXT,
  phone           TEXT,
  -- none | verified | featured | warn | blocked
  status          TEXT        NOT NULL DEFAULT 'none',
  safety_note     TEXT,
  verified_at     TIMESTAMPTZ,
  verified_by     UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  metadata        JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pp_city_idx        ON place_profiles (city);
CREATE INDEX IF NOT EXISTS pp_place_type_idx  ON place_profiles (place_type);
CREATE INDEX IF NOT EXISTS pp_status_idx      ON place_profiles (status);

ALTER TABLE place_profiles ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='place_profiles' AND policyname='pp_select_all') THEN
    CREATE POLICY pp_select_all ON place_profiles FOR SELECT USING (TRUE);
  END IF;
END $$;
