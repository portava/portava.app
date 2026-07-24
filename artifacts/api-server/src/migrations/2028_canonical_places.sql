-- Migration 2028: canonical external-place layer (media audit Phase 6)
--
-- One canonical `places` row per real-world venue; `external_place_references`
-- links each provider record (FSQ/OSM/Google/user) to it; `place_merge_log`
-- audits admin merge/unmerge. Flag `external_places_enabled` (OFF) gates the
-- resolver + routes. Additive + idempotent; NO existing table altered.
--
-- PREFIX NOTE: numbered 0192 against this snapshot; the live chain also carries
-- agent-authored migrations. Run checkMigrationPrefixes after applying and, on
-- collision, rename to the next free prefix (contents are prefix-independent) —
-- the APPLY doc has a one-liner.

CREATE TABLE IF NOT EXISTS places (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 TEXT NOT NULL,
  normalized_name      TEXT NOT NULL,
  primary_category     TEXT NOT NULL DEFAULT 'other',
  latitude             DOUBLE PRECISION,
  longitude            DOUBLE PRECISION,
  address              TEXT,
  city                 TEXT,
  neighborhood         TEXT,
  country_code         TEXT,
  -- Geo link into the existing location registry (city/neighborhood).
  canonical_location_id UUID REFERENCES canonical_locations(id) ON DELETE SET NULL,
  status               TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','closed','temporarily_closed','moved','duplicate','unverified')),
  -- Set when this row was merged into another (its refs repoint; kept for unmerge).
  merged_into_place_id UUID REFERENCES places(id) ON DELETE SET NULL,
  -- Per-field last-verified timestamps (spec §32 freshness).
  field_freshness      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS places_geo_idx
  ON places (latitude, longitude) WHERE latitude IS NOT NULL AND longitude IS NOT NULL;
CREATE INDEX IF NOT EXISTS places_norm_idx        ON places (normalized_name);
CREATE INDEX IF NOT EXISTS places_country_idx     ON places (country_code);
CREATE INDEX IF NOT EXISTS places_canonical_loc_idx ON places (canonical_location_id);
CREATE INDEX IF NOT EXISTS places_active_idx      ON places (id) WHERE merged_into_place_id IS NULL;

CREATE TABLE IF NOT EXISTS external_place_references (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  place_id          UUID NOT NULL REFERENCES places(id) ON DELETE CASCADE,
  provider          TEXT NOT NULL,
  provider_place_id TEXT NOT NULL,
  provider_url      TEXT,
  raw_category      TEXT,
  attribution       TEXT,
  license_metadata  JSONB NOT NULL DEFAULT '{}'::jsonb,
  confidence        TEXT NOT NULL DEFAULT 'provider',
  last_fetched_at   TIMESTAMPTZ,
  last_verified_at  TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_place_id)
);

CREATE INDEX IF NOT EXISTS epr_place_idx ON external_place_references (place_id);

CREATE TABLE IF NOT EXISTS place_merge_log (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action            TEXT NOT NULL CHECK (action IN ('merge','unmerge')),
  survivor_place_id UUID NOT NULL,
  affected_place_id UUID NOT NULL,
  admin_id          UUID,
  ref_count         INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS place_merge_log_survivor_idx ON place_merge_log (survivor_place_id);

-- Public reference data: anyone reads; service role writes (no write policies).
ALTER TABLE places                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_place_references  ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY places_read ON places FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY epr_read ON external_place_references FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

INSERT INTO feature_flags (flag, enabled, description) VALUES
  ('external_places_enabled', FALSE,
   'Canonical external-place layer: resolve FSQ/OSM/Google/user records to one places row with dedup + provider references')
ON CONFLICT (flag) DO NOTHING;
