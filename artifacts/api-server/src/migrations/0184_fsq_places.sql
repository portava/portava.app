-- Migration 0184: FSQ Places (Foursquare OS Places, per-city ingested)
--
-- A provider-sourced POI layer that complements the existing OSM/Overpass data
-- (neighborhood match) and user-submitted discovery_places: hotels/lodging
-- (which OSM covers poorly and no free booking API gives us) plus richer
-- nightlife/food/retail coverage and chains.
--
-- Populated per-city (NOT whole-world) by scripts/load-fsq-city.mjs, which uses
-- DuckDB to extract only a city's bounding box from the FSQ parquet. Every row
-- is source='fsq_os_places', confidence='provider', with the dataset date.
-- FSQ OS Places requires attribution ("Powered by Foursquare") on surfaces that
-- display it — the read layer carries the attribution string.
--
-- Flag-gated (fsq_places_enabled, default FALSE). Safe to re-run.

CREATE TABLE IF NOT EXISTS fsq_places (
  fsq_id              TEXT        PRIMARY KEY,
  name                TEXT        NOT NULL,
  latitude            DOUBLE PRECISION NOT NULL,
  longitude           DOUBLE PRECISION NOT NULL,
  category            TEXT        NOT NULL DEFAULT 'other'
                        CHECK (category IN ('accommodation','nightlife','food','culture','shopping','other')),
  fsq_primary_label   TEXT,
  fsq_category_ids    TEXT[]      NOT NULL DEFAULT '{}',
  fsq_category_labels TEXT[]      NOT NULL DEFAULT '{}',
  address             TEXT,
  locality            TEXT,
  region              TEXT,
  postcode            TEXT,
  country             TEXT,
  city_key            TEXT        NOT NULL,     -- ingestion city slug (e.g. 'cebu-ph')
  source              TEXT        NOT NULL DEFAULT 'fsq_os_places',
  confidence          TEXT        NOT NULL DEFAULT 'provider',
  dataset_date        DATE        NOT NULL,
  ingested_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fsq_places_city_cat_idx ON fsq_places (city_key, category);
CREATE INDEX IF NOT EXISTS fsq_places_city_idx     ON fsq_places (city_key);
CREATE INDEX IF NOT EXISTS fsq_places_geo_idx      ON fsq_places (latitude, longitude);

ALTER TABLE fsq_places ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'fsq_places' AND policyname = 'fsq_read') THEN
    CREATE POLICY fsq_read ON fsq_places FOR SELECT USING (auth.role() IN ('authenticated','service_role'));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'fsq_places' AND policyname = 'fsq_svc') THEN
    CREATE POLICY fsq_svc ON fsq_places FOR ALL USING (auth.role() = 'service_role');
  END IF;
END $$;

-- Track which cities have been ingested, and when (observability + freshness).
CREATE TABLE IF NOT EXISTS fsq_city_ingests (
  city_key      TEXT        PRIMARY KEY,
  place_count   INTEGER     NOT NULL DEFAULT 0,
  dataset_date  DATE        NOT NULL,
  bbox          JSONB,                          -- {minLat,minLng,maxLat,maxLng}
  ingested_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE fsq_city_ingests ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'fsq_city_ingests' AND policyname = 'fsqci_read') THEN
    CREATE POLICY fsqci_read ON fsq_city_ingests FOR SELECT USING (auth.role() IN ('authenticated','service_role'));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'fsq_city_ingests' AND policyname = 'fsqci_svc') THEN
    CREATE POLICY fsqci_svc ON fsq_city_ingests FOR ALL USING (auth.role() = 'service_role');
  END IF;
END $$;

INSERT INTO feature_flags (flag, enabled, description) VALUES
  ('fsq_places_enabled', FALSE,
   'FSQ OS Places: provider POI layer (hotels + richer nightlife/food/retail), per-city ingested; requires Foursquare attribution')
ON CONFLICT (flag) DO NOTHING;
