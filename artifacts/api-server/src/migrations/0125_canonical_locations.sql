-- 0125_canonical_locations.sql
-- Universal location registry: one canonical row per real-world location.
-- Every location selection in the app resolves to a row here so that
-- provider variants ("Cebu" from GPS, "Cebu City" from Nominatim, a
-- Foursquare venue id, a legacy string) all share one canonical location ID.
--
-- Entity tables are intentionally NOT altered: they keep their existing
-- string/place-id columns (current backend behavior preserved). The Place
-- JSON snapshots they store now carry `canonicalId` pointing at this table.

CREATE TABLE IF NOT EXISTS canonical_locations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- PlaceType: country | region | city | town | district | neighborhood | place | landmark | airport
  kind            text NOT NULL,
  name            text NOT NULL,
  -- lowercase, diacritics-stripped, punctuation-free, generic suffixes removed ("cebu city" -> "cebu")
  normalized_name text NOT NULL,
  display_name    text NOT NULL,
  city            text,
  region          text,
  country         text,
  country_code    text,          -- ISO 3166-1 alpha-2, uppercase
  postal_code     text,
  lat             double precision,
  lng             double precision,
  -- Map of provider -> provider place id, e.g. {"nominatim":"12345","foursquare":"4bf58..."}
  provider_ids    jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Normalized variant names seen for this location ("cebu", "cebu city", "sugbo")
  aliases         text[] NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS canonical_locations_norm_idx
  ON canonical_locations (normalized_name);
CREATE INDEX IF NOT EXISTS canonical_locations_country_idx
  ON canonical_locations (country_code);
CREATE INDEX IF NOT EXISTS canonical_locations_provider_ids_idx
  ON canonical_locations USING gin (provider_ids);
CREATE INDEX IF NOT EXISTS canonical_locations_aliases_idx
  ON canonical_locations USING gin (aliases);

ALTER TABLE canonical_locations ENABLE ROW LEVEL SECURITY;

-- Public reference data: anyone may read; only the service role writes
-- (no INSERT/UPDATE/DELETE policies -> denied for anon/authenticated).
DROP POLICY IF EXISTS canonical_locations_read ON canonical_locations;
CREATE POLICY canonical_locations_read ON canonical_locations
  FOR SELECT USING (true);
